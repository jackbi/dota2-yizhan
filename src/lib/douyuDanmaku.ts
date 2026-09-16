/**
 * 斗鱼弹幕：浏览器直连 `wss://danmuproxy.douyu.com`，自己解 STT 文本协议。
 *
 * 为什么要有这个文件：分屏格子里播的是**直链**（见 `liveWall.ts` 的 `playDouyu`），格子里只有
 * 一个 `<video>`，平台页面上那层弹幕自然就没了。要把它加回来，就得自己当一次「斗鱼 web 客户端」。
 * 下面的形状全是**从斗鱼页面自己发的包上抄的**（`WebSocket.prototype.send` 上挂一层把帧录下来），
 * 不是照着别人的文章猜的：
 *
 * - **端点**：`wss://danmuproxy.douyu.com:8501`~`8506`。页面同时开好几条，实测 8501 / 8503 / 8506
 *   都在用。**不校验 `Origin`**：拿本站在用的域当 Origin 连过去照样收 `loginres`，所以不需要给弹幕
 *   架一条服务端转发——那会让「观众数」变成「服务器上的长连接数」，和视频不过服务器是同一个道理。
 * - **包**：12 字节头 + STT 正文 + `\0`。头是三段 32 位小端，**前两段是同一个长度**
 *   （= 12 + 正文长度 + 1），第三段是类型：客户端 689、服务端 690。
 * - **正文**：`type@=chatmsg/rid@=9999/nn@=昵称/txt@=内容/`，`@S` 是 `/`、`@A` 是 `@`。
 * - **握手**：`loginreq`（带 uid）→ 收到 `loginres` → `joingroup/rid@={房间号}/gid@=1`。
 *   之后每 40 秒一条 `mrkl` 心跳；服务器发 `pingreq` 时也回一条，不回就会被踢。
 *
 * 实测还有个脾气：**不是每次连接都会被伺候**。同一套包，有时秒回 `loginres`，有时一条不回也不报错
 * （同一出口连着开几条就容易碰上）。所以客户端在 8501~8506 之间轮着试——节奏见 `retryDelay()`，
 * 连不上会一路退到分钟级、带抖动，免得几个格子一起把观众自己的 IP 打成风控对象——收到 `loginres`
 * 之前不当它连上了。
 *
 * 自检见 `scripts/danmaku.check.ts`（拿抓下来的真实包跑编解码）。
 */

/** 客户端 → 服务器。服务器 → 客户端是 690，代码里用不到（切包不看它）。 */
const CLIENT_PACKET_TYPE = 689;

/** 斗鱼弹幕服务器的端口。轮着试，见文件头的「不是每次都会被伺候」。 */
export const DANMAKU_PORTS = [8501, 8502, 8503, 8504, 8505, 8506] as const;

/** 拆出来的一个斗鱼包：`type` 是 `chatmsg` / `loginres` / `mrkl` 这些，字段都还原过转义。 */
export interface DanmakuPacket {
	type: string;
	fields: Record<string, string>;
}

/**
 * 还原 STT 转义：`@S` 是 `/`、`@A` 是 `@`。
 *
 * 只能顺序扫，不能用两次 `replace`：`replace(/@S/g, '/')` 之后再 `replace(/@A/g, '@')` 是对的，
 * 反过来就把「本来就写成 `@S` 的四个字符」还原成 `/` 了——原文里想发一个 `/` 的人，正文里存的正是
 * `@S`，先换 `@A` 就会把它拆掉。
 */
function unescapeSTT(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '@' && i + 1 < value.length) {
			const next = value[i + 1];
			if (next === 'S') {
				out += '/';
				i += 1;
				continue;
			}
			if (next === 'A') {
				out += '@';
				i += 1;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

/**
 * 打包一个客户端包（12 字节头 + STT 正文 + `\0`）。
 *
 * 长度字段写的是**整个包的长度**（含这 12 字节头和结尾的 `\0`），实测服务器认这一种。
 */
export function encodeDouyuPacket(text: string): Uint8Array {
	const body = new TextEncoder().encode(`${text}\0`);
	const total = 12 + body.length;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setInt32(0, total, true);
	view.setInt32(4, total, true);
	view.setInt32(8, CLIENT_PACKET_TYPE, true);
	out.set(body, 12);
	return out;
}

/**
 * 把一帧（里面可能串了好几条包）拆成一个个包。
 *
 * **按 `type@=` 切，不按长度切**：STT 会把正文里的 `@` 转义成 `@A`，所以正文里不可能出现第二个
 * `type@=`，切点唯一；而长度切法要自己维护「半包」状态，还得处理一帧多条（实测 `mrkl`、`oul`、
 * `chatmsg` 会挤在同一帧里）。字节偏移和长度一概不碰——`oul`（在线列表）那种十几 KB 的包也一样过。
 *
 * 只解**一层**转义：`oul` 的 `ul` 字段里面还套着一层（外层转义把内层的 `@A` 又变成了 `@AA`），
 * 要用里面那几个字段得再解一次；格子里只画 `chatmsg`，不花这一遍。
 */
export function decodeDouyuPackets(bytes: Uint8Array): DanmakuPacket[] {
	// 12 字节头是二进制，用 `\0` 抹掉再切：切点只看 `type@=`，前面那点噪声自己会掉。
	const text = new TextDecoder().decode(bytes).replace(/\0/g, '');
	const out: DanmakuPacket[] = [];
	for (const chunk of text.split('type@=')) {
		const slash = chunk.indexOf('/');
		// `/` 在 `type@=` 前面出现的（帧头噪声）和空的都跳过；`type@=xxx` 没跟 `/` 的也当噪声。
		if (slash <= 0) continue;
		const fields: Record<string, string> = {};
		for (const segment of chunk.slice(slash + 1).split('/')) {
			const eq = segment.indexOf('@=');
			if (eq > 0) fields[segment.slice(0, eq)] = unescapeSTT(segment.slice(eq + 2));
		}
		out.push({ type: chunk.slice(0, slash), fields });
	}
	return out;
}

export type DanmakuStatus = 'connecting' | 'live' | 'paused' | 'closed';

export interface DanmakuClientOptions {
	/** 斗鱼的房间号（`betard` 里的 `room.room_id`，和地址栏里的号通常一致）。 */
	roomId: string;
	/** 每个解析出来的包都会走这里，过滤（比如只要 `chatmsg`）交给调用方。 */
	onPacket: (packet: DanmakuPacket) => void;
	/** 连接状态变化：`live` 表示已经收到 `loginres`、开始收弹幕了。 */
	onStatus?: (status: DanmakuStatus) => void;
}

export interface DanmakuClient {
	close(): void;
}

/**
 * 等 `loginres` 的上限：超了就换下一个端口重来。
 *
 * 实测服务器答的时候是**秒回**（几百毫秒），等太久没有意义——那条连接多半就是被无视了。
 */
const LOGIN_TIMEOUT_MS = 6_000;
/** 第一圈（把 6 个端口挨个试一遍）用的间隔。 */
const RETRY_SWEEP_MS = 1500;
/** 第二圈的间隔。 */
const RETRY_SECOND_MS = 10_000;
/** 之后一直用的间隔。不彻底放弃——斗鱼那边抽完风还会再伺候。 */
const RETRY_SLOW_MS = 120_000;

/**
 * 重试节奏（毫秒）。分三档，**不是**一路指数退避：
 *
 * 1. 第一圈：1.5 秒 + 抖动。服务器答的时候是秒回，所以先快点把端口试一遍。
 * 2. 第二圈：10 秒。还没通，就不是「这个端口挑食」了。
 * 3. 之后：2 分钟 + 抖动。抖动的用意是**别让 9 个格子的连接在同一秒一起重连**——一直连不上时，
 *    从外面看那正是风控对象的样子（实测：同一出口短时间内开十几次之后，斗鱼开始静默无视新连接，
 *    连 `www.douyu.com` 的 HTTPS 都被 reset 了一阵）。
 */
export function retryDelay(attempt: number): number {
	if (attempt <= DANMAKU_PORTS.length) return RETRY_SWEEP_MS + Math.random() * 500;
	if (attempt <= DANMAKU_PORTS.length * 2) return RETRY_SECOND_MS + Math.random() * 2000;
	return RETRY_SLOW_MS + Math.random() * 30_000;
}
/** 心跳间隔。斗鱼要求 45 秒内至少一条，40 秒留点余量。 */
const HEARTBEAT_MS = 40_000;

/** 访客 uid：斗鱼只拿它做标识，同一个浏览器固定一个，换来换去没必要。 */
function guestUid(): string {
	const KEY = 'dota2-live-wall/danmaku-uid';
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) return saved;
		const fresh = String(Math.floor(2e8 + Math.random() * 8e8));
		localStorage.setItem(KEY, fresh);
		return fresh;
	} catch {
		// 隐私模式下存不了：这次页面里固定一个就行。
		return String(Math.floor(2e8 + Math.random() * 8e8));
	}
}

/**
 * 连上斗鱼弹幕，直到 `close()`。
 *
 * 断线、被踢、端口不伺候，都会自己换下一个端口重连，调用方不用管。代价是「没连上」这件事
 * 只体现在 `onStatus` 上——弹幕本来就是个锦上添花的东西，拉倒不重试反而更符合预期。
 */
export function createDouyuDanmaku(options: DanmakuClientOptions): DanmakuClient {
	const uid = guestUid();
	/*
	 * 这条 login 是**实测通过的那一版**：斗鱼页面在 `danmuproxy` 上发的就是它，我们照这个也拿到过
	 * `loginres`。字段就这六个（`dfl` / `username` / `uid` / `ver` / `aver` / `ct`）。
	 *
	 * **别去抄 `wsproxy.douyu.com`（另一个端点）那版**：它多一份 `password` / `ltkid` / `biz` / `stk` /
	 * `devid` / `pt` / `cvr` / `apd` / `jwt`。混进来之后斗鱼会**静默无视**这条连接——握手 101、包也
	 * 收下，就是不回 `loginres`，于是格子里一条弹幕都没有、控制台干干净净，最难查的就是这种。
	 */
	const login = `type@=loginreq/roomid@=${options.roomId}/dfl@=/username@=visitor${uid.slice(-5)}/uid@=${uid}/ver@=20220825/aver@=218101901/ct@=0/`;
	const join = `type@=joingroup/rid@=${options.roomId}/gid@=1/`;
	let closed = false;
	let attempt = 0;
	let socket: WebSocket | null = null;
	let loginTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	const stopTimers = (): void => {
		clearTimeout(loginTimer);
		clearTimeout(retryTimer);
		clearInterval(heartbeatTimer);
	};

	const send = (text: string): void => {
		if (socket?.readyState === WebSocket.OPEN) socket.send(encodeDouyuPacket(text));
	};

	const retry = (): void => {
		// 隐藏期间不排重试：`onVisibilityChange` 回到前台会重新起一轮。
		if (closed || document.hidden) return;
		attempt += 1;
		retryTimer = setTimeout(connect, retryDelay(attempt));
	};

	const drop = (): void => {
		stopTimers();
		const old = socket;
		socket = null;
		if (old) {
			old.onopen = old.onmessage = old.onerror = old.onclose = null;
			try {
				old.close();
			} catch {
				// 已经断了的 socket，关不掉无所谓。
			}
		}
	};

	function connect(): void {
		if (closed || document.hidden) return;
		const port = DANMAKU_PORTS[attempt % DANMAKU_PORTS.length];
		options.onStatus?.('connecting');
		let ws: WebSocket;
		try {
			ws = new WebSocket(`wss://danmuproxy.douyu.com:${port}`);
		} catch {
			retry();
			return;
		}
		ws.binaryType = 'arraybuffer';
		socket = ws;
		loginTimer = setTimeout(() => {
			// 连上了、包也发了，就是不理你——换端口。
			drop();
			retry();
		}, LOGIN_TIMEOUT_MS);

		ws.onopen = () => {
			ws.send(encodeDouyuPacket(login));
		};
		ws.onmessage = (event) => {
			if (!(event.data instanceof ArrayBuffer)) return;
			for (const packet of decodeDouyuPackets(new Uint8Array(event.data))) {
				if (packet.type === 'loginres') {
					clearTimeout(loginTimer);
					attempt = 0;
					options.onStatus?.('live');
					send(join);
					send('type@=mrkl/');
					clearInterval(heartbeatTimer);
					heartbeatTimer = setInterval(() => send('type@=mrkl/'), HEARTBEAT_MS);
				} else if (packet.type === 'pingreq') {
					send('type@=mrkl/');
				}
				options.onPacket(packet);
			}
		};
		ws.onerror = () => {
			drop();
			retry();
		};
	ws.onclose = () => {
		if (socket !== ws) return;
		drop();
		retry();
	};
	}

	/**
	 * 页面被隐藏时**主动断开**，回到前台再连。
	 *
	 * 不是为了省资源，是为了不被踢：浏览器对隐藏标签的定时器有节流（Chrome 长时间隐藏后是
	 * 每分钟一次），心跳 40 秒会被拉到 60 秒以上，越过斗鱼那条 45 秒的线，于是连接被踢、
	 * 客户端按 `retryDelay()` 重连——9 格同开就是「隐藏期间每分钟 9 条新连接」，而实测这种
	 * 形态会被斗鱼静默无视（见文件头）。隐藏时干脆关掉、回来立刻重连，反而更少更干净。
	 */
	const onVisibilityChange = (): void => {
		if (closed) return;
		if (document.hidden) {
			drop();
			options.onStatus?.('paused');
			return;
		}
		// 回前台按「重新开始」处理：端口从第一个试起，失败计数清零。
		attempt = 0;
		connect();
	};
	document.addEventListener('visibilitychange', onVisibilityChange);

	// 一开始就是隐藏的（后台标签里打开）就别连，等可见时那条监听会接手。
	if (document.hidden) options.onStatus?.('paused');
	else connect();

	return {
		close(): void {
			closed = true;
			document.removeEventListener('visibilitychange', onVisibilityChange);
			drop();
			options.onStatus?.('closed');
		},
	};
}
