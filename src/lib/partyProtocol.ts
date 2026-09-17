/**
 * 开黑房间的消息协议（纯逻辑，客户端与 Durable Object 共用，自检见
 * `scripts/partyProtocol.check.ts`）。
 *
 * 房间从「P2P + 房主权威」改成了「服务端权威」：浏览器只做两件事——把用户的操作发上去、
 * 把服务端推来的快照画出来。分队/roll/权限判断全在 Durable Object 里跑（用的还是
 * `partyLogic.ts`，所以那套规则的自检一条都不用改）。
 *
 * 这里不引任何 DOM / Workers API：客户端打包进浏览器、服务端在 workerd 里跑、检查脚本在裸
 * Node 下跑，三边都要能 import。
 */

import type { ChatMessage, RoomState } from './partyLogic';

/** 大厅里一张房间卡片的数据。 */
export type LobbyRoom = {
	code: string;
	name: string;
	/** 房里现在几个人。0 人的房间不会出现在列表里。 */
	count: number;
	/** 最后一次变动的时刻，用来看新鲜度。 */
	at: number;
};

/** 客户端 → 房间。 */
export type ClientMessage =
	| {
			t: 'join';
			/** 浏览器一侧的稳定标识（sessionStorage 里存着，刷新不变）。同一个 id 重连等于「同一个人回来了」。 */
			clientId: string;
			name: string;
			avatar: string;
			password: string;
			/** 只有建房时才带。房间已存在时带上会被忽略。 */
			create?: { name: string; teamSize?: number };
	  }
	| { t: 'chat'; text: string }
	| { t: 'roll' }
	| { t: 'move'; memberId: string; teamId: string | null }
	/** 房主工具，服务端会再校验一次权限。 */
	| { t: 'team'; op: TeamOp }
	| { t: 'ping' };

export type TeamOp =
	| { kind: 'add' }
	| { kind: 'remove'; teamId: string }
	| { kind: 'rename'; teamId: string; name: string }
	| { kind: 'size'; size: number }
	| { kind: 'autoForm' }
	| { kind: 'randomize' }
	| { kind: 'byRoll' }
	| { kind: 'clearRolls' }
	| { kind: 'autoAssign'; on: boolean };

export type PartyErrorCode = 'bad-password' | 'room-not-found' | 'room-full' | 'bad-message' | 'too-many-messages';

/** 房间 → 客户端。 */
export type ServerMessage =
	/** 进房成功。`state` + `chat` 是完整快照，客户端拿到就能直接渲染，不需要再要一次数据。 */
	| { t: 'joined'; selfId: string; state: RoomState; chat: ChatMessage[] }
	/** 任何一次状态变化后的全量快照。房间小（几十人、几十条聊天），推全量比维护增量的分支少。 */
	| { t: 'state'; state: RoomState; chat: ChatMessage[] }
	| { t: 'error'; code: PartyErrorCode; message?: string }
	| { t: 'pong' };

/** 大厅 → 客户端。大厅是一个独立的 Durable Object：它只知道「有哪些房间、各多少人」。 */
export type LobbyMessage = { t: 'rooms'; rooms: LobbyRoom[] };

export const encodeMessage = (message: ClientMessage | ServerMessage | LobbyMessage): string => JSON.stringify(message);

/**
 * 裁剪到上限，**按码点**而不是按 UTF-16 码元：`slice()` 会把 emoji 的代理对劈成两半，
 * 存进房间之后就是两个乱码方块（聊天里插表情之后这条路径变得常见了）。
 */
const asString = (value: unknown, max: number): string => {
	if (typeof value !== 'string') return '';
	if (value.length <= max) return value;
	// 代理对占两个码元，所以先多取一倍码元再按码点截，够用且不用扫全串。
	return [...value.slice(0, max * 2)].slice(0, max).join('');
};
const asId = (value: unknown): string => {
	const raw = asString(value, 64);
	return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : '';
};

/**
 * 解析客户端消息。**这里是信任边界**：类型只是本仓库的约定，真正的输入来自别人浏览器，
 * 所以每个字段都要过一遍，形状不对就返回 null（调用方直接丢弃，不猜）。
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const message = parsed as Record<string, unknown>;
	switch (message.t) {
		case 'ping':
			return { t: 'ping' };
		case 'chat': {
			const text = asString(message.text, 400);
			return text ? { t: 'chat', text } : null;
		}
		case 'roll':
			return { t: 'roll' };
		case 'move': {
			const memberId = asId(message.memberId);
			if (!memberId) return null;
			// `null` 表示放回空闲池，别的值一律当非法输入丢掉。
			const teamId = message.teamId === null ? null : asString(message.teamId, 32) || null;
			return { t: 'move', memberId, teamId };
		}
		case 'team': {
			const op = decodeTeamOp(message.op);
			return op ? { t: 'team', op } : null;
		}
		case 'join': {
			const clientId = asId(message.clientId);
			if (!clientId) return null;
			const create = message.create;
			let built: { name: string; teamSize?: number } | undefined;
			if (create && typeof create === 'object') {
				const raw = create as Record<string, unknown>;
				const name = asString(raw.name, 40);
				const size = Number(raw.teamSize);
				built = { name, teamSize: Number.isFinite(size) ? size : undefined };
			}
			return {
				t: 'join',
				clientId,
				name: asString(message.name, 40),
				avatar: asString(message.avatar, 300),
				password: asString(message.password, 64),
				create: built,
			};
		}
		default:
			return null;
	}
}

function decodeTeamOp(raw: unknown): TeamOp | null {
	if (!raw || typeof raw !== 'object') return null;
	const op = raw as Record<string, unknown>;
	switch (op.kind) {
		case 'add':
			return { kind: 'add' };
		case 'autoForm':
			return { kind: 'autoForm' };
		case 'randomize':
			return { kind: 'randomize' };
		case 'byRoll':
			return { kind: 'byRoll' };
		case 'clearRolls':
			return { kind: 'clearRolls' };
		case 'remove': {
			const teamId = asString(op.teamId, 32);
			return teamId ? { kind: 'remove', teamId } : null;
		}
		case 'rename': {
			const teamId = asString(op.teamId, 32);
			const name = asString(op.name, 24);
			return teamId && name ? { kind: 'rename', teamId, name } : null;
		}
		case 'size': {
			const size = Number(op.size);
			return Number.isFinite(size) ? { kind: 'size', size } : null;
		}
		case 'autoAssign':
			return { kind: 'autoAssign', on: op.on === true };
		default:
			return null;
	}
}

/**
 * 解析服务端消息。客户端同样不信任推来的东西（服务端是新写的，将来也可能改），
 * 这里只做形状检查；真正的内容校验（`code` 是否等于当前房间）留给调用方。
 */
export function decodeServerMessage(raw: string): ServerMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const message = parsed as Record<string, unknown>;
	switch (message.t) {
		case 'pong':
			return { t: 'pong' };
		case 'error':
			return { t: 'error', code: message.code as PartyErrorCode, message: asString(message.message, 200) || undefined };
		case 'joined':
		case 'state': {
			if (!message.state || typeof message.state !== 'object') return null;
			const state = message.state as RoomState;
			if (typeof state.code !== 'string' || !Array.isArray(state.members)) return null;
			const chat = Array.isArray(message.chat) ? (message.chat as ChatMessage[]) : [];
			return message.t === 'joined'
				? { t: 'joined', selfId: asId(message.selfId), state, chat }
				: { t: 'state', state, chat };
		}
		default:
			return null;
	}
}

/** 解析大厅消息。 */
export function decodeLobbyMessage(raw: string): LobbyMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const message = parsed as Record<string, unknown>;
	if (message.t !== 'rooms' || !Array.isArray(message.rooms)) return null;
	const rooms: LobbyRoom[] = [];
	for (const item of message.rooms as unknown[]) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		const code = asString(row.code, 16);
		if (!code) continue;
		rooms.push({
			code,
			name: asString(row.name, 40),
			count: Math.max(0, Math.floor(Number(row.count) || 0)),
			at: Math.floor(Number(row.at) || 0),
		});
	}
	return { t: 'rooms', rooms };
}
