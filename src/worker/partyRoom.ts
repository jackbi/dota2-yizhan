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
};

type Attachment = { clientId: string | null };

/** 空房间保留多久：房主刷新、临时断网回来还得是同一个房间。 */
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** 单个连接 10 秒内的消息上限，超了就断开——公开的 WebSocket 端点要有最基础的闸门。 */
const MESSAGE_BURST = 60;
const MESSAGE_WINDOW_MS = 10_000;

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
	private readonly bursts = new Map<string, { at: number; count: number }>();

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
		this.code = L.normalizeCode(new URL(request.url).pathname.split('/').pop() ?? '');
		if (!L.isValidCode(this.code)) return new Response('房间码不对', { status: 400 });

		const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ clientId: null } satisfies Attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const clientId = (ws.deserializeAttachment() as Attachment | null)?.clientId ?? '';
		if (!this.allow(ws, clientId)) return;
		const message = typeof raw === 'string' ? decodeClientMessage(raw) : null;
		if (!message) {
			this.send(ws, { t: 'error', code: 'bad-message' });
			return;
		}
		if (message.t === 'ping') {
			this.send(ws, { t: 'pong' });
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

	/** 空房间到期：删掉自己，并让大厅把卡片摘了。 */
	async alarm(): Promise<void> {
		if (this.stored && this.stored.state.members.length === 0) {
			const code = this.stored.code;
			this.stored = null;
			await this.ctx.storage.deleteAll();
			await this.tellLobby(code, 0);
		}
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
		if (!roster) this.push(this.sys(`${name} 加入了房间`));

		ws.serializeAttachment({ clientId: message.clientId } satisfies Attachment);
		await this.ctx.storage.deleteAlarm();
		// 房间空了以后别人进来：房主不在名册里，得有人接手（否则谁都不能分队）。
		this.ensureHost();
		await this.persist();

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

		this.apply(L.removeMember(this.stored.state, clientId), `${member.name} 离开了房间`);
		this.ensureHost();
		await this.persist();
		this.broadcast();
		const empty = this.stored.state.members.length === 0;
		if (empty) await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
		await this.tellLobby(this.stored.code, this.stored.state.members.length);
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

	/** 最基础的限速：超过就直接关连接。返回 false 表示这条消息不该再处理。 */
	private allow(ws: WebSocket, clientId: string): boolean {
		const key = clientId || 'anon';
		const now = Date.now();
		const burst = this.bursts.get(key);
		if (!burst || now - burst.at > MESSAGE_WINDOW_MS) {
			this.bursts.set(key, { at: now, count: 1 });
			return true;
		}
		burst.count += 1;
		if (burst.count > MESSAGE_BURST) {
			try {
				ws.close(4001, '消息太频繁');
			} catch {
				// 关不掉就算了，反正不会再处理它的消息。
			}
			return false;
		}
		return true;
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

	private async tellLobby(code: string, count: number): Promise<void> {
		if (!this.stored) return;
		try {
			const lobby = this.env.PARTY_LOBBY.get(this.env.PARTY_LOBBY.idFromName('lobby'));
			await lobby.fetch('https://party.internal/rooms', {
				method: 'POST',
				body: JSON.stringify({ code, name: count > 0 ? this.stored.name : '', count }),
			});
		} catch {
			// 大厅没更新成功不影响房间本身；下一次有人进出会再报一次。
		}
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

	constructor(private readonly ctx: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
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
