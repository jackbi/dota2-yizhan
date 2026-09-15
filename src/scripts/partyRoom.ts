import { getRelaySockets, joinRoom, selfId, type MessageAction, type Room } from 'trystero';
import * as L from '../lib/partyLogic';
import type { ChatMessage, Member, RoomState, Team } from '../lib/partyLogic';

/**
 * 开黑房间的客户端逻辑。
 *
 * 传输是 Trystero（WebRTC 数据通道 + 公共信令中继），**没有服务端**：
 * 服务端只提供静态页面和 `/api/me`（Steam 昵称、头像）。房间不落库、不留聊天记录，
 * 关页面就散——这不是偷懒，是因为本站每 5 分钟重建并重启一次（见 README
 * 「部署与重建频率」），任何存在 SSR 进程内存里的房间都会被那次重启清空。
 *
 * 三条贯穿全文的约定：
 *
 * 1. **房主是唯一权威。** 成员、队伍、roll 结果都在房主的 `state` 里，
 *    其他人只发指令、只渲染收到的快照。这样不需要任何冲突合并，
 *    也保证了「房主分配人员」的结果对所有人一致。
 * 2. **房间密码就是 WebRTC 信令的加密密钥。** Trystero 用 `password` 派生 AES-GCM 密钥
 *    去加密 SDP，还额外做一次 challenge；密码不对的人在信令层就建不起连接，
 *    会走 `onJoinError`。比前端 `if (pwd === input)` 强得多。
 * 3. **遇到失败要说人话。** P2P 的失败（中继被墙、对称 NAT 打不通、密码错）
 *    在浏览器里长得一模一样：都是「房间里没人」。所以每种失败都要有各自的提示，
 *    见 `setNotice` 与 `onJoinError`。
 */

// ---------------------------------------------------------------- 常量

const APP_ID = 'dota2yizhan-party-v1';
const LOBBY_ROOM_ID = 'lobby';
const ROOM_PREFIX = 'room-';
const HASH_PREFIX = '#/r/';

/**
 * 信令中继的冗余度。
 *
 * Trystero 默认从 28 个公共 Nostr 中继里**按 appId 洗牌后取 5 个**——所有人都一致，
 * 但本地网络要是正好把挑中的那 5 个都挡了，房间就永远建不起来，页面上只会显示「没人」。
 * 提到 10 个明显提高命中率，代价是 /party 页面上多开几条 WebSocket（离开页面就关）。
 */
const RELAY_REDUNDANCY = 10;

/**
 * 自定义中继列表。公共中继都在海外，国内直连不稳；要更稳可以自建一个 Trystero 的
 * ws-relay（`@trystero-p2p/ws-relay`），或者填几个本地可达的 Nostr 中继。
 * **填了之后上面那个冗余度会被忽略**（列表里的全部使用）。
 */
const CUSTOM_RELAYS: string[] = [];

/**
 * 信令中继配置。`warnOnRelayFailure: false` 关掉的是 **Trystero 自己**的告警——
 * 公共中继里总有几个在本地网络打不通，每个都刷一行没意义；真正有用的信息是
 * 「连上了几个」，那个由页面顶部的状态条负责展示（浏览器自己为失败的 WebSocket
 * 打的那行 `WebSocket connection to ... failed` 是拦不掉的，那是浏览器在报网络错误）。
 */
type RelayConfigPayload = { warnOnRelayFailure: boolean; urls?: string[]; redundancy?: number };

function relayConfig(): RelayConfigPayload {
	const base: RelayConfigPayload = { warnOnRelayFailure: false };
	return CUSTOM_RELAYS.length > 0 ? { ...base, urls: [...CUSTOM_RELAYS] } : { ...base, redundancy: RELAY_REDUNDANCY };
}

/** 房主每隔多久向大厅重播一次自己的房间。 */
const ANNOUNCE_MS = 15_000;
/** 超过这么久没重播的房间从大厅列表里剔除：房主关页面是不会有告别消息的。 */
const LOBBY_STALE_MS = 45_000;
/** 进房后等不到房主数据的提示延迟。 */
const HOST_SILENCE_MS = 10_000;
/** 房主掉线后等他回来的窗口：刷新只要一两秒，真的走了就等这么久。 */
const HOST_RETURN_MS = 20_000;
/**
 * 「先验证密码」的等待上限。
 *
 * 密码是对的、房主也在，连上并收到第一份快照通常在一两秒内；12 秒还没动静，
 * 基本就是密码/房间码错了或房主不在，没必要让人一直盯着禁用的按钮。
 */
const JOIN_VERIFY_MS = 12_000;

const NICK_KEY = 'dota2-party/nickname';
/**
 * 手填 Steam ID 换来的头像，单独存一份。
 * 不存的话刷新页面头像就退回昵称首字母了——人还在房间里，头像却变了，很怪。
 */
const AVATAR_KEY = 'dota2-party/avatar';
const ROOM_KEY = 'dota2-party/room';

// ---------------------------------------------------------------- 消息类型

/** 大厅里房主广播的一条房间信息。 */
type LobbyAnnounce = {
	code: string;
	name: string;
	/** 房里现在几个人。不报上限：房间不设人数上限，报了反而要多解释一次。 */
	count: number;
	/** 房主离开房间时的告别消息，收到就把这条从列表里删掉。 */
	gone: boolean;
};

type LobbyEntry = { code: string; name: string; count: number; at: number };

/** `avatar` 用空串表示「没有」，理由见 partyLogic 顶部关于 `JsonValue` 的说明。 */
type HelloPayload = { name: string; avatar: string };
type SnapshotPayload = { state: RoomState; chat: ChatMessage[] };
type ChatPayload = { message: ChatMessage };

/** 非房主发给房主的指令。房主自己改状态不走这里，直接调 partyLogic。 */
type Cmd =
	| { type: 'chat'; text: string }
	| { type: 'roll' }
	| { type: 'move'; memberId: string; teamId: string | null }
	| { type: 'sync' };

/** 刷新页面时用来重新进房（房主要用它把房间按原样重建）。 */
type RoomSession = { code: string; password: string; asHost: boolean; name?: string };

/** 进房结果。`defer` 模式下要等房主确认收到我们了才有结论。 */
type EnterResult = { ok: true } | { ok: false; error: string };

/** 正在「先验证密码再进房」时挂着的那个 Promise（见 enterRoom 末尾）。 */
let pendingJoin: { resolve: (result: EnterResult) => void; timer: number } | null = null;

// ---------------------------------------------------------------- DOM

function $<T extends HTMLElement>(selector: string): T {
	const node = document.querySelector<T>(selector);
	if (!node) throw new Error(`开黑房间：页面缺少元素 ${selector}`);
	return node;
}

const dom = {
	setup: $('#party-setup'),
	room: $('#party-room'),
	/** 未登录的页面上才有这个输入框；已登录时服务端不渲染它（见 party.astro）。 */
	nickname: document.querySelector<HTMLInputElement>('#nickname'),
	/*
	 * 下面这组只有**未登录**的页面上才有（服务端按会话决定渲染哪一版，见 party.astro）。
	 * 所以不能用 `$()`——它在缺失时会直接抛，把已登录用户的整个脚本带走。用可选查法，
	 * 用到的地方自己判空。
	 */
	steamIdInput: document.querySelector<HTMLInputElement>('#steamid-input'),
	steamIdLoad: document.querySelector<HTMLButtonElement>('#steamid-load'),
	steamIdPreview: document.querySelector<HTMLElement>('#steamid-preview'),
	steamIdAvatar: document.querySelector<HTMLElement>('#steamid-avatar'),
	steamIdResult: document.querySelector<HTMLElement>('#steamid-result'),
	steamIdStatus: document.querySelector<HTMLElement>('#steamid-status'),
	joinForm: $<HTMLFormElement>('#join-form'),
	joinCode: $<HTMLInputElement>('#join-code'),
	joinPassword: $<HTMLInputElement>('#join-password'),
	createForm: $<HTMLFormElement>('#create-form'),
	createName: $<HTMLInputElement>('#create-name'),
	createPassword: $<HTMLInputElement>('#create-password'),
	lobbyList: $<HTMLUListElement>('#lobby-list'),
	lobbyEmpty: $('#lobby-empty'),
	lobbyCount: $('#lobby-count'),
	netDot: $('#net-dot'),
	netText: $('#net-text'),
	netDetail: $('#net-detail'),
	roomTitle: $('#room-title'),
	roomCode: $('#room-code'),
	roomCount: $('#room-count'),
	roomRole: $('#room-role'),
	roomCopy: $<HTMLButtonElement>('#room-copy'),
	roomLeave: $<HTMLButtonElement>('#room-leave'),
	roomNotice: $('#room-notice'),
	teamSize: $<HTMLInputElement>('#team-size'),
	autoAssign: $<HTMLInputElement>('#auto-assign'),
	teamStage: $('#team-stage'),
	teamFullscreen: $<HTMLButtonElement>('#team-fullscreen'),
	pageFullscreen: $<HTMLButtonElement>('#page-fullscreen'),
	joinSubmit: $<HTMLButtonElement>('#join-submit'),
	teamGrid: $('#team-grid'),
	freePool: $('#free-pool'),
	rollList: $<HTMLOListElement>('#roll-list'),
	rollEmpty: $('#roll-empty'),
	rollRound: $('#roll-round'),
	rollBtn: $<HTMLButtonElement>('#roll-btn'),
	chatLog: $<HTMLOListElement>('#chat-log'),
	chatForm: $<HTMLFormElement>('#chat-form'),
	chatInput: $<HTMLInputElement>('#chat-input'),
};

/**
 * 全站这一页的显隐都走这里，**属性和内联样式一起动**。
 *
 * Tailwind 的 preflight 是 `[hidden]:where(...) { display: none !important }`（v4 带
 * `!important`）。所以只要元素还挂着 `hidden` 属性，把 `style.display` 清成空是**露不出来的**——
 * 这里踩过一次：房间区和提示条在标记里带着 `hidden`，`showRoom()` 之后仍然不可见，
 * 于是整个房间界面和所有报错都看不到，页面上什么反应都没有。
 */
function setVisible(node: HTMLElement, visible: boolean): void {
	node.hidden = !visible;
	node.style.display = visible ? '' : 'none';
}

// ---------------------------------------------------------------- 本地状态

let identity: { name: string; avatar: string } = { name: '', avatar: '' };
/** Steam 登录态。为 null 表示未登录，此时房间里用输入框里的昵称。 */
let steamUser: { name: string; avatar: string } | null = null;

let lobbyRoom: Room | null = null;
/** 我是不是在大厅里播报自己的房间（房主）。只是开关，不影响大厅连接的形态。 */
let lobbyAsHost = false;
let lobbyEntries = new Map<string, LobbyEntry>();
let lastAnnounceAt = 0;

let roomCode = '';
let isHost = false;
/** 房主权威状态；非房主这里是收到的最后一份快照。 */
let room: RoomState | null = null;
let chat: ChatMessage[] = [];
let roomHandle: Room | null = null;
let roomActions: RoomActions | null = null;
/** 是否已经收到过房主的任何数据（用来区分「还没连上」和「房间空了」）。 */
let sawHostData = false;
let hostSilenceTimer = 0;
let hostReturnTimer = 0;
/** 改名中的队（房主点「改名」后临时把标题换成输入框）。 */
let renamingTeamId: string | null = null;

interface RoomActions {
	hello: MessageAction<HelloPayload>;
	sync: MessageAction<SnapshotPayload>;
	state: MessageAction<SnapshotPayload>;
	chat: MessageAction<ChatPayload>;
	cmd: MessageAction<Cmd>;
	bye: MessageAction<null>;
}

/** 取一个不依赖 Math.random 实现质量的随机源给房间逻辑用。 */
function cryptoRand(): number {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] / 2 ** 32;
}

// ---------------------------------------------------------------- 身份

/**
 * 身份来自**服务端渲染的那段 HTML**，不在客户端再问一次 `/api/me`。
 *
 * 登录状态服务端本来就知道（签名 Cookie 就在请求里），因此页面渲染出来的就是最终形态：
 * 已登录的人直接看到 Steam 头像和昵称，不会先闪一下「用 Steam 登录」——之前用
 * `/api/me` 在客户端替换就吃过这个亏：脚本一旦没跑起来（Vite 预构建 504 那次），
 * 已登录的人看到的就是一个登录入口。
 *
 * `data-*` 里的昵称是用户可控内容，只经过 `sanitizeName`，渲染仍然全部走 textContent。
 */
function readIdentityFromDom(): void {
	const block = document.getElementById('identity-block');
	if (!block) return;
	if (block.dataset.mode !== 'steam') return;
	const name = L.sanitizeName(block.dataset.name ?? '') || 'Steam 玩家';
	steamUser = { name, avatar: block.dataset.avatar ?? '' };
	identity = { ...steamUser };
}

readIdentityFromDom();

// ---------------------------------------------------------------- 大厅

/** 表单提交时取「我在房间里叫什么」：Steam 登录 > 手填 Steam ID 取到的资料 > 输入框昵称。 */
function resolveName(form: HTMLFormElement): string | null {
	if (steamUser) {
		identity = { ...steamUser };
		return steamUser.name;
	}
	const raw = dom.nickname?.value ?? '';
	const issue = L.nicknameIssue(raw);
	if (issue) {
		setFormError(form, issue);
		return null;
	}
	const name = L.sanitizeName(raw);
	// 头像保留：它可能来自上面那次「填 Steam ID 读资料」，不能因为提交表单就丢掉。
	identity = { name, avatar: identity.avatar };
	try {
		localStorage.setItem(NICK_KEY, name);
	} catch {
		// 隐私模式下写不了，不影响进房。
	}
	return name;
}

function setSteamIdStatus(message: string | null, kind: 'info' | 'error' = 'info'): void {
	const node = dom.steamIdStatus;
	if (!node) return;
	setVisible(node, message !== null);
	if (message === null) return;
	node.textContent = message;
	node.className = `text-xs leading-relaxed ${kind === 'error' ? 'text-[#f0a08a]' : 'text-muted'}`;
}

/**
 * 「不登录，但也想用自己的头像」：把手填的 Steam ID 换成昵称与头像。
 *
 * 走服务端的 `/api/steam/profile` 而不是直接问 STRATZ：token 只在服务端，
 * 而且那边有 6 小时缓存，不至于有人连点就把额度烧了。
 *
 * 拿到之后**填进昵称输入框**而不是锁死：用户可以改，头像跟着走（改昵称不改头像）。
 */
async function loadSteamId(): Promise<void> {
	const input = dom.steamIdInput;
	const button = dom.steamIdLoad;
	const preview = dom.steamIdPreview;
	const avatarSlot = dom.steamIdAvatar;
	const result = dom.steamIdResult;
	// 已登录时这一整块服务端不渲染，这条路走不到；这里只是把「元素可能不存在」处理干净。
	if (!input || !button || !preview || !avatarSlot || !result) return;

	const id = input.value.trim();
	if (!id) {
		setSteamIdStatus('先填一个 Steam ID 或资料链接。', 'error');
		return;
	}
	button.disabled = true;
	button.textContent = '读取中…';
	setSteamIdStatus('正在查这个账号…');
	try {
		const res = await fetch(`/api/steam/profile?id=${encodeURIComponent(id)}`, {
			headers: { Accept: 'application/json' },
		});
		const data = (await res.json()) as { ok: boolean; name?: string; avatar?: string; error?: string };
		if (!data.ok) {
			setVisible(preview, false);
			setSteamIdStatus(data.error ?? '读取失败，稍后再试。', 'error');
			return;
		}
		const name = L.sanitizeName(data.name ?? '');
		const avatar = typeof data.avatar === 'string' && data.avatar.startsWith('https://') ? data.avatar : '';
		if (name) {
			if (dom.nickname) dom.nickname.value = name;
			identity = { name, avatar };
			try {
				localStorage.setItem(NICK_KEY, name);
				localStorage.setItem(AVATAR_KEY, avatar);
			} catch {
				// 存不下就只是刷新后要重新读一次。
			}
		}
		avatarSlot.replaceChildren(avatarNode(name || '?', avatar, 36));
		result.textContent = name
			? `已读到：${name}${avatar ? '，头像也带上了' : '（这账号没公开头像，先用昵称首字母）'}。之后改昵称不会改头像。`
			: '这个账号没有公开昵称，但头像可以用上了。';
		setVisible(preview, true);
		setSteamIdStatus(null);
	} catch {
		setSteamIdStatus('请求没发出去，检查一下网络再试。', 'error');
	} finally {
		button.disabled = false;
		button.textContent = '读取资料';
	}
}

function setFormError(form: HTMLFormElement, message: string | null): void {
	const node = form.querySelector<HTMLParagraphElement>('[data-form-error]');
	if (!node) return;
	node.textContent = message ?? '';
	setVisible(node, message !== null);
}

// ---------------------------------------------------------------- 提示条

type NoticeKind = 'info' | 'warn' | 'error';
let noticeTimer = 0;

const NOTICE_CLASS: Record<NoticeKind, string> = {
	info: 'rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-muted',
	warn: 'rounded-xl border border-gold-deep/60 bg-gold-deep/10 px-4 py-2.5 text-sm text-gold',
	error: 'rounded-xl border border-dota/60 bg-dota/10 px-4 py-2.5 text-sm text-[#f0a08a]',
};

/**
 * 房间内的提示条。`sticky` 用于「不会自己消失」的状态（房主掉线、密码错），
 * 这类提示必须一直摆在那里，因为用户下一步该做什么完全取决于它。
 */
function setNotice(message: string | null, kind: NoticeKind = 'info', sticky = false): void {
	window.clearTimeout(noticeTimer);
	if (!message) {
		setVisible(dom.roomNotice, false);
		return;
	}
	dom.roomNotice.className = NOTICE_CLASS[kind];
	dom.roomNotice.textContent = message;
	setVisible(dom.roomNotice, true);
	if (!sticky) noticeTimer = window.setTimeout(() => setVisible(dom.roomNotice, false), 6000);
}

// ---------------------------------------------------------------- 大厅

/**
 * 大厅房间：**整个页面生命周期只加入一次，所有人都是活跃身份**。
 *
 * 角色（房主 / 访客）只决定「要不要播报自己的房间」，**不是 joinRoom 的配置项**。
 * 这一点是刻意设计出来的，因为先前的 passive 方案踩了两个坑：
 *
 * 1. **被动房间根本不广播。** 休眠的 passive 房间在 `queueAnnounce` 里就直接 return
 *    （没到活跃状态就不 announce），于是访客只能等房主下一次播报才会被发现并建连——房主每
 *    15 秒才播一次，打开页面盯着空大厅干等十几秒是不能接受的；
 * 2. **角色是 joinRoom 的配置，切换就得 leave + 重进同一个 roomId**，正好撞上
 *    「joinRoom 幂等 + leave 异步」那个坑：`leave()` 第一步是 `await leaveAction.send('')`，
 *    删内部登记在它之后，期间重进会拿回**正在退出的旧实例**（配置也是旧的）。进房与离房
 *    两个方向都会踩，症状是房主以为自己在大厅广播、客人却什么都看不到，而且没有任何报错。
 *    `scripts/lobbyRoom.check.ts` 里对这个行为有断言。
 *
 * 配置不再随角色变化，第 2 类问题就不可能发生；加入时的初始播报是连发几次的（Trystero
 * 的 startup burst），所以新来的人一两秒内就能看到房间，不用等下一个周期。
 *
 * 代价是大厅变成全网状：N 个在线的人两两建连，几十人以内没问题，再多就得另想办法
 * （限制同时在线、或回到被动 + 缩短播报间隔）。README 里记了这一条。
 */
function attachLobbyHandlers(handle: Room): void {
	const announce = handle.makeAction<LobbyAnnounce>('announce');
	const query = handle.makeAction<null>('query');

	announce.onMessage = (data) => {
		if (data.gone) {
			lobbyEntries.delete(data.code);
		} else {
			lobbyEntries.set(data.code, {
				code: data.code,
				name: data.name,
				count: data.count,
				at: Date.now(),
			});
		}
		renderLobby();
	};

	// 访客问「有谁开了房」→ 房主把自己的房间报回去。
	query.onMessage = (_data, { peerId }) => {
		if (lobbyAsHost) announceNow(peerId);
	};

	handle.onPeerJoin = (peerId) => {
		// 连上就各自报一次，别只依赖单边：房主主动播，访客也问一句。
		// 只做单边的话，「那条广播没到」时大厅就是空的，而且没有任何线索能查。
		if (lobbyAsHost) announceNow(peerId);
		else void query.send(null, { target: peerId });
	};
}

function joinLobby(): void {
	if (lobbyRoom) return;
	const handle = joinRoom({ appId: APP_ID, relayConfig: relayConfig() }, LOBBY_ROOM_ID);
	lobbyRoom = handle;
	attachLobbyHandlers(handle);
	renderLobby();
	renderNet();
}

/** 房主开播 / 停播。只是这个开关，**不动大厅连接**。 */
function setLobbyHosting(hosting: boolean): void {
	lobbyAsHost = hosting;
	if (hosting) announceNow();
}

/** 向大厅广播（或单发给某个人）我在开的房间。房间数据变了就要重播一次。 */
function announceNow(target?: string): void {
	if (!lobbyAsHost || !lobbyRoom || !room) return;
	const announce = lobbyRoom.makeAction<LobbyAnnounce>('announce');
	const payload: LobbyAnnounce = {
		code: room.code,
		name: room.name,
		count: room.members.length,
		gone: false,
	};
	void announce.send(payload, target ? { target } : undefined);
	lastAnnounceAt = Date.now();
}

function announceGone(code: string): void {
	if (!lobbyRoom) return;
	const announce = lobbyRoom.makeAction<LobbyAnnounce>('announce');
	void announce.send({ code, name: '', count: 0, gone: true });
}

function renderLobby(): void {
	const now = Date.now();
	for (const [code, entry] of lobbyEntries) {
		if (now - entry.at > LOBBY_STALE_MS) lobbyEntries.delete(code);
	}
	const entries = [...lobbyEntries.values()].sort((a, b) => b.at - a.at);

	dom.lobbyList.replaceChildren(
		...entries.map((entry) => {
			const card = h('li', 'rounded-xl border border-line bg-ink-2 p-3');
			const head = h('div', 'flex items-baseline gap-2');
			head.append(
				h('h3', 'min-w-0 flex-1 truncate text-sm font-medium text-cream', entry.name),
				h('span', 'shrink-0 text-xs text-faint', `${entry.count} 人`),
			);
			const meta = h('p', 'mt-1 text-xs text-faint');
			meta.append(document.createTextNode('房间码 '));
			meta.append(h('span', 'font-display tracking-[0.2em] text-gold', entry.code));
			const join = h('button', 'mt-2.5 w-full rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition hover:border-dota hover:text-cream', '加入');
			join.type = 'button';
			join.dataset.joinCode = entry.code;
			card.append(head, meta, join);
			return card;
		}),
	);

	setVisible(dom.lobbyEmpty, entries.length === 0);
	dom.lobbyCount.textContent = entries.length > 0 ? `${entries.length} 个房间在等人` : '';
}

// ---------------------------------------------------------------- 进房 / 离房

function codeFromHash(): string {
	const raw = location.hash.startsWith(HASH_PREFIX) ? location.hash.slice(HASH_PREFIX.length) : '';
	// 邀请链接里的码可能是小写或被手打脏的，统一归一化后再比。
	const code = L.normalizeCode(raw);
	return L.isValidCode(code) ? code : '';
}

function readSession(): RoomSession | null {
	try {
		const raw = sessionStorage.getItem(ROOM_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as RoomSession;
		return parsed && typeof parsed.code === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

function writeSession(session: RoomSession | null): void {
	try {
		if (session) sessionStorage.setItem(ROOM_KEY, JSON.stringify(session));
		else sessionStorage.removeItem(ROOM_KEY);
	} catch {
		// 存不进去只是刷新后要重新输密码，不该挡住进房。
	}
}

function showSetup(): void {
	// 离房时把队伍区全屏退掉：那块在房间界面里，界面一藏就只剩一片空。
	exitStageFullscreen();
	setVisible(dom.setup, true);
	setVisible(dom.room, false);
	document.body.dataset.partyView = 'setup';
	dom.chatLog.replaceChildren();
}

function showRoom(): void {
	setVisible(dom.setup, false);
	setVisible(dom.room, true);
	document.body.dataset.partyView = 'room';
}

async function enterRoom(options: {
	code: string;
	password: string;
	asHost: boolean;
	name?: string;
	/** 加入别人的房间时用：先留在设置页验证密码，连上之后才切到房间界面。 */
	defer?: boolean;
}): Promise<EnterResult> {
	if (pendingJoin) settleJoin({ ok: false, error: '上一次加入还没结束，请重试。' });
	if (roomCode) await leaveRoom({ silent: true });

	roomCode = options.code;
	isHost = options.asHost;
	room = null;
	chat = [];
	sawHostData = false;
	setNotice(null);
	// defer 模式先不切界面：密码就是信令密钥，连不上就说明密码不对或房主不在，
	// 这时候把人丢进一个空房间没有意义（见文件末尾那个 Promise）。
	if (!options.defer) showRoom();
	renderRoom();
	setNotice(isHost ? '正在建房…' : '正在连接房间…', 'info', true);
	if (!isHost && !options.defer) startHostSilenceTimer();

	const handle = joinRoom(
		{ appId: APP_ID, password: options.password, relayConfig: relayConfig() },
		`${ROOM_PREFIX}${options.code}`,
		{ onJoinError: (details) => onJoinError(details.error) },
	);
	roomHandle = handle;

	const actions: RoomActions = {
		hello: handle.makeAction<HelloPayload>('hello'),
		sync: handle.makeAction<SnapshotPayload>('sync'),
		state: handle.makeAction<SnapshotPayload>('state'),
		chat: handle.makeAction<ChatPayload>('chat'),
		cmd: handle.makeAction<Cmd>('cmd'),
		bye: handle.makeAction<null>('bye'),
	};
	roomActions = actions;

	actions.hello.onMessage = (payload, { peerId }) => {
		if (!isHost) return;
		hostAddMember(peerId, payload);
	};
	actions.cmd.onMessage = (cmd, { peerId }) => hostHandleCmd(peerId, cmd);
	actions.bye.onMessage = (_payload, { peerId }) => {
		if (!isHost || !room) return;
		const member = L.memberById(room, peerId);
		if (member) hostMutate((state) => L.removeMember(state, peerId), `${member.name} 离开了房间`);
	};
	actions.sync.onMessage = (payload) => applySnapshot(payload, true);
	actions.state.onMessage = (payload) => applySnapshot(payload, false);
	actions.chat.onMessage = (payload) => {
		chat = L.appendChat(chat, payload.message);
		renderChat();
	};

	handle.onPeerJoin = (peerId) => {
		if (isHost) return;
		// 房主（或房主重建后的新实例）上线了：报上自己的身份，等他回快照。
		void actions.hello.send({ name: identity.name, avatar: identity.avatar }, { target: peerId });
	};
	handle.onPeerLeave = (peerId) => {
		if (isHost) {
			if (!room) return;
			const member = L.memberById(room, peerId);
			// 没打过招呼就走了的人不在名册里，不用处理。
			if (member) hostMutate((state) => L.removeMember(state, peerId), `${member.name} 掉线了`);
			return;
		}
		if (room && peerId === room.hostId) waitForHost();
	};

	if (isHost) {
		const fallback = L.sanitizeName(identity.name) || '房主';
		identity = { name: fallback, avatar: identity.avatar };
		const name = options.name ?? fallback;
		room = L.createRoom({
			code: options.code,
			name,
			host: { id: selfId, name: fallback, avatar: identity.avatar, joinedAt: Date.now() },
		});
		chat = [systemMessage(`房间「${room.name}」已创建，房间码 ${room.code}`)];
		setNotice(null);
		renderRoom();
		renderChat();
		// 房间开起来之后才开播：大厅卡片上的人数要准。
		setLobbyHosting(true);
	} else {
		renderRoom();
	}

	writeSession({ code: options.code, password: options.password, asHost: options.asHost, name: options.name });
	if (codeFromHash() !== options.code) history.replaceState(null, '', `${location.pathname}${HASH_PREFIX}${options.code}`);

	if (!options.defer) return { ok: true };
	/*
	 * 「先验证密码，再进房间」。
	 *
	 * 密码就是信令的加密密钥，Trystero 没有「只验一下密码」的接口——唯一可靠的验证方式就是
	 * 真去连一次。所以这里不改验证方式，只把**界面切换时机**往后挪：密码对了、房主把房间快照
	 * 发过来了，才切到房间界面（见 applySnapshot）。在此之前一直留在加入房间那张卡上，
	 * 错了就把原因写在卡片里，而不是让人先进一个空房间再被踢出来。
	 */
	return new Promise<EnterResult>((resolve) => {
		pendingJoin = {
			resolve,
			timer: window.setTimeout(() => {
				settleJoin({
					ok: false,
					error:
						'一直没收到房主的回应。按可能性排查：① 房间码或密码抄错了——写错时房主那边完全看不到你的请求，不会有人来告诉你；② 房主已经不在这个房间了；③ 双方网络不允许直连。',
				});
				void leaveRoom({ silent: true });
			}, JOIN_VERIFY_MS),
		};
	});
}

/** 给挂起的进房一个结论。只认第一次，避免超时与错误两边都来抢。 */
function settleJoin(result: EnterResult): void {
	const pending = pendingJoin;
	if (!pending) return;
	pendingJoin = null;
	window.clearTimeout(pending.timer);
	pending.resolve(result);
}

async function leaveRoom(options: { silent?: boolean } = {}): Promise<void> {
	const wasHost = isHost;
	const code = roomCode;
	if (wasHost && !options.silent) {
		const confirmed = window.confirm('你是房主，离开后房间就解散了，其他人会掉线。确定离开？');
		if (!confirmed) return;
	}
	if (wasHost) {
		announceGone(code);
		setLobbyHosting(false);
	}
	window.clearTimeout(hostSilenceTimer);
	window.clearTimeout(hostReturnTimer);
	if (roomHandle) {
		try {
			// **必须等它落定**：Trystero 的 leave() 是异步的（先发告别消息、再删内部登记），
			// 不等就重进同一个 roomId 会拿回正在退出的旧实例。密码输错后重试正好走这条路。
			await roomHandle.leave();
		} catch {
			// 退不掉也要把本地状态清干净，否则界面会卡在房间里。
		}
	}
	roomHandle = null;
	roomActions = null;
	roomCode = '';
	isHost = false;
	room = null;
	chat = [];
	sawHostData = false;
	renamingTeamId = null;
	setNotice(null);
	writeSession(null);
	history.replaceState(null, '', location.pathname);
	showSetup();
}

/** 非房主侧：进房一段时间没收到房主的任何数据。 */
function startHostSilenceTimer(): void {
	window.clearTimeout(hostSilenceTimer);
	hostSilenceTimer = window.setTimeout(() => {
		if (sawHostData || !roomCode) return;
		setNotice(
			'一直没收到房主的响应。按可能性排查：① 密码或房间码抄错了——写错时房主那边完全看不到你的请求，所以不会有人来告诉你；② 双方网络不允许直连。先核一遍密码和房间码，再换个网络（比如手机热点）试。',
			'warn',
			true,
		);
	}, HOST_SILENCE_MS);
}

/**
 * 房主掉线（含他自己刷新页面）。
 *
 * 不能立刻把房间判死：刷新只要一两秒，房主会带着**新的 peer id** 回来
 * （Trystero 的 selfId 每次加载都重新生成）。所以这里先给一个宽限窗口，
 * 期间只要收到房主的任何快照就当作他回来了。
 */
function waitForHost(): void {
	if (!roomCode) return;
	setNotice('房主掉线了，正在等他回来…（他刷新页面的话马上就回）', 'warn', true);
	window.clearTimeout(hostReturnTimer);
	hostReturnTimer = window.setTimeout(() => {
		if (!roomCode) return;
		setNotice('房主已经离开，房间解散了。', 'error', true);
		dom.chatInput.disabled = true;
	}, HOST_RETURN_MS);
}

function onJoinError(error: string): void {
	/*
	 * 已经有确切诊断了，就别再让「等不到房主」那条超时提示把它盖掉。
	 *
	 * 这里踩过：密码输错时 joiner 一两秒内就会收到
	 * `incorrect room password when decrypting offer`，页面先显示「密码不对」，
	 * 但 10 秒后 silence 定时器照样触发，把这条精确提示覆盖成「也可能是网络……换网络再试」，
	 * 于是「密码错」被读成了「网络错」。
	 */
	window.clearTimeout(hostSilenceTimer);
	// Trystero 的密码失败文案都带 password：解密 SDP 失败与握手 challenge 失败。
	const passwordProblem = /password/i.test(error);

	// 还在「先验证密码」阶段：把结论交回那张加入卡片，不要切界面、也不要留个空房间。
	if (pendingJoin) {
		settleJoin({
			ok: false,
			error: passwordProblem
				? '密码不对：这个房间的密码和房主设的不一样。房间里的人收不到你的加入请求，所以不会有人来提醒你——回去问一下房主，顺便确认房间码没念错。'
				: `连不上房主（${error}）。这是网络限制，不是密码问题：同一个 WiFi 下的两个人通常能连上，否则换个网络（比如手机热点）再试。`,
		});
		void leaveRoom({ silent: true });
		return;
	}

	// 房主看到这条，说明是**别人**没进来（他自己的连接是好的）。
	if (isHost) {
		setNotice(
			passwordProblem
				? '有人想加入，但密码不对，被挡在门外了。把房间码和密码再对一遍给他。'
				: `有人想加入，但你们之间建不起直连（${error}）。多人房间里这通常是对面网络受限。`,
			'warn',
		);
		return;
	}

	// 已经在房间里了：这说明只是和**某一个人**连不上（两人的网络互不通），
	// 房主那边多半是好的。这种部分失败不说清楚，会让人以为整个房间都坏了。
	if (sawHostData) {
		setNotice(`和房间里的某个人建立不了直连（${error}）。其他人不受影响，但这个人的消息你看不到。`, 'warn');
		return;
	}

	setNotice(
		passwordProblem
			? '密码不对：这个房间的密码和房主设的不一样。房间里的人收不到你的加入请求，所以不会有人来提醒你——回去问一下房主，顺便确认房间码没念错。'
			: `和房间里的人建立不了直连（${error}）。这是网络限制，不是密码问题：同一个 WiFi 下的两个人通常能连上，否则换个网络（比如手机热点）再试。`,
		'error',
		true,
	);
}

/** 非房主收到的快照。 */
function applySnapshot(payload: SnapshotPayload, isSync: boolean): void {
	if (!roomCode) return;
	// 房主换了实例（刷新后 peer id 变了）时 rev 会从头开始，不能按 rev 丢弃。
	if (room && payload.state.hostId === room.hostId && payload.state.rev < room.rev) return;
	if (payload.state.code !== roomCode) return;

	const first = !sawHostData;
	sawHostData = true;
	window.clearTimeout(hostSilenceTimer);
	window.clearTimeout(hostReturnTimer);
	dom.chatInput.disabled = false;
	setNotice(null);
	room = payload.state;
	if (isSync && payload.chat) chat = [...payload.chat];
	if (first) chat = L.appendChat(chat, systemMessage('已连上房主，房间信息同步完成'));
	renderRoom();
	renderChat();

	// 收到房主的快照 = 密码是对的、房主也在：这时候才把人放进房间界面。
	if (pendingJoin) {
		settleJoin({ ok: true });
		showRoom();
	}
}

// ---------------------------------------------------------------- 房主侧

/** 房主改状态：算新状态 → 记一条系统消息 → 广播 → 刷新大厅里的人数。 */
function hostMutate(mutate: (state: RoomState) => RoomState, systemText?: string | null): void {
	if (!isHost || !room || !roomActions) return;
	const next = mutate(room);
	if (next === room) return;
	room = next;
	if (systemText) pushMessage(systemMessage(systemText));
	renderRoom();
	renderChat();
	// 广播不带聊天历史：历史只在有人进房时单独补发（`sync`），否则每条消息都要重传一遍。
	void roomActions.state.send({ state: room, chat: [] });
	// 人走了/来了要重播，大厅卡片上的人数是实时算的。
	if (systemText) announceNow();
}

function pushMessage(message: ChatMessage): void {
	chat = L.appendChat(chat, message);
	if (roomActions) void roomActions.chat.send({ message });
}

function hostAddMember(peerId: string, payload: HelloPayload): void {
	if (!isHost || !room || !roomActions) return;
	/*
	 * 这里的 `typeof` 判断看着多余（类型上就是 string），但这是**从数据通道收来的**内容：
	 * 对面的版本可能比我们旧、也可能有人手搓消息。类型只是本仓库内部的约定，不是运行时保证。
	 */
	const rawName = typeof payload.name === 'string' ? payload.name : '';
	const rawAvatar = typeof payload.avatar === 'string' ? payload.avatar : '';
	const name = L.sanitizeName(rawName) || '无名氏';
	const member: Member = {
		id: peerId,
		name,
		// 头像地址来自对方的 Steam 资料，只在 <img> 里用（不拼 HTML），并限定 https。
		avatar: rawAvatar.startsWith('https://') ? rawAvatar : '',
		joinedAt: Date.now(),
	};

	if (L.memberById(room, peerId)) {
		// 老面孔重连（刷新、切网络）：只更新昵称头像，不记一条「加入房间」的噪音。
		const before = room;
		room = L.upsertMember(room, member).state;
		renderRoom();
		if (room.rev !== before.rev) void roomActions.state.send({ state: room, chat: [] });
		void roomActions.sync.send({ state: room, chat }, { target: peerId });
		return;
	}

	const before = room;
	const result = L.upsertMember(room, member);
	room = result.state;
	pushMessage(systemMessage(`${name} 加入了房间`));
	renderRoom();
	renderChat();
	if (room.rev !== before.rev) void roomActions.state.send({ state: room, chat: [] });
	// 新来的人单独补一份完整快照（带聊天历史）。
	void roomActions.sync.send({ state: room, chat }, { target: peerId });
	announceNow();
}

function hostHandleCmd(peerId: string, cmd: Cmd): void {
	if (!isHost || !room || !roomActions) return;
	const member = L.memberById(room, peerId);
	if (!member) return; // 没打过招呼的人不能发言、不能操作

	switch (cmd.type) {
		case 'chat': {
			const text = L.clampChatText(cmd.text ?? '');
			if (!text) return;
			// 名字用名册里的，不采信对方传来的昵称：否则谁都能顶着别人的名字说话。
			pushMessage({ id: id(), kind: 'say', peerId, name: member.name, text, at: Date.now() });
			renderChat();
			break;
		}
		case 'roll': {
			const value = L.rollValue(cryptoRand);
			hostMutate((state) => L.setRoll(state, peerId, value), `${member.name} 掷出了 ${value}`);
			break;
		}
		case 'move': {
			// 只有本人能挪自己（房主挪别人走的是本地操作，不经过这里）。
			if (cmd.memberId !== peerId) return;
			hostMutate((state) => L.moveMember(state, cmd.memberId, cmd.teamId), null);
			break;
		}
		case 'sync':
			void roomActions.sync.send({ state: room, chat }, { target: peerId });
			break;
	}
}

// ---------------------------------------------------------------- 渲染

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function id(): string {
	return `${Date.now().toString(36)}-${Math.floor(cryptoRand() * 1e6).toString(36)}`;
}

function systemMessage(text: string): ChatMessage {
	return { id: id(), kind: 'system', peerId: '', name: '', text, at: Date.now() };
}

/**
 * 头像：首字母占位 + 图片盖在上面。
 *
 * Steam 的头像 CDN（`avatars.steamstatic.com`）会拒掉带 Referer 的请求，
 * `referrerPolicy` 不能省（站内其它头像处也是这么写的）；加载失败就把 `<img>` 摘掉，
 * 露出底下的首字母，不会出现破图图标。
 */
function avatarNode(name: string, avatar: string, size: number): HTMLElement {
	const box = h(
		'span',
		'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-faint',
	);
	box.style.width = `${size}px`;
	box.style.height = `${size}px`;
	const initial = h('span', '', L.initialOf(name));
	initial.style.fontSize = `${Math.round(size * 0.42)}px`;
	initial.setAttribute('aria-hidden', 'true');
	box.append(initial);
	if (avatar) {
		const img = h('img', 'absolute inset-0 h-full w-full object-cover');
		img.src = avatar;
		img.alt = '';
		img.loading = 'lazy';
		img.referrerPolicy = 'no-referrer';
		img.addEventListener('error', () => img.remove());
		box.append(img);
	}
	return box;
}

function renderNet(): void {
	let open = 0;
	try {
		const sockets = getRelaySockets() as Record<string, WebSocket | undefined>;
		for (const socket of Object.values(sockets)) if (socket?.readyState === 1) open += 1;
	} catch {
		// 取不到就当没连上，下面的文案本来就是「连不上怎么办」。
	}

	dom.netDot.className = `h-2 w-2 shrink-0 rounded-full ${open > 0 ? 'bg-[#22c55e]' : 'bg-faint'}`;
	dom.netText.textContent =
		open > 0 ? `信令中继已连接 ${open} 个` : '正在连接信令中继…（一直连不上就换网络或开代理）';

	/*
	 * 大厅里**连上了几个人**是这页最重要的自检数字：房间列表、聊天、分队加起来都建立在
	 * 「P2P 真的连上了」之上，而连不上时页面上什么都不会发生、也不会报错。
	 * 报出这个数字，就能一眼分清「没人开房」和「我根本没连上」。
	 */
	let lobbyPeers = 0;
	try {
		lobbyPeers = Object.keys(lobbyRoom?.getPeers() ?? {}).length;
	} catch {
		// 取不到就当 0，下面的文案本来就是「还在找」。
	}

	const parts: string[] = [];
	if (roomCode && room) {
		parts.push(`房间内 ${room.members.length} 人`);
		// 房主是否真的在大厅里可见，是「大厅看不到房间」那类问题的唯一线索，这里一并摆出来。
		if (isHost) parts.push(`大厅可见 · 已连 ${lobbyPeers} 人`);
	} else {
		parts.push(lobbyPeers > 0 ? `大厅已连 ${lobbyPeers} 人` : '正在找大厅里的其他人…');
		parts.push(lobbyEntries.size > 0 ? `${lobbyEntries.size} 个房间在等人` : '当前没有房间');
	}
	parts.push('P2P 直连，本站不经手聊天内容');
	dom.netDetail.textContent = parts.join(' · ');
}

function renderRoom(): void {
	if (!room) {
		// 还没拿到快照：只把头部的房间码显示出来，其余留空，避免闪出一堆空面板。
		dom.roomTitle.textContent = isHost ? '正在建房…' : '正在连接…';
		dom.roomCode.textContent = roomCode;
		dom.roomCount.textContent = '';
		dom.roomRole.textContent = isHost ? '房主' : '';
		dom.teamGrid.replaceChildren();
		dom.freePool.replaceChildren();
		renderRolls();
		setHostToolsVisible();
		return;
	}

	const state = room;
	dom.roomTitle.textContent = state.name;
	dom.roomCode.textContent = state.code;
	dom.roomCount.textContent = `${state.members.length} 人`;
	dom.roomRole.textContent = isHost ? '房主' : '成员';
	setHostToolsVisible();
	dom.teamSize.value = String(state.teamSize);
	dom.autoAssign.checked = state.autoAssign;

	renderTeams();
	renderRolls();
}

function setHostToolsVisible(): void {
	for (const node of document.querySelectorAll<HTMLElement>('[data-host-tool]')) node.hidden = !isHost;
	dom.teamSize.disabled = !isHost;
	dom.autoAssign.disabled = !isHost;
}

function renderTeams(): void {
	if (!room) return;
	const state = room;
	// 正在改队名时不要重建队伍区：重建会把输入框连同没提交的内容一起换掉。
	// 队名的提交/取消自己会再调一次 renderTeams，不怕漏刷新。
	const editing = document.activeElement;
	if (renamingTeamId && editing instanceof HTMLInputElement && editing.dataset.teamRename === renamingTeamId) return;
	// 重新渲染会丢掉 select 的焦点，记住是谁的再还回去（不然连着挪两个人很难受）。
	const focused =
		document.activeElement instanceof HTMLSelectElement ? document.activeElement.dataset.memberId : undefined;

	dom.teamGrid.replaceChildren(...state.teams.map((team) => teamCard(state, team)));

	const free = L.freeMembers(state);
	const pool = h('section', 'rounded-2xl border border-dashed border-line bg-surface/60 p-4');
	const head = h('div', 'flex items-baseline gap-2');
	head.append(
		h('h3', 'font-display text-sm text-muted', '空闲池'),
		h('span', 'text-xs text-faint', `${free.length} 人${isHost ? ' · 用右侧下拉归队' : ''}`),
	);
	pool.append(head);
	if (free.length === 0) {
		pool.append(h('p', 'mt-3 text-xs text-faint', state.members.length === 0 ? '还没有人。' : '所有人都已经在队伍里了。'));
	} else {
		const list = h('ul', 'mt-3 space-y-1.5');
		list.append(...free.map((member) => memberCard(state, member)));
		pool.append(list);
	}
	dom.freePool.replaceChildren(pool);

	if (focused) {
		document.querySelector<HTMLSelectElement>(`select[data-member-id="${CSS.escape(focused)}"]`)?.focus();
	}
}

function teamCard(state: RoomState, team: Team): HTMLElement {
	const card = h('article', 'rounded-2xl border border-line bg-surface p-4');

	const head = h('div', 'flex items-center gap-2');
	if (renamingTeamId === team.id) {
		const input = h('input', 'min-w-0 flex-1 rounded-md border border-line bg-ink-2 px-2 py-1 text-sm text-cream focus:border-dota focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold');
		input.value = team.name;
		input.maxLength = L.NAME_MAX;
		input.dataset.teamRename = team.id;
		// Enter 提交后输入框会被换掉，blur 还会再触发一次，所以只认第一次。
		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const next = input.value;
			renamingTeamId = null;
			hostMutate((current) => L.renameTeam(current, team.id, next), null);
			renderTeams();
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') commit();
			if (event.key === 'Escape') {
				renamingTeamId = null;
				renderTeams();
			}
		});
		input.addEventListener('blur', commit);
		head.append(input);
		window.setTimeout(() => input.focus(), 0);
	} else {
		head.append(
			h('h3', 'min-w-0 flex-1 truncate font-display text-sm text-cream', team.name),
			h('span', 'shrink-0 text-xs text-faint', `${team.members.length}/${state.teamSize}`),
		);
		if (isHost) {
			const rename = h('button', 'rounded border border-line px-1.5 py-0.5 text-[11px] text-faint transition hover:border-dota hover:text-cream', '改名');
			rename.type = 'button';
			rename.dataset.teamRenameStart = team.id;
			const remove = h('button', 'rounded border border-line px-1.5 py-0.5 text-[11px] text-faint transition hover:border-dota hover:text-cream', '删队');
			remove.type = 'button';
			remove.dataset.teamRemove = team.id;
			remove.disabled = state.teams.length <= 1;
			head.append(rename, remove);
		}
	}
	card.append(head);

	if (team.members.length === 0) {
		card.append(h('p', 'mt-3 text-xs text-faint', '这个队还是空的。'));
		return card;
	}
	const list = h('ul', 'mt-3 space-y-1.5');
	list.append(
		...[...team.members]
			.map((memberId) => L.memberById(state, memberId))
			.filter((member): member is Member => Boolean(member))
			.map((member) => memberCard(state, member)),
	);
	card.append(list);
	return card;
}

function memberCard(state: RoomState, member: Member): HTMLElement {
	const item = h('li', 'flex items-center gap-2 rounded-lg border border-line bg-ink-2 px-2 py-1.5');
	item.append(avatarNode(member.name, member.avatar, 24));

	const name = h('span', 'min-w-0 flex-1 truncate text-sm text-cream', member.name);
	if (member.id === selfId) name.classList.add('font-medium');
	item.append(name);

	if (member.id === state.hostId) item.append(h('span', 'shrink-0 rounded bg-surface-3 px-1 text-[10px] text-gold', '房主'));

	const roll = state.rolls[member.id];
	if (roll) item.append(h('span', 'shrink-0 text-xs tabular-nums text-gold', String(roll.value)));

	/*
	 * 归队用一个 <select> 而不是拖拽：拖拽在触屏和键盘上都要另做一套等价操作，
	 * 而下拉天然三端可用。房主能挪任何人，其他人只能挪自己。
	 */
	const editable = isHost || member.id === selfId;
	const select = h('select', 'shrink-0 max-w-[7rem] rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-muted focus:border-dota focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold');
	select.dataset.memberId = member.id;
	select.disabled = !editable;
	const current = L.teamOf(state, member.id)?.id ?? '';
	const options: [string, string][] = [['', '空闲']];
	for (const team of state.teams) options.push([team.id, team.name]);
	for (const [value, label] of options) {
		const option = h('option', undefined, label);
		option.value = value;
		option.selected = value === current;
		select.append(option);
	}
	item.append(select);
	return item;
}

function renderRolls(): void {
	if (!room) {
		dom.rollList.replaceChildren();
		setVisible(dom.rollEmpty, true);
		dom.rollRound.textContent = '';
		return;
	}
	const board = L.rollBoard(room);
	dom.rollRound.textContent = `第 ${room.rollRound} 轮`;
	setVisible(dom.rollEmpty, board.length === 0);
	dom.rollList.replaceChildren(
		...board.map(({ member, roll }, index) => {
			const item = h('li', 'flex items-center gap-2');
			if (index === 0 && board.length > 1) item.classList.add('text-gold');
			item.append(
				h('span', 'w-4 shrink-0 text-xs tabular-nums text-faint', String(index + 1)),
				h('span', 'min-w-0 flex-1 truncate text-cream/90', member.name),
				h('span', 'shrink-0 font-display tabular-nums', String(roll.value)),
			);
			return item;
		}),
	);
}

function renderChat(): void {
	dom.chatLog.replaceChildren(
		...chat.map((message) => {
			if (message.kind === 'system') {
				return h('li', 'text-center text-xs text-gold/90', `${L.clockOf(message.at)} · ${message.text}`);
			}
			const item = h('li', 'flex gap-2');
			item.append(h('span', 'shrink-0 text-[11px] tabular-nums text-faint', L.clockOf(message.at)));
			const body = h('div', 'min-w-0 flex-1 break-words');
			const name = h('span', 'font-medium', `${message.name ?? '?'}：`);
			name.classList.add(message.peerId === selfId ? 'text-dota-light' : 'text-cream/80');
			body.append(name, document.createTextNode(message.text ?? ''));
			item.append(body);
			return item;
		}),
	);
	dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

// ---------------------------------------------------------------- 全屏

/**
 * 全屏。两个目标，逻辑完全一样，只是节点不同：
 *
 * - **网页全屏**：整个 `<html>`，看直播式的沉浸浏览；
 * - **队伍分配区**：只放大队伍那一块，排完队投屏或摆第二块屏时用。
 *
 * 用 Fullscreen API 而不是「另开一个页面」：房间状态在房主的 `room` 里、成员各自在浏览器里，
 * 另开一个页面就得再同步一份状态，还要处理哪个窗口说了算。全屏只是把节点放大，零同步成本。
 *
 * 队伍区在不支持元素级全屏的浏览器上（典型是 iPad Safari）退回固定定位的「伪全屏」，
 * 那个模式浏览器不管 Esc，由下面绑的 keydown 接住。网页全屏不需要退化方案——页面本来
 * 就占满视口，没有 API 时按钮直接不出现。
 */
type FullscreenSpec = {
	node: HTMLElement;
	button: HTMLButtonElement;
	enterLabel: string;
	exitLabel: string;
	/** 退化模式用的类名；不给就表示这个目标没有退化方案。 */
	fauxClass?: string;
};

let FULLSCREEN: FullscreenSpec[] = [];

function fullscreenActive(spec: FullscreenSpec): boolean {
	if (document.fullscreenElement === spec.node) return true;
	return spec.fauxClass !== undefined && spec.node.classList.contains(spec.fauxClass);
}

function syncFullscreenLabels(): void {
	for (const spec of FULLSCREEN) {
		const active = fullscreenActive(spec);
		spec.button.textContent = active ? spec.exitLabel : spec.enterLabel;
		spec.button.setAttribute('aria-pressed', String(active));
	}
}

function setFullscreen(spec: FullscreenSpec, on: boolean): void {
	const supported = typeof spec.node.requestFullscreen === 'function';
	if (!supported) {
		if (spec.fauxClass === undefined) return;
		spec.node.classList.toggle(spec.fauxClass, on);
		syncFullscreenLabels();
		return;
	}
	if (on) {
		// 浏览器可能拒绝（比如不是用户手势触发的），有退化方案就退回去，别让按钮点了没反应。
		const pending = spec.node.requestFullscreen() as Promise<void> | undefined;
		void pending
			?.catch(() => {
				if (spec.fauxClass !== undefined) spec.node.classList.add(spec.fauxClass);
			})
			.finally(syncFullscreenLabels);
		return;
	}
	if (document.fullscreenElement === spec.node) void document.exitFullscreen();
	if (spec.fauxClass !== undefined) spec.node.classList.remove(spec.fauxClass);
	syncFullscreenLabels();
}

/** 退出所有全屏（Esc 用）。 */
function exitAllFullscreen(): void {
	for (const spec of FULLSCREEN) if (fullscreenActive(spec)) setFullscreen(spec, false);
}

/**
 * 只退出「有退化方案」的那些目标——也就是队伍区。
 *
 * 离房时要调：队伍区在房间界面里，界面一藏，全屏的就会是一片空的区域。网页全屏不在此列，
 * 它跟房间界面的显隐无关，人退出房间后继续全屏着是合理的。
 */
function exitStageFullscreen(): void {
	for (const spec of FULLSCREEN) {
		if (spec.fauxClass !== undefined && fullscreenActive(spec)) setFullscreen(spec, false);
	}
}

// ---------------------------------------------------------------- 事件

function bindEvents(): void {
	dom.joinForm.addEventListener('submit', (event) => {
		event.preventDefault();
		void submitJoin();
	});
	dom.createForm.addEventListener('submit', (event) => {
		event.preventDefault();
		void submitCreate();
	});
	dom.joinCode.addEventListener('input', () => {
		// 归一化（转大写、剔掉字母表外的字符）后光标会落到末尾，对连续输入正好。
		dom.joinCode.value = L.normalizeCode(dom.joinCode.value);
	});

	dom.steamIdLoad?.addEventListener('click', () => void loadSteamId());
	dom.steamIdInput?.addEventListener('keydown', (event) => {
		// 这是个输入框不是表单，回车得自己接。输入框在 <details> 里，回车不会误触提交。
		if (event.key === 'Enter') {
			event.preventDefault();
			void loadSteamId();
		}
	});

	dom.chatForm.addEventListener('submit', (event) => {
		event.preventDefault();
		const text = L.clampChatText(dom.chatInput.value);
		if (!text) return;
		dom.chatInput.value = '';
		if (isHost) {
			if (!room) return;
			pushMessage({ id: id(), kind: 'say', peerId: selfId, name: identity.name, text, at: Date.now() });
			renderChat();
		} else {
			void roomActions?.cmd.send({ type: 'chat', text });
		}
	});

	dom.rollBtn.addEventListener('click', () => {
		if (!room) return;
		if (isHost) {
			const value = L.rollValue(cryptoRand);
			hostMutate((state) => L.setRoll(state, selfId, value), `${identity.name} 掷出了 ${value}`);
		} else {
			void roomActions?.cmd.send({ type: 'roll' });
		}
	});

	dom.teamSize.addEventListener('change', () => {
		const size = Number(dom.teamSize.value);
		hostMutate((state) => L.setTeamSize(state, size), `每队上限改成 ${L.clampTeamSize(size)} 人`);
	});
	dom.autoAssign.addEventListener('change', () => {
		hostMutate((state) => L.setAutoAssign(state, dom.autoAssign.checked), null);
	});

	// 房主工具：按钮分散在几处，统一用事件委托。
	document.addEventListener('click', (event) => {
		const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-host-tool]');
		if (!target || !isHost) return;
		const tool = target.dataset.hostTool;
		if (tool === 'autoForm') hostMutate((state) => L.autoFormTeams(state), '按人数重新分队');
		else if (tool === 'randomize') hostMutate((state) => L.randomizeTeams(state, cryptoRand), '随机重排了队伍');
		else if (tool === 'byRoll') hostMutate((state) => L.formTeamsByRoll(state), '按 roll 蛇形分队');
		else if (tool === 'addTeam') hostMutate((state) => L.addTeam(state), '新增了一个队伍');
		else if (tool === 'clearRolls') hostMutate((state) => L.clearRolls(state), '重开了一轮 roll');
	});

	dom.teamGrid.addEventListener('change', (event) => {
		const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-member-id]');
		if (!select) return;
		const memberId = select.dataset.memberId ?? '';
		const teamId = select.value || null;
		if (isHost) hostMutate((state) => L.moveMember(state, memberId, teamId), null);
		else void roomActions?.cmd.send({ type: 'move', memberId, teamId });
	});
	dom.freePool.addEventListener('change', (event) => {
		const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-member-id]');
		if (!select) return;
		const memberId = select.dataset.memberId ?? '';
		const teamId = select.value || null;
		if (isHost) hostMutate((state) => L.moveMember(state, memberId, teamId), null);
		else void roomActions?.cmd.send({ type: 'move', memberId, teamId });
	});

	document.addEventListener('click', (event) => {
		const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-team-remove],[data-team-rename-start]');
		if (!node || !isHost) return;
		if (node.dataset.teamRemove) hostMutate((state) => L.removeTeam(state, node.dataset.teamRemove ?? ''), null);
		else if (node.dataset.teamRenameStart) {
			renamingTeamId = node.dataset.teamRenameStart;
			renderTeams();
		}
	});

	dom.lobbyList.addEventListener('click', (event) => {
		const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-join-code]');
		if (!button?.dataset.joinCode) return;
		dom.joinCode.value = button.dataset.joinCode;
		dom.joinPassword.value = '';
		dom.joinPassword.focus();
		dom.joinForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});

	// 两个全屏目标在这里登记，按钮文案由 syncFullscreenLabels 统一维护。
	FULLSCREEN = [
		{ node: document.documentElement, button: dom.pageFullscreen, enterLabel: '网页全屏', exitLabel: '退出全屏' },
		{
			node: dom.teamStage,
			button: dom.teamFullscreen,
			enterLabel: '全屏展示',
			exitLabel: '退出全屏',
			fauxClass: 'is-faux-fullscreen',
		},
	];
	for (const spec of FULLSCREEN) {
		// 网页全屏没有退化方案：浏览器不支持就别摆一个点了没反应的按钮。
		if (spec.fauxClass === undefined && typeof spec.node.requestFullscreen !== 'function') {
			spec.button.hidden = true;
			continue;
		}
		spec.button.addEventListener('click', () => setFullscreen(spec, !fullscreenActive(spec)));
	}
	// Esc 退出全屏由浏览器负责；固定定位那个退化模式得自己接。
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') exitAllFullscreen();
	});
	document.addEventListener('fullscreenchange', syncFullscreenLabels);

	dom.roomCopy.addEventListener('click', () => {
		const url = `${location.origin}${location.pathname}${HASH_PREFIX}${roomCode}`;
		void copyText(url, dom.roomCopy);
	});
	dom.roomLeave.addEventListener('click', () => void leaveRoom());

	window.addEventListener('hashchange', () => {
		const code = codeFromHash();
		if (code === roomCode) return;
		// 在房间里改地址栏（或按浏览器后退）：先干净地退出，回到设置页。
		if (roomCode) {
			void leaveRoom();
			if (code) dom.joinCode.value = code;
			return;
		}
		if (code) {
			dom.joinCode.value = code;
			dom.joinPassword.focus();
		}
	});

	// 关页面/刷新时告诉房主我走了：WebRTC 自己有断线检测，但那要等好几秒，
	// 不打招呼的话名册里会留一个幽灵，房间里的人会以为你还在。
	window.addEventListener('pagehide', () => {
		if (!isHost && roomActions) void roomActions.bye.send(null);
	});
}

async function submitJoin(): Promise<void> {
	setFormError(dom.joinForm, null);
	const code = L.normalizeCode(dom.joinCode.value);
	if (!L.isValidCode(code)) {
		setFormError(dom.joinForm, '房间码是 5 位，字母和数字，不含 0、1、I、L、O。');
		return;
	}
	const password = dom.joinPassword.value;
	const issue = L.passwordIssue(password);
	if (issue) {
		setFormError(dom.joinForm, issue);
		return;
	}
	const name = resolveName(dom.joinForm);
	if (!name) return;

	// 先在这一页把密码验证掉：验证期间按钮禁用，失败了错误就写在这张卡片下面。
	setJoinPending(true);
	const result = await enterRoom({ code, password, asHost: false, defer: true });
	setJoinPending(false);
	if (!result.ok) setFormError(dom.joinForm, result.error);
}

let joinHintTimer = 0;

/**
 * 「先验证密码」期间的按钮状态。
 *
 * 4 秒还没结果就把文案换成「还在等房主回应…」：密码对、房主在的话通常一两秒就结束了，
 * 超过几秒多半是在等一个不会来的回应，得让人知道不是卡死了。
 */
function setJoinPending(on: boolean): void {
	window.clearTimeout(joinHintTimer);
	dom.joinSubmit.disabled = on;
	dom.joinSubmit.textContent = on ? '正在验证密码…' : '加入房间';
	if (!on) return;
	joinHintTimer = window.setTimeout(() => {
		if (pendingJoin) dom.joinSubmit.textContent = '还在等房主回应…';
	}, 4000);
}

async function submitCreate(): Promise<void> {
	setFormError(dom.createForm, null);
	const nameIssue = L.roomNameIssue(dom.createName.value);
	if (nameIssue) {
		setFormError(dom.createForm, nameIssue);
		return;
	}
	const passwordIssue = L.passwordIssue(dom.createPassword.value);
	if (passwordIssue) {
		setFormError(dom.createForm, passwordIssue);
		return;
	}
	const nickname = await resolveName(dom.createForm);
	if (!nickname) return;
	await enterRoom({
		code: L.randomCode(cryptoRand),
		password: dom.createPassword.value,
		asHost: true,
		name: L.sanitizeName(dom.createName.value),
	});
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
	const original = button.textContent ?? '';
	try {
		await navigator.clipboard.writeText(text);
		button.textContent = '已复制邀请链接';
	} catch {
		// 非 HTTPS 或没给剪贴板权限：退回到「选中让用户自己复制」。
		window.prompt('复制这个邀请链接发给队友：', text);
	}
	window.setTimeout(() => {
		button.textContent = original;
	}, 2000);
}

// ---------------------------------------------------------------- 启动

function startTicker(): void {
	// 一个 5 秒的节拍同时干三件事：剔除过期的房间、按需重播、刷新网络状态。
	window.setInterval(() => {
		if (lobbyAsHost) {
			if (Date.now() - lastAnnounceAt > ANNOUNCE_MS) announceNow();
		} else if (lobbyRoom && lobbyEntries.size > 0) {
			renderLobby();
		}
		renderNet();
	}, 5000);
}

function restoreNickname(): void {
	try {
		const name = L.sanitizeName(localStorage.getItem(NICK_KEY) ?? '');
		const avatar = localStorage.getItem(AVATAR_KEY) ?? '';
		if (!name) return;
		if (dom.nickname) dom.nickname.value = name;
		// 未登录时它就是我的房间昵称。先填上，这样刷新页面能自动回到房间里，不用再手打一次。
		// 已登录的话 `readIdentityFromDom()` 已经填过 identity，这里不要覆盖成手填的名字。
		if (!steamUser) identity = { name, avatar };
	} catch {
		// 隐私模式下读不到，进房时再输一次即可。
	}
}

function boot(): void {
	restoreNickname();
	bindEvents();
	startTicker();
	// 大厅只在这里加入一次，之后再也不动它（角色切换只是开播 / 停播）。
	joinLobby();

	const code = codeFromHash();
	const session = readSession();

	if (code) dom.joinCode.value = code;

	/*
	 * 刷新页面后自动回到原来的房间：
	 * - 成员：凭 sessionStorage 里的房间码与密码重新握手，会拿到房主那边最新的队伍分配；
	 * - 房主：房间状态只在他自己的内存里，所以要按原样重建（同码、同名、同密码），
	 *   其他人会在各自的重连窗口里自动回来。
	 * 没有昵称（未登录且没存过）时不自动进房，否则房间里会多一个「无名氏」。
	 */
	if (session && session.code === code && (identity.name || session.asHost)) {
		void enterRoom(session);
	} else {
		showSetup();
		if (code) dom.joinPassword.focus();
	}

	renderNet();
}

boot();
