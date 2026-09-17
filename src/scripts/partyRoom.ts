import * as L from '../lib/partyLogic';
import type { ChatMessage, Member, RoomState, Team } from '../lib/partyLogic';
import type { ClientMessage, LobbyRoom, TeamOp } from '../lib/partyProtocol';
import { decodeLobbyMessage, decodeServerMessage, encodeMessage } from '../lib/partyProtocol';

/**
 * 开黑房间的客户端逻辑。
 *
 * 传输是**一条 WebSocket 到本站自己的 Worker**，房间状态放在 Durable Object 里
 * （`src/worker/partyRoom.ts`）。早先用的是 Trystero 的 P2P：局域网内没问题，但跨网络要靠
 * 打洞，国内手机流量大量是对称 NAT，最后得架 TURN、还要看云安全组放不放 UDP——
 * 那条链上的每一环都能让「进不了房间」，而失败的样子永远只是「房间里没人」。
 *
 * 三条贯穿全文的约定：
 *
 * 1. **服务端是唯一权威。** 客户端只做两件事：把操作发上去、把收到的快照画出来。
 *    分队、roll、权限判断全在 Durable Object 里（用的还是 `partyLogic.ts`），
 *    所以这边没有「房主本地先改再广播」那套，也就没有快照冲突。
 * 2. **密码在服务端校验。** 房间里存的是密码的 SHA-256，进房时比对；对了才把人写进名册。
 *    浏览器这边只负责把密码发出去。
 * 3. **遇到失败要说人话。** 断线、密码错、房间没了，服务端都会给出明确的 code，
 *    页面按 code 说人话（见 `onSocketError`）。
 */

// ---------------------------------------------------------------- 常量

const HASH_PREFIX = '#/r/';

/** 房间与大厅的 WebSocket 端点（见 src/worker/index.ts 的路由）。 */
const ROOM_WS_PATH = '/api/party/room/';
const LOBBY_WS_PATH = '/api/party/rooms';

/** 断线重连的退避节奏：先快后慢，页面回到前台会立刻重试一次。 */
const RECONNECT_DELAYS_MS = [600, 1200, 2500, 5000, 10_000, 20_000];
/**
 * 进房握手的等待上限。
 *
 * 一条 WebSocket + 一次 `join`/`joined` 往返通常一两秒就完事；12 秒还没动静，
 * 基本是网络进不去 Worker（比如公司网拦了 WebSocket），没必要让人一直盯着禁用的按钮。
 */
const JOIN_VERIFY_MS = 12_000;
/** 心跳间隔。服务端只做回声，用来尽早发现「连接其实已经死了」。 */
const PING_MS = 25_000;

const NICK_KEY = 'dota2-party/nickname';
/**
 * 手填 Steam ID 换来的头像，单独存一份。
 * 不存的话刷新页面头像就退回昵称首字母了——人还在房间里，头像却变了，很怪。
 */
const AVATAR_KEY = 'dota2-party/avatar';
const ROOM_KEY = 'dota2-party/room';
/** 标签页级标识：刷新不变，重连时服务端据此认出「是同一个人回来了」。 */
const CLIENT_ID_KEY = 'dota2-party/client';

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

/** 刷新页面时用来重新进房。 */
type RoomSession = { code: string; password: string; asHost: boolean; name?: string };

/** 进房结果。`defer` 模式下要等服务端确认了才有结论。 */
type EnterResult = { ok: true } | { ok: false; error: string };

/** 正在等 `join` 的回应时挂着的那个 Promise（见 enterRoom 末尾）。 */
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
	teamPageFullscreen: $<HTMLButtonElement>('#team-page-fullscreen'),
	teamApiFullscreen: $<HTMLButtonElement>('#team-api-fullscreen'),
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

let roomCode = '';
let isHost = false;
/** 服务端推来的最后一份快照。所有人都是这个角色，没有「房主本地状态」这一说。 */
let room: RoomState | null = null;
let chat: ChatMessage[] = [];
/** 服务端分配给我的 id（就是进房时带上去的 clientId）。 */
let selfId = '';

/** 大厅里的房间列表，服务端推什么就是什么。 */
let lobbyRooms: LobbyRoom[] = [];
/** 改名中的队（房主点「改名」后临时把标题换成输入框）。 */
let renamingTeamId: string | null = null;

/**
 * 两个 WebSocket：一个连大厅（只收房间列表），一个连自己的房间。
 *
 * 都是「断了就按退避重连，回来之后自动重发 join」——这是唯一一条传输，
 * 所以重连逻辑必须写扎实：房间那边拿同一个 clientId 重连，服务端认得出是同一个人，
 * 名册、队伍位置、房主身份都还在。
 */
type SocketKind = 'lobby' | 'room';

let lobbySocket: WebSocket | null = null;
let roomSocket: WebSocket | null = null;
let roomSocketRetry = 0;
let lobbySocketRetry = 0;
let reconnectTimer = 0;
let pingTimer = 0;
/** 主动离开期间不要重连（close 事件分不清「断了」和「我自己关的」）。 */
let leaving = false;
/** 进房时记下参数，重连要用同一份。 */
let joinIntent: { password: string; asHost: boolean; name?: string } | null = null;

/** 每个标签页一个稳定的标识：刷新不变（sessionStorage），但两个标签页互不影响。 */
function clientId(): string {
	const cached = sessionStorage.getItem(CLIENT_ID_KEY);
	if (cached && /^[A-Za-z0-9_-]{8,64}$/.test(cached)) return cached;
	const bytes = new Uint8Array(9);
	crypto.getRandomValues(bytes);
	const generated = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	sessionStorage.setItem(CLIENT_ID_KEY, generated);
	return generated;
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
 * 大厅：一条 WebSocket 到 `/api/party/rooms`，服务端（Durable Object）推房间列表。
 *
 * 以前大厅是「所有人 P2P 全网状、房主每 15 秒播报一次自己的房间、两分钟没动静就当过期」。
 * 那套的复杂度全来自「没人知道有哪些房间」；房间搬到服务端之后，列表是它自己知道的，
 * 于是那堆定时器与去重逻辑一起消失了。
 */
/**
 * 大厅：连上本站的一条 WebSocket，服务端推什么列表就画什么。
 *
 * 以前那套「房主每 15 秒重播一次自己的房间、2 分钟没动静就从列表里剔除」的定时器全删了——
 * 房间在服务端，人数是它自己知道的。
 */
function connectLobby(): void {
	if (lobbySocket && lobbySocket.readyState <= WebSocket.OPEN) return;
	const socket = new WebSocket(wsUrl(LOBBY_WS_PATH));
	lobbySocket = socket;
	socket.addEventListener('open', () => {
		lobbySocketRetry = 0;
		renderNet();
	});
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') return;
		const message = decodeLobbyMessage(event.data);
		if (!message) return;
		lobbyRooms = [...message.rooms].sort((a, b) => b.at - a.at);
		renderLobby();
		renderNet();
	});
	socket.addEventListener('close', () => {
		if (lobbySocket === socket) lobbySocket = null;
		renderNet();
		scheduleReconnect('lobby');
	});
	// 出错之后 close 一定会来，重连交给上面那支。
	socket.addEventListener('error', () => undefined);
}

function wsUrl(path: string): string {
	const url = new URL(path, location.origin);
	url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

/** 断线重连：按退避节奏排下一次，页面回到前台时也会主动来一发。 */
function scheduleReconnect(kind: SocketKind): void {
	if (kind === 'lobby') {
		const delay = RECONNECT_DELAYS_MS[Math.min(lobbySocketRetry, RECONNECT_DELAYS_MS.length - 1)];
		lobbySocketRetry += 1;
		window.setTimeout(connectLobby, delay);
		return;
	}
	if (!roomCode) return;
	const delay = RECONNECT_DELAYS_MS[Math.min(roomSocketRetry, RECONNECT_DELAYS_MS.length - 1)];
	roomSocketRetry += 1;
	window.clearTimeout(reconnectTimer);
	reconnectTimer = window.setTimeout(() => {
		if (roomCode) openRoomSocket();
	}, delay);
}

function renderLobby(): void {
	const entries = lobbyRooms;

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
	/** 加入别人的房间时用：先留在设置页等 `joined`，拿到才切界面。 */
	defer?: boolean;
}): Promise<EnterResult> {
	if (pendingJoin) settleJoin({ ok: false, error: '上一次加入还没结束，请重试。' });
	if (roomCode) await leaveRoom({ silent: true });

	roomCode = options.code;
	joinIntent = { password: options.password, asHost: options.asHost, name: options.name };
	roomSocketRetry = 0;
	isHost = false;
	selfId = '';
	room = null;
	chat = [];
	setNotice(null);
	// defer 模式先不切界面：密码不对、房间没了，服务端会立刻回一条 error，
	// 这时把人丢进一个空房间没有意义（见文件末尾那个 Promise）。
	if (!options.defer) showRoom();
	renderRoom();
	setNotice(options.asHost ? '正在建房…' : '正在连接房间…', 'info', true);
	openRoomSocket();

	writeSession({ code: options.code, password: options.password, asHost: options.asHost, name: options.name });
	if (codeFromHash() !== options.code) history.replaceState(null, '', `${location.pathname}${HASH_PREFIX}${options.code}`);

	if (!options.defer) return { ok: true };
	return new Promise<EnterResult>((resolve) => {
		pendingJoin = {
			resolve,
			timer: window.setTimeout(() => {
				settleJoin({
					ok: false,
					error:
						'一直没连上房间服务。最可能是这条网络把 WebSocket 拦了（公司网、校园网、部分公共 WiFi 常见），换个网络（比如手机热点）再试；房间码/密码写错的话服务端会直接告诉你，不会等到超时。',
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

/** 进房要发的那条消息。重连时重发同一条（clientId 不变，服务端认得出是同一个人）。 */
function joinMessage(): ClientMessage {
	const intent = joinIntent;
	return {
		t: 'join',
		clientId: clientId(),
		name: identity.name,
		avatar: identity.avatar,
		password: intent?.password ?? '',
		create: intent?.asHost ? { name: intent.name ?? identity.name } : undefined,
	};
}

/**
 * 开一条房间 WebSocket，连上就发 `join`。
 *
 * 重连也走这里。服务端按 clientId 认人：刷新、断网重来都还是名册里的同一位，
 * 队伍位置与 roll 结果不会丢——这正是当初 P2P 方案里最难处理的那部分。
 */
function openRoomSocket(): void {
	if (!roomCode || !joinIntent || leaving) return;
	if (roomSocket && roomSocket.readyState <= WebSocket.OPEN) return;
	const socket = new WebSocket(wsUrl(`${ROOM_WS_PATH}${encodeURIComponent(roomCode)}`));
	roomSocket = socket;
	socket.addEventListener('open', () => {
		roomSocketRetry = 0;
		window.clearInterval(pingTimer);
		pingTimer = window.setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) socket.send(encodeMessage({ t: 'ping' }));
		}, PING_MS);
		socket.send(encodeMessage(joinMessage()));
		renderNet();
	});
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') return;
		const message = decodeServerMessage(event.data);
		if (!message) return;
		handleRoomMessage(message);
	});
	socket.addEventListener('close', () => {
		if (roomSocket === socket) roomSocket = null;
		window.clearInterval(pingTimer);
		if (leaving || !roomCode) return;
		setNotice('和房间的连接断了，正在重连…', 'warn', true);
		renderNet();
		scheduleReconnect('room');
	});
	// 出错之后 close 一定会来。
	socket.addEventListener('error', () => undefined);
}

/** 服务端推来的消息。三种：进房成功、状态快照、错误。 */
function handleRoomMessage(message: ReturnType<typeof decodeServerMessage> & object): void {
	if (!roomCode) return;
	if (message.t === 'pong') return;
	if (message.t === 'error') {
		onSocketError(message.code, message.message);
		return;
	}
	if (message.state.code !== roomCode) return;
	room = message.state;
	chat = message.chat;
	selfId = message.t === 'joined' ? message.selfId : selfId;
	isHost = room.hostId === selfId;
	dom.chatInput.disabled = false;
	setNotice(null);
	renderRoom();
	renderChat();
	renderNet();
	if (message.t === 'joined' && pendingJoin) {
		settleJoin({ ok: true });
		showRoom();
	}
}

function sendToRoom(message: ClientMessage): boolean {
	if (roomSocket?.readyState !== WebSocket.OPEN) return false;
	roomSocket.send(encodeMessage(message));
	return true;
}

/** 服务端明确拒绝时的文案。每种情况都不一样，别混成一句「连不上」。 */
function onSocketError(code: string, detail?: string): void {
	const text =
		code === 'bad-password'
			? '密码不对：这个房间的密码和房主设的不一样。回去问一下房主，顺便确认房间码没念错。'
			: code === 'room-not-found'
				? '房间不存在了：房主可能已经关掉，或者房间码抄错了。'
				: code === 'too-many-messages'
					? '消息发得太快，连接被服务端断开了。等一下再进。'
					: (detail ?? '服务端拒绝了这次操作。');

	if (pendingJoin) {
		settleJoin({ ok: false, error: text });
		void leaveRoom({ silent: true });
		return;
	}
	setNotice(text, 'error', true);
}

async function leaveRoom(options: { silent?: boolean } = {}): Promise<void> {
	if (isHost && !options.silent) {
		const confirmed = window.confirm('离开房间？你走之后房主会交给房间里最早加入的那个人。');
		if (!confirmed) return;
	}
	// 先置位再关连接：close 回调看到 leaving 就不会排重连。
	leaving = true;
	window.clearTimeout(reconnectTimer);
	window.clearInterval(pingTimer);
	const socket = roomSocket;
	roomSocket = null;
	joinIntent = null;
	roomCode = '';
	isHost = false;
	selfId = '';
	room = null;
	chat = [];
	renamingTeamId = null;
	setNotice(null);
	writeSession(null);
	history.replaceState(null, '', location.pathname);
	if (socket) {
		try {
			socket.close(1000, '主动离开');
		} catch {
			// 已经断了。
		}
	}
	showSetup();
	leaving = false;
	// 列表上的人数是服务端给的，刚摘掉自己，重连一次拿最新的。
	connectLobby();
	renderNet();
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
	/*
	 * 传输只有两条 WebSocket，所以「连上没有」这件事本身就是能直接问出来的：
	 * 大厅那条决定房间列表更不更新，房间那条决定你的操作发不发得出去。
	 */
	const lobbyOnline = lobbySocket?.readyState === WebSocket.OPEN;
	const roomOnline = roomSocket?.readyState === WebSocket.OPEN;

	dom.netDot.className = `h-2 w-2 shrink-0 rounded-full ${lobbyOnline || roomOnline ? 'bg-[#22c55e]' : 'bg-faint'}`;
	dom.netText.textContent = roomCode
		? roomOnline
			? '已连上房间'
			: '正在重连房间…'
		: lobbyOnline
			? '已连上大厅'
			: '正在连接…';

	const parts: string[] = [];
	if (roomCode && room) {
		parts.push(`房间内 ${room.members.length} 人`);
		parts.push(isHost ? '你是房主' : `房主是 ${L.memberById(room, room.hostId)?.name ?? '—'}`);
	} else {
		parts.push(lobbyRooms.length > 0 ? `${lobbyRooms.length} 个房间在等人` : '当前没有房间');
	}
	parts.push('走本站的 WebSocket，房间状态存在服务端');
	dom.netDetail.textContent = parts.join(' · ');
}

function renderRoom(): void {
	if (!room) {
		// 还没拿到快照：只把头部的房间码显示出来，其余留空，避免闪出一堆空面板。
		dom.roomTitle.textContent = isHost ? '正在建房…' : '正在连接…';
		dom.roomCode.textContent = roomCode;
		dom.roomCount.textContent = '';
		dom.roomRole.textContent = isHost ? '房主' : '';
		clearDrag();
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
	// 重建会把拖拽用到的节点一起换掉（拖拽中的卡片、高亮中的放置区都会成为孤儿），
	// 所以先把拖拽状态清干净：宁可让正在拖的人重拖一次，也不要留下一个指向幽灵的 memberId。
	clearDrag();
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
	// 空闲池也是一个放置区：把队里的人拖回来就是「退出队伍」（`moveMember` 的 teamId 为 null）。
	pool.dataset.dropPool = '';
	const head = h('div', 'flex items-baseline gap-2');
	const canDragSelf = free.some((member) => member.id === selfId);
	const hint = isHost ? ' · 拖 ⋮⋮ 到队伍，或用下拉' : canDragSelf ? ' · 拖 ⋮⋮ 或下拉归队' : '';
	head.append(
		h('h3', 'font-display text-sm text-muted', '空闲池'),
		h('span', 'text-xs text-faint', `${free.length} 人${hint}`),
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
	// 放置区的标记放在整张卡上：拖到卡片里的任何位置都算拖到这个队。
	card.dataset.dropTeam = team.id;

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
			sendToRoom({ t: 'team', op: { kind: 'rename', teamId: team.id, name: next } });
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

/**
 * 拖拽手柄。
 *
 * `draggable` 只挂在这个小小的手柄上，**整张卡片不挂**：卡片里嵌着归队用的 `<select>`
 * （还有队长的改名输入框），祖先带 `draggable` 之后那些控件在部分浏览器里点不动、选不中文本。
 * 拖影另说——`dragstart` 里用 `setDragImage()` 换成整张卡，手感还是「拖着这个人走」。
 */
function dragHandle(member: Member): HTMLElement {
	const grip = h(
		'span',
		'shrink-0 cursor-grab select-none px-0.5 text-[11px] leading-none tracking-tighter text-faint transition hover:text-cream',
		'⋮⋮',
	);
	grip.draggable = true;
	grip.dataset.memberDrag = member.id;
	grip.title = `拖动 ${member.name} 归队`;
	// 纯鼠标的快捷方式，等价操作是右边的下拉；不放进无障碍树，免得读屏念一串点。
	grip.setAttribute('aria-hidden', 'true');
	return grip;
}

function memberCard(state: RoomState, member: Member): HTMLElement {
	const item = h('li', 'flex items-center gap-2 rounded-lg border border-line bg-ink-2 px-2 py-1.5');
	item.dataset.memberId = member.id;

	// 房主能挪任何人，其他人只能挪自己。下拉和拖拽共用这一个判断。
	const editable = isHost || member.id === selfId;
	if (editable) item.append(dragHandle(member));

	item.append(avatarNode(member.name, member.avatar, 24));

	const name = h('span', 'min-w-0 flex-1 truncate text-sm text-cream', member.name);
	if (member.id === selfId) name.classList.add('font-medium');
	item.append(name);

	if (member.id === state.hostId) item.append(h('span', 'shrink-0 rounded bg-surface-3 px-1 text-[10px] text-gold', '房主'));

	const roll = state.rolls[member.id];
	if (roll) item.append(h('span', 'shrink-0 text-xs tabular-nums text-gold', String(roll.value)));

	/*
	 * 归队仍然保留这个 <select>：拖拽在触屏和键盘上都没有等价操作，而下拉天然三端可用。
	 * 换句话说 ⋮⋮ 手柄只是给鼠标加的一条快路，**不是唯一的路**，权限也完全一样（见 editable）。
	 */
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

// ---------------------------------------------------------------- 拖拽归队

/**
 * 把空闲池里的人拖到队伍卡片上归队（反过来也能把队里的人拖回空闲池或另一个队）。
 *
 * HTML5 拖拽是个「只有两头」的接口：`dragstart` 里放数据、`dragover` 里决定接不接受，
 * **中间不回调**。所以「现在拖的是谁」「当前高亮的是哪个放置区」只能自己拿变量记。
 * 权限和下拉完全一致（房主挪任何人，其他人挪自己），走的是同一个 `moveMemberTo()`。
 */
let draggingMemberId: string | null = null;
let draggingCard: HTMLElement | null = null;
let activeDropZone: HTMLElement | null = null;

/** 拖起来的那张卡淡化；垫在下面的放置区加一圈高亮。两个类名都在 liveWall.ts 里用过。 */
const DRAG_SOURCE_CLASS = ['opacity-50'];
const DROP_ZONE_CLASS = ['ring-2', 'ring-dota'];

/** 命中的放置区：队伍卡（`data-drop-team`）或空闲池（`data-drop-pool`）。 */
function dropZoneOf(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>('[data-drop-team],[data-drop-pool]') : null;
}

/** 放置区对应的队伍 id；空闲池是 `null`（`moveMember` 用它表示「退到空闲」）。 */
function dropZoneTeam(zone: HTMLElement): string | null {
	return zone.dataset.dropTeam ?? null;
}

/**
 * 清掉全部拖拽痕迹。
 *
 * 除了 `dragend`，**重新渲染队伍区时也必须调**：`replaceChildren()` 会把拖拽的源节点从
 * 文档里摘掉，浏览器随即中止这次拖拽，而 `dragend` 落在一个已经脱离文档的节点上、冒泡不到
 * `document`——不主动清，`draggingMemberId` 就会永远停在那个幽灵身上。
 */
function clearDrag(): void {
	activeDropZone?.classList.remove(...DROP_ZONE_CLASS);
	activeDropZone = null;
	draggingCard?.classList.remove(...DRAG_SOURCE_CLASS);
	draggingCard = null;
	draggingMemberId = null;
}

/** 高亮当前放置区。`dragover` 是连续触发的，这样写就不用管 dragleave 在子元素间乱跳的老问题。 */
function setDropZone(zone: HTMLElement | null): void {
	if (zone === activeDropZone) return;
	activeDropZone?.classList.remove(...DROP_ZONE_CLASS);
	activeDropZone = zone;
	activeDropZone?.classList.add(...DROP_ZONE_CLASS);
}

/**
 * 挪人。下拉和拖拽共用这一条路径，免得两条路的权限或提示走偏。
 * 一律发给服务端：它自己判断「挪自己随时行、挪别人得是房主」，客户端不做权威判断。
 */
function moveMemberTo(memberId: string, teamId: string | null): void {
	if (!room) return;
	if (!L.memberById(room, memberId)) return;
	if ((L.teamOf(room, memberId)?.id ?? null) === teamId) return; // 已经在那儿了，白跑一趟
	const team = teamId ? room.teams.find((item) => item.id === teamId) : undefined;
	if (teamId && !team) return;

	/*
	 * 队满时 `moveMember` 会原样返回，一个字都不说。在下拉里这最多算「选项没生效」，
	 * 在拖拽里就是「我明明拖过去了，它自己弹回来」——所以自己先判一次，并把话说清楚。
	 */
	if (team && team.members.length >= room.teamSize) {
		setNotice(`${team.name} 已经满 ${room.teamSize} 人了：先调高「每队上限」，或把人挪到别的队。`, 'warn');
		return;
	}

	sendToRoom({ t: 'move', memberId, teamId });
}

function bindMemberDrag(): void {
	document.addEventListener('dragstart', (event) => {
		const grip =
			event.target instanceof Element ? event.target.closest<HTMLElement>('[data-member-drag]') : null;
		const memberId = grip?.dataset.memberDrag;
		if (!grip || !memberId || !event.dataTransfer) return;

		draggingMemberId = memberId;
		draggingCard = grip.closest<HTMLElement>('li[data-member-id]');
		// 不设数据的话 Firefox 根本不肯开始拖，哪怕我们只读自己的变量。
		event.dataTransfer.setData('text/plain', (room && L.memberById(room, memberId)?.name) || '');
		event.dataTransfer.effectAllowed = 'move';
		// 拖影取整张卡片（手柄太小，捏着两个点飞不太像「拖着一个人」），
		// 所以必须在加淡化类**之前**拍快照。
		if (draggingCard) event.dataTransfer.setDragImage(draggingCard, 16, 16);
		const card = draggingCard;
		window.setTimeout(() => card?.classList.add(...DRAG_SOURCE_CLASS), 0);
	});

	document.addEventListener('dragover', (event) => {
		if (!draggingMemberId || !room) return;
		const zone = dropZoneOf(event.target);
		if (!zone) {
			setDropZone(null);
			return;
		}
		// 必须 preventDefault：不调的话浏览器认为这里不接受放置，`drop` 压根不会触发
		// （表现是「拖过去松手，什么都没发生，也不报错」）。
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		// 只高亮「放下会真的改变什么」的目标：把人拖回他已经在的队/池，等于没动。
		const to = dropZoneTeam(zone);
		setDropZone(to === (L.teamOf(room, draggingMemberId)?.id ?? null) ? null : zone);
	});

	document.addEventListener('drop', (event) => {
		// 先取值再清状态：下面这次移动会触发 renderRoom()，那里还会再清一遍。
		const memberId = draggingMemberId;
		const zone = dropZoneOf(event.target);
		if (!memberId || !zone) {
			clearDrag();
			return;
		}
		event.preventDefault();
		clearDrag();
		moveMemberTo(memberId, dropZoneTeam(zone));
	});

	// 拖拽没落在任何放置区（按 Esc、拖到页面外、拖回原处）：也得清，否则高亮会留在页面上。
	document.addEventListener('dragend', clearDrag);
}

// ---------------------------------------------------------------- 全屏

/**
 * 队伍分配区的两种「全屏」。它们机制不同、给人的感觉也不同，所以是两个按钮而不是一个：
 *
 * - **浏览器全屏**（`#team-api-fullscreen`）：Fullscreen API。浏览器收起自己的界面
 *   （地址栏、标签页），效果和 F11 一样，Esc 由浏览器负责退出；
 * - **网页全屏**（`#team-page-fullscreen`）：纯 CSS 固定定位，把这一块盖满**当前视口**。
 *   浏览器界面照旧、页面还在后面，Esc 由下面绑的 keydown 接住。
 *
 * 两者互斥：进一个就先把另一个退掉，免得出现「一个固定定位的元素同时又是全屏元素」这种叠加态。
 * 页面全屏（整个 `<html>` 走 API）不做：那是浏览器全屏的整页版，跟这两个不是一回事。
 */
const PAGE_FULLSCREEN_CLASS = 'is-page-fullscreen';

function stageApiFullscreen(): boolean {
	return document.fullscreenElement === dom.teamStage;
}

function stagePageFullscreen(): boolean {
	return dom.teamStage.classList.contains(PAGE_FULLSCREEN_CLASS);
}

function syncFullscreenLabels(): void {
	const api = stageApiFullscreen();
	dom.teamApiFullscreen.textContent = api ? '退出浏览器全屏' : '浏览器全屏';
	dom.teamApiFullscreen.setAttribute('aria-pressed', String(api));

	const page = stagePageFullscreen();
	dom.teamPageFullscreen.textContent = page ? '退出网页全屏' : '网页全屏';
	dom.teamPageFullscreen.setAttribute('aria-pressed', String(page));
}

/**
 * 网页全屏：固定定位盖住视口。
 *
 * 同时给 `body` 加一个类锁住页面滚动（见 global.css）——不锁的话，当前面的内容比视口矮时
 * 滚轮会穿透过去滚后面的页面，看起来像是全屏区域在乱动。
 */
function setPageFullscreen(on: boolean): void {
	if (on && stageApiFullscreen()) void document.exitFullscreen();
	dom.teamStage.classList.toggle(PAGE_FULLSCREEN_CLASS, on);
	document.body.classList.toggle('is-stage-page-fullscreen', on);
	syncFullscreenLabels();
}

/** 浏览器全屏：不支持元素级全屏的浏览器（典型是 iPad Safari）直接退回网页全屏。 */
function setApiFullscreen(on: boolean): void {
	if (typeof dom.teamStage.requestFullscreen !== 'function') {
		setPageFullscreen(on);
		return;
	}
	if (on) {
		setPageFullscreen(false);
		// 浏览器也可能拒绝（比如不是用户手势触发的），那就退回网页全屏，别让按钮点了没反应。
		const pending = dom.teamStage.requestFullscreen() as Promise<void> | undefined;
		void pending?.catch(() => setPageFullscreen(true)).finally(syncFullscreenLabels);
		return;
	}
	if (stageApiFullscreen()) void document.exitFullscreen();
	syncFullscreenLabels();
}

/**
 * 退出队伍区的两种全屏。离房时要调：这块在房间界面里，界面一藏，全屏的就只剩一片空。
 */
function exitStageFullscreen(): void {
	if (stageApiFullscreen()) void document.exitFullscreen();
	if (stagePageFullscreen()) setPageFullscreen(false);
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
		// 不本地先画：消息会随服务端推回来的快照一起到，本地插一条反而要处理「重发了怎么办」。
		sendToRoom({ t: 'chat', text });
	});

	dom.rollBtn.addEventListener('click', () => {
		if (!room) return;
		// 点数由服务端摇，客户端连随机数都不用参与——否则每个人算出来都不一样。
		sendToRoom({ t: 'roll' });
	});

	dom.teamSize.addEventListener('change', () => {
		if (!isHost) return;
		sendToRoom({ t: 'team', op: { kind: 'size', size: Number(dom.teamSize.value) } });
	});
	dom.autoAssign.addEventListener('change', () => {
		if (!isHost) return;
		sendToRoom({ t: 'team', op: { kind: 'autoAssign', on: dom.autoAssign.checked } });
	});

	// 房主工具：按钮分散在几处，统一用事件委托。
	document.addEventListener('click', (event) => {
		const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-host-tool]');
		if (!target || !isHost) return;
		const tool = target.dataset.hostTool as TeamOp['kind'] | undefined;
		if (!tool) return;
		// 这几个都没有参数，`kind` 直接对上协议里的 `kind`，省一层映射。
		if (tool === 'autoForm' || tool === 'randomize' || tool === 'byRoll' || tool === 'addTeam' || tool === 'clearRolls') {
			sendToRoom({ t: 'team', op: { kind: tool } });
		}
	});

	// 归队：队伍区和空闲池里各有一个下拉，两者是同一件事，所以合并成一个委托监听
	//（`#team-stage` 同时罩着这两块），并且和拖拽共用 `moveMemberTo()`。
	dom.teamStage.addEventListener('change', (event) => {
		const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-member-id]');
		if (!select) return;
		moveMemberTo(select.dataset.memberId ?? '', select.value || null);
	});

	bindMemberDrag();

	document.addEventListener('click', (event) => {
		const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-team-remove],[data-team-rename-start]');
		if (!node || !isHost) return;
		if (node.dataset.teamRemove) sendToRoom({ t: 'team', op: { kind: 'remove', teamId: node.dataset.teamRemove } });
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

	dom.teamPageFullscreen.addEventListener('click', () => setPageFullscreen(!stagePageFullscreen()));
	dom.teamApiFullscreen.addEventListener('click', () => setApiFullscreen(!stageApiFullscreen()));
	// Esc：网页全屏靠这里退（浏览器全屏那边浏览器自己会处理，这里再调一次是空操作）。
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') exitStageFullscreen();
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

	// 关页面/刷新时把连接关干净：服务端收到 close 就把人从名册里摘掉，
	// 不用等心跳超时（否则别人要过十几秒才看到你走了）。
	window.addEventListener('pagehide', () => {
		try {
			roomSocket?.close(1000, '页面关闭');
		} catch {
			// 已经断了。
		}
	});

	/*
	 * 回到前台立刻补一次：隐藏期间浏览器会掐掉/冻结连接，回来时重连一次比等退避计时器快得多。
	 */
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) return;
		connectLobby();
		if (roomCode && roomSocket?.readyState !== WebSocket.OPEN) openRoomSocket();
		renderNet();
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
/**
 * 5 秒节拍只做两件事：刷新网络状态、必要时把断掉的连接捞回来。
 *
 * 房间列表不用它管——服务端推什么就是什么，没有过期时间要算。
 */
function startTicker(): void {
	window.setInterval(() => {
		if (!lobbySocket || lobbySocket.readyState > WebSocket.OPEN) connectLobby();
		if (roomCode && (!roomSocket || roomSocket.readyState > WebSocket.OPEN)) openRoomSocket();
		renderNet();
	}, 5000);
}
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
	// 大厅连接只在这里建一次，之后断了会自动重连。
	connectLobby();

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
