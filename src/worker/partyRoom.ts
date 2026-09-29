/**
 * 开黑房间的服务端：两个 Durable Object。
 *
 * - `PartyRoom`：一个房间一个实例（按房间码取名字），**它是权威**。谁在房里、队伍怎么分、
 *   roll 出几点、谁能改什么，全在这里算；浏览器只发操作、收快照。原来的「房主是权威 +
 *   别人发 cmd + 房主广播」那一整套（含房主刷新 peerId 会变、掉线宽限 20 秒）因此全删了。
 * - `PartyLobby`：一个全局实例，只记「有哪些房间、各多少人」。大厅列表从「P2P 全网状互播」
 *   变成一次查询；房间那边变化时通过内部 fetch 通知它。
 *
 * 两个都用 WebSocket Hibernation（`ctx.acceptWebSocket`）：没人说话时 DO 会被回收、不烧时长，
 * 所以房间状态必须落在 storage 里，构造后要重新读出来。
 *
 * 为什么不用 P2P 了：那套要靠 WebRTC 打洞，国内手机流量基本都是对称 NAT，得再架 TURN；
 * 而 TURN 又依赖云安全组放行 UDP。服务端房间把整条链路变成「一条 WebSocket」，跨网络不再
 * 是问题（见 docs/party.md）。
 */

import * as L from '../lib/partyLogic';
import {
	decodeClientMessage,
	encodeMessage,
	parseRoomPath,
	type ClientMessage,
	type LobbyRoom,
	type PartyErrorCode,
	type ServerMessage,
} from '../lib/partyProtocol';

interface Env {
	PARTY_LOBBY: DurableObjectNamespace<PartyLobby>;
}

/** 存在 storage 里的房间。聊天一起存：房间里的人刷新后要能看到刚才聊了什么。 */
type StoredRoom = {
	code: string;
	name: string;
	/** 房间密码的 SHA-256。没设密码就是空串的哈希。 */
	passwordHash: string;
	state: L.RoomState;
	chat: L.ChatMessage[];
	/**
	 * 已经断开、还在宽限期里的人：clientId → 断开的时刻。
	 *
	 * 挂在 `StoredRoom` 上而不是只放内存：宽限期内 DO 可能被回收，靠这行才认得出「他还没回来」。
	 * 这是服务端自己的记账，客户端看到的快照里没有它（名册上那个人还在，位置也没动）。
	 * 不变量：这里的每个 id 都还在 `state.members` 里。
	 */
	pending?: Record<string, number>;
	/**
	 * 名册变成空的时刻。空置保留期（`EMPTY_ROOM_TTL_MS`）从这一刻算起。
	 *
	 * 单独记一笔是因为「名册空了」和「空置到期」**不是同一件事**：宽限期到点那次唤醒会把断线的人
	 * 摘掉、名册随之变空，但房间的保留期这时才刚开始。只看"名册空不空"就会在那次唤醒上顺手删房间。
	 */
	emptySince?: number;
	/**
	 * 上次把房间状态报给大厅的时刻。
	 *
	 * 大厅那边按 `at` 兜底清理（6 小时没动过就当幽灵卡片），而 `at` 只在我们上报时更新。
	 * 上报原先只发生在"有人进出或操作"时，于是一屋子人安安静静打一下午、只有心跳在跑，
	 * 活房间会从大厅消失（只能靠手抄房间码加入）。这份时间戳让心跳也能刷新卡片。
	 * 落盘是因为 WebSocket Hibernation 会回收内存：不落盘的话每次唤醒都会重报一遍。
	 */
	lobbyReportedAt?: number;
};

/** 每条连接自己的东西。限流计数放这儿：它天然属于连接，DO 被回收再唤醒也还在。 */
type Attachment = { clientId: string | null; rateAt?: number; rateCount?: number };

/** 空房间保留多久：房主刷新、临时断网回来还得是同一个房间。 */
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/**
 * 断开之后宽限多久才真正把人从名册里摘掉。
 *
 * 刷新页面是「旧连接先断、新连接后到」，切网络（换 Wi-Fi、手机信号抖一下）也会先断后连。
 * 不留这点时间的话，名册、队伍位置、roll 结果会被当场清掉，房主刷新还会把房间交出去——
 * 而 `clientId` 那套重连本来就是为了避免这些。
 *
 * 45 秒是照客户端的退避阶梯定的（`RECONNECT_DELAYS_MS`：0.6 / 1.8 / 4.3 / 9.3 / 19.3 / 39.3 秒）：
 * 要盖住 39.3 秒那一次尝试，宽限就得比它长。原来写 20 秒时，手机息屏/地铁断网这类
 * 十几秒的空档会正好卡在第 5 与第 6 次尝试之间——人在宽限内被摘掉，回来就成了"重新加入"，
 * 队伍位置与 roll 结果正是这时候丢的。
 */
const MEMBER_GRACE_MS = 45_000;
/** 单个连接 10 秒内的消息上限，超了就断开——公开的 WebSocket 端点要有最基础的闸门。 */
const MESSAGE_BURST = 60;
const MESSAGE_WINDOW_MS = 10_000;
/** 「房间没了」那条上报的重试：删掉房间之后没有下一次上报机会了（见 `tellLobby`）。 */
const LOBBY_REPORT_ATTEMPTS = 3;
const LOBBY_REPORT_RETRY_MS = 250;
/** 大厅卡片的兜底寿命；只用来把"永久幽灵卡片"变成"有上限"（见 `PartyLobby.pruneStale`）。 */
const LOBBY_ROOM_TTL_MS = 6 * 3600_000;
/**
 * 有人在房里时，心跳最多多久顺手刷一次大厅卡片。
 *
 * 比上面的兜底寿命小得多，又不至于让每条心跳都写一次 storage：客户端每 20 秒 ping 一次，
 * 按这个间隔最多 15 分钟上报一次。
 */
const LOBBY_HEARTBEAT_MS = 15 * 60_000;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const httpsOnly = (url: string): string => (url.startsWith('https://') ? url.slice(0, 300) : '');

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function isWebSocket(request: Request): boolean {
	return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

// ---------------------------------------------------------------- 房间

export class PartyRoom {
	private stored: StoredRoom | null = null;
	/** 房间码。DO 不知道自己的名字，只能从进来的请求 URL 上取一次。 */
	private code = '';

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {
		ctx.blockConcurrencyWhile(async () => {
			this.stored = (await ctx.storage.get<StoredRoom>('room')) ?? null;
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (!isWebSocket(request)) return new Response('需要 WebSocket 升级', { status: 426 });
		/*
		 * 房间码必须与路由用**同一个函数**解析（`parseRoomPath`）。
		 *
		 * 这里原先取 `URL.pathname` 的最后一段再过 `normalizeCode()`，而那个函数是给"人手输入"
		 * 用的：它会过滤字母表外的字符、再截到 5 位。于是 `/api/party/room/%20ABCDE%20` 在路由侧
		 * 算出 `ABCDE`（因此路由到 DO ABCDE），DO 却把 `%20ABCDE%20` 过滤成 `2ABCD`（`%20` 里的
		 * **2 在字母表里**）——房间自称的码与它所在的 DO 不是同一个，无需鉴权就能覆盖、并在过期时
		 * 删掉真房间 `2ABCD` 在大厅的卡片。同一个函数、同一份判据，才谈得上"没有别名"。
		 */
		const code = parseRoomPath(new URL(request.url).pathname);
		if (!code) return new Response('房间码不对', { status: 400 });
		this.code = code;

		const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ clientId: null } satisfies Attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const attachment = (ws.deserializeAttachment() as Attachment | null) ?? null;
		const clientId = attachment?.clientId ?? '';
		if (!this.allow(ws, attachment)) return;
		const message = typeof raw === 'string' ? decodeClientMessage(raw) : null;
		if (!message) {
			this.send(ws, { t: 'error', code: 'bad-message' });
			return;
		}
		if (message.t === 'ping') {
			this.send(ws, { t: 'pong' });
			await this.refreshLobbyCard();
			return;
		}
		if (message.t === 'join') {
			await this.join(ws, message);
			return;
		}
		// 没进房的人不能操作；已经不在名册里的人（比如被新连接顶掉）同样拒绝。
		if (!clientId || !this.stored || !L.memberById(this.stored.state, clientId)) return;
		await this.command(clientId, message);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.leave(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.leave(ws);
	}

	/**
	 * 到点了：先看看宽限期里的人该不该摘，再决定房间本身要不要删。
	 *
	 * DO 同一时刻只有一个 alarm，所以「宽限到期」和「空房间到期」这两件事必须在同一个 handler
	 * 里处理，由 `scheduleAlarm()` 取最近的那个时间点。
	 *
	 * **两件事各有各的到期判据**：宽限到点那次唤醒会把断线的人摘掉、名册随之变空，但空置保留期
	 * 这时才刚开始（`emptySince`）。所以这里不能写成"名册空就删"，否则最后一个人断线 45 秒后
	 * 房间、聊天、roll、队伍位置就全没了，`EMPTY_ROOM_TTL_MS` 形同虚设。
	 */
	async alarm(): Promise<void> {
		if (!this.stored) return;
		await this.sweepPending();
		if (!this.stored) return;
		if (this.stored.state.members.length > 0) return;

		const emptySince = this.stored.emptySince ?? Date.now();
		this.stored.emptySince = emptySince;
		if (Date.now() - emptySince < EMPTY_ROOM_TTL_MS) return;

		// 空房间到期：连聊天一起删，并让大厅把卡片摘了。
		const code = this.stored.code;
		this.stored = null;
		await this.ctx.storage.deleteAll();
		await this.tellLobby(code, 0);
	}

	// ------------------------------------------------------------ 进房

	private async join(ws: WebSocket, message: Extract<ClientMessage, { t: 'join' }>): Promise<void> {
		const passwordHash = await sha256Hex(message.password);

		if (!this.stored) {
			if (!message.create) {
				this.fail(ws, 'room-not-found', '房间不存在了：房主可能已经关掉，或者房间码抄错了。');
				return;
			}
			const host: L.Member = {
				id: message.clientId,
				name: L.sanitizeName(message.name) || '房主',
				avatar: httpsOnly(message.avatar),
				joinedAt: Date.now(),
			};
			const state = L.createRoom({
				code: this.code,
				name: L.sanitizeName(message.create.name) || '开黑房间',
				host,
				teamSize: message.create.teamSize,
			});
			this.stored = {
				code: this.code,
				name: state.name,
				passwordHash,
				state,
				chat: [this.sys(`房间「${state.name}」已创建，房间码 ${state.code}`)],
			};
		} else if (this.stored.passwordHash !== passwordHash) {
			this.fail(ws, 'bad-password', '密码不对：这个房间的密码和房主设的不一样。');
			return;
		}

		// 同一个 clientId 的旧连接（刷新后残留的那条）先踢掉，免得名册里出现两份。
		for (const other of this.ctx.getWebSockets()) {
			if (other === ws) continue;
			if ((other.deserializeAttachment() as Attachment | null)?.clientId === message.clientId) {
				try {
					other.close(4000, '同一个标签页重连');
				} catch {
					// 已经断了的连接，关不掉无所谓。
				}
			}
		}

		const roster = L.memberById(this.stored.state, message.clientId);
		const name = L.sanitizeName(message.name) || roster?.name || '无名氏';
		const avatar = httpsOnly(message.avatar);
		const member: L.Member = { id: message.clientId, name, avatar, joinedAt: roster?.joinedAt ?? Date.now() };
		const before = this.stored.state;
		this.stored.state = L.upsertMember(before, member).state;
		// 有人进来就不再是空房：清掉空置起点，下一次变空时重新计时。
		this.stored.emptySince = undefined;
		if (!roster) this.push(this.sys(`${name} 加入了房间`));

		/*
		 * 回来的人从「待清理」里划掉：这就是宽限期的全部意义——同一个人（同一个 clientId）
		 * 在 45 秒内重新连上，名册、队伍位置、roll 结果都还在原地。
		 * 写 attachment 时把原有字段带上（限流计数在里面），别顺手抹掉。
		 */
		const attachment = (ws.deserializeAttachment() as Attachment | null) ?? { clientId: null };
		ws.serializeAttachment({ ...attachment, clientId: message.clientId } satisfies Attachment);
		if (this.stored.pending?.[message.clientId] !== undefined) {
			const pending = { ...this.stored.pending };
			delete pending[message.clientId];
			this.stored.pending = pending;
		}
		// 房间空了以后别人进来：房主不在名册里，得有人接手（否则谁都不能分队）。
		this.ensureHost();
		await this.persist();
		await this.scheduleAlarm();

		const { state, chat } = this.stored;
		this.send(ws, { t: 'joined', selfId: message.clientId, state, chat });
		this.broadcast();
		await this.tellLobby(this.stored.code, state.members.length);
	}

	// ------------------------------------------------------------ 操作

	private async command(clientId: string, message: ClientMessage): Promise<void> {
		if (!this.stored) return;
		const { state } = this.stored;
		const isHost = state.hostId === clientId;
		const member = L.memberById(state, clientId);
		if (!member) return;

		switch (message.t) {
			case 'chat': {
				// 名字用名册里的，不采信对方传的昵称：否则谁都能顶着别人的名字说话。
				const text = L.clampChatText(message.text);
				if (!text) return;
				this.push({ id: newId(), kind: 'say', peerId: clientId, name: member.name, text, at: Date.now() });
				break;
			}
			case 'roll': {
				const value = L.rollValue();
				this.apply(L.setRoll(state, clientId, value), `${member.name} 掷出了 ${value}`);
				break;
			}
			case 'move': {
				// 自己挪自己随时可以；挪别人只有房主行。
				if (message.memberId !== clientId && !isHost) return;
				this.apply(L.moveMember(state, message.memberId, message.teamId), null);
				break;
			}
			case 'team': {
				if (!isHost) return;
				const op = message.op;
				switch (op.kind) {
					case 'add':
						this.apply(L.addTeam(state), '新增了一个队伍');
						break;
					case 'remove':
						this.apply(L.removeTeam(state, op.teamId), null);
						break;
					case 'rename': {
						const team = state.teams.find((item) => item.id === op.teamId);
						if (!team) return;
						this.apply(L.renameTeam(state, op.teamId, op.name), null);
						break;
					}
					case 'size':
						this.apply(L.setTeamSize(state, op.size), `每队上限改成 ${L.clampTeamSize(op.size)} 人`);
						break;
					case 'autoForm':
						this.apply(L.autoFormTeams(state), '按人数重新分队');
						break;
					case 'randomize':
						this.apply(L.randomizeTeams(state), '随机重排了队伍');
						break;
					case 'byRoll':
						this.apply(L.formTeamsByRoll(state), '按 roll 蛇形分队');
						break;
					case 'clearRolls':
						this.apply(L.clearRolls(state), '重开了一轮 roll');
						break;
					case 'autoAssign':
						this.apply(L.setAutoAssign(state, op.on), null);
						break;
					default:
						return;
				}
				break;
			}
			default:
				return;
		}
		await this.persist();
		this.broadcast();
		await this.tellLobby(this.stored.code, this.stored.state.members.length);
	}

	private apply(next: L.RoomState, systemText?: string | null): void {
		if (!this.stored || next === this.stored.state) return;
		this.stored.state = next;
		if (systemText) this.push(this.sys(systemText));
	}

	// ------------------------------------------------------------ 离开

	private async leave(ws: WebSocket): Promise<void> {
		const clientId = (ws.deserializeAttachment() as Attachment | null)?.clientId ?? '';
		if (!clientId || !this.stored) return;
		const member = L.memberById(this.stored.state, clientId);
		if (!member) return;
		// 同一个 clientId 的新连接已经在房里时，旧连接断开不该把人从名册里删掉。
		const stillConnected = this.ctx
			.getWebSockets()
			.some((other) => other !== ws && (other.deserializeAttachment() as Attachment | null)?.clientId === clientId);
		if (stillConnected) return;

		/*
		 * **不立刻摘人**，先记一个待清理的时刻。
		 *
		 * 刷新页面、切网络都是「旧连接先断、新连接后到」：当场把人删掉的话，名册、队伍位置、
		 * roll 结果全没了，房主还会被 `ensureHost()` 换掉——`clientId` 那套重连就白做了。
		 * 宽限期里的人仍然算在房里（所以房主照旧），到点没回来才由 `sweepPending()` 摘掉。
		 */
		this.stored.pending = { ...(this.stored.pending ?? {}), [clientId]: Date.now() };
		await this.persist();
		await this.scheduleAlarm();
	}

	/** 宽限期到了还没回来的人，这时候才真的从名册里摘掉。 */
	private async sweepPending(): Promise<void> {
		if (!this.stored) return;
		const pending = this.stored.pending ?? {};
		const now = Date.now();
		const expired = Object.keys(pending).filter((id) => now - (pending[id] ?? 0) >= MEMBER_GRACE_MS);
		if (expired.length > 0) {
			const next = { ...pending };
			for (const id of expired) {
				const member = L.memberById(this.stored.state, id);
				delete next[id];
				if (member) this.apply(L.removeMember(this.stored.state, id), `${member.name} 离开了房间`);
			}
			this.stored.pending = next;
			// 名册刚好空掉：空置保留期从这一刻开始算，而不是从这次唤醒的 deadline 算。
			this.stored.emptySince = this.stored.state.members.length === 0 ? Date.now() : undefined;
			// 走的可能是房主：这时候才轮到换人。
			this.ensureHost();
			await this.persist();
			this.broadcast();
			await this.tellLobby(this.stored.code, this.stored.state.members.length);
		}
		await this.scheduleAlarm();
	}

	/**
	 * 排下一次唤醒：宽限到期与空房间到期取最近的那个（DO 只能挂一个 alarm）。
	 *
	 * 「待清理的人还在名册里」意味着这两件事在同一时刻不会都成立，但**先后一定成立**：
	 * 宽限到点摘完人，名册可能刚好变空，空置倒计时从那一刻才开始（`emptySince`）。
	 * 所以两个时间点都要按各自的口径算，别用"名册空不空"当共同判据。
	 */
	private async scheduleAlarm(): Promise<void> {
		if (!this.stored) return;
		const pendingAt = Object.values(this.stored.pending ?? {});
		const times: number[] = [];
		if (pendingAt.length > 0) times.push(Math.min(...pendingAt) + MEMBER_GRACE_MS);
		if (this.stored.state.members.length === 0) times.push((this.stored.emptySince ?? Date.now()) + EMPTY_ROOM_TTL_MS);
		if (times.length === 0) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.min(...times));
	}

	/** 房主不在名册里就换人：房间空了以后别人进来、或房主退出，都得有人能分队。 */
	private ensureHost(): void {
		if (!this.stored) return;
		const { state } = this.stored;
		if (state.members.length === 0) return;
		if (L.memberById(state, state.hostId)) return;
		const next = L.sortMembers(state.members)[0];
		this.stored.state = { ...state, hostId: next.id };
		this.push(this.sys(`房主换成了 ${next.name}`));
	}

	// ------------------------------------------------------------ 杂项

	/**
	 * 最基础的限速：单连接 10 秒内超过 60 条就直接关连接。返回 false 表示这条消息不该再处理。
	 *
	 * 计数**按连接**存在 attachment 里，不用 clientId 当键，两个理由：
	 *
	 * - clientId 是客户端自己填的，换一个就能重新拿满额度，限流形同虚设；
	 * - 还没 join 的连接没有 id，以前它们共用同一个 `'anon'` 桶——一个陌生 socket 连发 60 条
	 *   ping 就能把这个桶打满，接下来每个人 join 的第一条消息都会被判超限、直接断开，
	 *   房间等于对外不可加入。
	 *
	 * 放在 attachment 里还顺带两点：DO 被回收再唤醒时计数不会莫名清零；条目随连接一起消失，
	 * 不需要额外清理（以前那个 Map 只写不删，每个换过 id 的人都留下一条永久记录）。
	 */
	private allow(ws: WebSocket, attachment: Attachment | null): boolean {
		if (!attachment) return true;
		const now = Date.now();
		const fresh = !attachment.rateAt || now - attachment.rateAt > MESSAGE_WINDOW_MS;
		const count = fresh ? 1 : (attachment.rateCount ?? 0) + 1;
		ws.serializeAttachment({ ...attachment, rateAt: fresh ? now : attachment.rateAt, rateCount: count } satisfies Attachment);
		if (count <= MESSAGE_BURST) return true;
		try {
			ws.close(4001, '消息太频繁');
		} catch {
			// 关不掉就算了，反正不会再处理它的消息。
		}
		return false;
	}

	private persist(): Promise<void> {
		return this.stored ? this.ctx.storage.put('room', this.stored) : Promise.resolve();
	}

	private push(message: L.ChatMessage): void {
		if (this.stored) this.stored.chat = L.appendChat(this.stored.chat, message);
	}

	private sys(text: string): L.ChatMessage {
		return { id: newId(), kind: 'system', peerId: '', name: '', text, at: Date.now() };
	}

	private send(ws: WebSocket, message: ServerMessage): void {
		try {
			ws.send(encodeMessage(message));
		} catch {
			// 连接已经没了。
		}
	}

	private fail(ws: WebSocket, code: PartyErrorCode, message: string): void {
		this.send(ws, { t: 'error', code, message });
		try {
			ws.close(4002, code);
		} catch {
			// 同上。
		}
	}

	/** 把最新快照推给所有已进房的连接。 */
	private broadcast(): void {
		if (!this.stored) return;
		const message: ServerMessage = { t: 'state', state: this.stored.state, chat: this.stored.chat };
		const encoded = encodeMessage(message);
		for (const ws of this.ctx.getWebSockets()) {
			if (!(ws.deserializeAttachment() as Attachment | null)?.clientId) continue;
			try {
				ws.send(encoded);
			} catch {
				// 断了就断了吧，close 事件会把人从名册里摘掉。
			}
		}
	}

	/**
	 * 把房间的现状报给大厅。
	 *
	 * **不能因为 `this.stored` 已经是 null 就直接返回**：房间到期删除那一步就是先清掉 `stored`
	 * 再报「这里没人了」，那条早退会让删除后的大厅卡片永远留着。
	 *
	 * 「房间没了」这条上报会重试几次：count > 0 的报告失败了还有下一次有人进出兜底，
	 * 而房间删掉之后**没有下一次了**，那一次失败就等于留一张永久卡片。
	 */
	private async tellLobby(code: string, count: number): Promise<void> {
		const name = count > 0 ? (this.stored?.name ?? '') : '';
		const body = JSON.stringify({ code, name, count });
		const attempts = count > 0 ? 1 : LOBBY_REPORT_ATTEMPTS;
		const lobby = this.env.PARTY_LOBBY.get(this.env.PARTY_LOBBY.idFromName('lobby'));

		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				const response = await lobby.fetch('https://party.internal/rooms', { method: 'POST', body });
				if (response.ok) {
					// 记下这次上报的时刻（心跳靠它限速）。落盘：Hibernation 会把内存清掉。
					if (count > 0 && this.stored) {
						this.stored.lobbyReportedAt = Date.now();
						await this.persist();
					}
					return;
				}
				console.warn(`[party] 大厅上报被拒：${code} count=${count} HTTP ${response.status}`);
			} catch (error) {
				console.warn(`[party] 大厅上报失败：${code} count=${count} ${error instanceof Error ? error.message : error}`);
			}
			if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, LOBBY_REPORT_RETRY_MS));
		}
	}

	/**
	 * 心跳顺带刷一下大厅卡片（限速）。
	 *
	 * 见 `StoredRoom.lobbyReportedAt`：没有这一步，安静但有人的房间会在 6 小时后被大厅当成
	 * 幽灵卡片摘掉。
	 */
	private async refreshLobbyCard(): Promise<void> {
		if (!this.stored || this.stored.state.members.length === 0) return;
		if (Date.now() - (this.stored.lobbyReportedAt ?? 0) < LOBBY_HEARTBEAT_MS) return;
		await this.tellLobby(this.stored.code, this.stored.state.members.length);
	}
}

// ---------------------------------------------------------------- 大厅

/**
 * 大厅：只维护「有哪些房间、各多少人」，并把它推给所有挂着 `/api/party/rooms` 的页面。
 *
 * 房间通过内部 POST 上报（`PartyRoom.tellLobby`）。公开入口只转发 GET/WebSocket，
 * 所以外面的人没法伪造房间卡片。
 */
export class PartyLobby {
	private rooms = new Map<string, LobbyRoom>();

	constructor(private readonly ctx: DurableObjectState) {
		/*
		 * 大厅和房间一样用 Hibernation（见文件头），所以这份列表**必须从 storage 读回来**。
		 *
		 * 只放在内存里的话，DO 一被回收就等于「所有房间都没了」：下一次任何房间上报时，
		 * 订阅者收到的是一份只剩那一个房间的列表；而列表里的房间本身还在（房间 DO 自己落了盘），
		 * 于是大厅显示得比实际少，且没人能从界面上看出这是被回收过。
		 */
		ctx.blockConcurrencyWhile(async () => {
			const stored = (await ctx.storage.get<LobbyRoom[]>('rooms')) ?? [];
			// 显式标注参数：这个文件没有 Workers 的类型定义（`ctx` 是 any），不写的话
			// 回调参数会退化成隐式 any，白白多一条 tsc 报错。
			this.rooms = new Map(stored.map((room: LobbyRoom) => [room.code, room] as const));
		});
	}

	/**
	 * 改动后立刻落盘。
	 *
	 * 上报频率等于「有人进房 / 退房 / 房间消失」，本来就低；这里宁可多写一次，也不要让回收
	 * 把列表吃掉。写失败不抛给调用方——大厅没更新成功不该影响房间本身，下一次上报还会再来。
	 */
	private async persist(): Promise<void> {
		try {
			await this.ctx.storage.put('rooms', [...this.rooms.values()]);
		} catch {
			// 落盘失败只影响大厅列表的持久性，不影响本次广播。
		}
	}

	/**
	 * 兜底清理：久到不可能是活房间的卡片直接摘掉。
	 *
	 * 正常路径是房间自己在名册变空时上报 count 0（那条上报还会重试，见 `PartyRoom.tellLobby`），
	 * 但整条链路可能一次都没送达，而卡片是**落盘**的——不清理就会一直挂在那儿等人点进去看
	 * 「房间不存在了」。
	 *
	 * TTL 给得很宽（6 小时）：房间只在有人进出或操作时上报，安静打一下午的房间也完全正常，
	 * 短期内没有任何「他还活着吗」的信号可用。这条只是把"永远"变成"有上限"。
	 */
	private pruneStale(now = Date.now()): boolean {
		let changed = false;
		for (const [code, room] of this.rooms) {
			if (now - room.at > LOBBY_ROOM_TTL_MS) {
				this.rooms.delete(code);
				changed = true;
			}
		}
		return changed;
	}

	async fetch(request: Request): Promise<Response> {
		if (this.pruneStale()) await this.persist();
		if (isWebSocket(request)) {
			const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
			this.ctx.acceptWebSocket(server);
			server.send(encodeMessage({ t: 'rooms', rooms: [...this.rooms.values()] }));
			return new Response(null, { status: 101, webSocket: client });
		}

		if (request.method === 'POST') {
			let body: { code?: unknown; name?: unknown; count?: unknown };
			try {
				body = (await request.json()) as typeof body;
			} catch {
				return json({ ok: false }, 400);
			}
			const code = L.normalizeCode(typeof body.code === 'string' ? body.code : '');
			if (!L.isValidCode(code)) return json({ ok: false }, 400);
			const count = Math.max(0, Math.floor(Number(body.count) || 0));
			if (count === 0) this.rooms.delete(code);
			else {
				this.rooms.set(code, {
					code,
					name: L.sanitizeName(typeof body.name === 'string' ? body.name : '') || '开黑房间',
					count,
					at: Date.now(),
				});
			}
			await this.persist();
			this.broadcast();
			return json({ ok: true });
		}

		return json({ t: 'rooms', rooms: [...this.rooms.values()] });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		// 客户端只用来保持连接，不做别的事；收到什么就回一份当前列表。
		if (typeof raw === 'string' && raw.length > 1024) return;
		try {
			ws.send(encodeMessage({ t: 'rooms', rooms: [...this.rooms.values()] }));
		} catch {
			// 连接没了。
		}
	}

	private broadcast(): void {
		const encoded = encodeMessage({ t: 'rooms', rooms: [...this.rooms.values()] });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(encoded);
			} catch {
				// 同上。
			}
		}
	}
}
