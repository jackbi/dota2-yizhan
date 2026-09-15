/**
 * 开黑房间的纯逻辑：成员、队伍、roll 的状态变换全在这里。
 *
 * 这一层刻意**不碰 DOM、不碰 WebRTC**，因为房间的坑几乎都在状态上而不是在传输上：
 * 「按人数和每队上限自动生成队伍」在有人被手动挪过之后怎么收敛、房主把上限从 5 调到 2
 * 时超员的人去哪、队被删掉后里面的人是不是跟着消失——这些都必须能脱离浏览器验证。
 * 传输层（partyRoom.ts）只负责把这里算出来的快照广播出去。
 *
 * 约定：
 * - **所有函数都是纯的**，接收旧状态、返回新状态，不改入参。
 * - **唯一权威是房主**。客户端只把指令发给房主，房主算完再广播快照，
 *   所以这里不需要合并冲突的逻辑（也就没有 CRDT）。
 * - `rev` 单调递增，客户端据此丢弃迟到的旧快照。
 */

export const TEAM_SIZE_MIN = 1;
export const TEAM_SIZE_MAX = 10;
export const DEFAULT_TEAM_SIZE = 5;
export const NAME_MAX = 16;
/** 聊天只留最近这些条。状态快照要带一份历史给后进来的人，不能无限长。 */
export const CHAT_KEEP = 80;
export const CHAT_TEXT_MAX = 300;

/**
 * 房间码字母表：去掉 0/O/1/I/L 这些念出来、手抄下来会混的字符。
 * 5 位是 31^5 ≈ 2860 万种，对「报一串码给队友」这个用途绰绰有余。
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

/*
 * 下面这些结构统统用 `type` 而不是 `interface`，而且**字段一律必填**。
 * 两条都不是风格问题，是因为这些对象要原样走 WebRTC 数据通道（Trystero 的
 * `makeAction<T>` 要求 `T` 满足 `JsonValue`）：
 *
 * 1. `interface` 没有隐式索引签名，直接通不过 `JsonValue` 的约束；
 * 2. JSON 里没有 `undefined`，可选字段一旦为 undefined 就会在序列化时整个消失，
 *    对面拿到的是「字段不存在」而不是「字段为空」。所以「没有头像」写成
 *    `avatar: ''`，形状恒定、语义显式，省掉一堆 `?? ''` 的判断。
 */

export type Member = {
	/** 传输层的 peer id，用作稳定标识。 */
	id: string;
	name: string;
	/** Steam 头像地址；没有就是空串，页面上退回首字母占位。 */
	avatar: string;
	joinedAt: number;
};

export type Team = {
	id: string;
	name: string;
	/** 成员 id，顺序即展示顺序。 */
	members: string[];
};

export type ChatKind = 'say' | 'system';

export type ChatMessage = {
	id: string;
	kind: ChatKind;
	/** 说这句话的人；系统消息是空串。 */
	peerId: string;
	/** 说话时的昵称快照。用快照而不是查名册：人走了之后历史消息还要看得出是谁说的。 */
	name: string;
	text: string;
	at: number;
};

export type RollRecord = {
	value: number;
	at: number;
};

export type RoomState = {
	code: string;
	name: string;
	hostId: string;
	/** 每队人数上限，也是自动生成队伍数的依据。 */
	teamSize: number;
	members: Member[];
	teams: Team[];
	/** 本轮 roll 的结果，key 是成员 id。 */
	rolls: Record<string, RollRecord>;
	/** 轮次号，让「重开一轮」在所有客户端都能清屏。 */
	rollRound: number;
	/** 新进房间的人是否自动补进人最少的队。 */
	autoAssign: boolean;
	rev: number;
};

// ---------------------------------------------------------------- 基础工具

/** 注入随机源是为了可测：分队、roll、房间码走同一个。 */
export type Rand = () => number;

export function randomInt(maxExclusive: number, rand: Rand = Math.random): number {
	return Math.min(maxExclusive - 1, Math.floor(rand() * maxExclusive));
}

/** 洗牌（Fisher–Yates），返回新数组。 */
export function shuffle<T>(list: readonly T[], rand: Rand = Math.random): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = randomInt(i + 1, rand);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Dota 的 roll 是 1–100（不是 0–100），点数大的先手。 */
export function rollValue(rand: Rand = Math.random): number {
	return 1 + randomInt(100, rand);
}

export function randomCode(rand: Rand = Math.random, length = CODE_LENGTH): string {
	let code = '';
	for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length, rand)];
	return code;
}

/**
 * 归一化用户输入的房间码：转大写、只留字母表内的字符。
 * 队友念错一位是常事，这里只做形状纠正，不做纠错猜测。
 */
export function normalizeCode(input: string): string {
	return [...input.toUpperCase()]
		.filter((ch) => CODE_ALPHABET.includes(ch))
		.join('')
		.slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
	return code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

/**
 * 昵称清洗：去掉控制字符与零宽/双向控制字符，压掉连续空白，截断到上限。
 *
 * 昵称是**用户可控输入**，页面上全部走 `textContent` 渲染，所以这里不是防 XSS，
 * 而是防止有人用换行把布局撑破、或用零宽字符伪装成另一个人。
 */
export function sanitizeName(input: string): string {
	return [...input]
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f) return false;
			if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return false;
			if (code >= 0x202a && code <= 0x202e) return false;
			return true;
		})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, NAME_MAX);
}

export function roomNameIssue(name: string): string | null {
	return sanitizeName(name).length === 0 ? '请填写房间名称' : null;
}

export function passwordIssue(password: string): string | null {
	if (password.length === 0) return '请填写房间密码';
	if (password.length > 24) return '房间密码不能超过 24 个字符';
	return null;
}

export function nicknameIssue(name: string): string | null {
	return sanitizeName(name).length === 0 ? '请填写昵称' : null;
}

// ---------------------------------------------------------------- 房间状态

export function clampTeamSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_TEAM_SIZE;
	return Math.min(TEAM_SIZE_MAX, Math.max(TEAM_SIZE_MIN, Math.round(size)));
}

/** 房间当前需要几个队：人数 ÷ 每队上限向上取整，至少一个。 */
export function neededTeamCount(memberCount: number, teamSize: number): number {
	return Math.max(1, Math.ceil(memberCount / clampTeamSize(teamSize)));
}

function newTeam(index: number): Team {
	return { id: `t${index + 1}`, name: `队伍 ${index + 1}`, members: [] };
}

/** 每次改动都 +1，客户端用 `rev` 丢弃迟到的旧快照。 */
function bump(state: RoomState, patch: Partial<RoomState>): RoomState {
	return { ...state, ...patch, rev: state.rev + 1 };
}

function findTeam(state: RoomState, teamId: string): Team | undefined {
	return state.teams.find((team) => team.id === teamId);
}

export function teamOf(state: RoomState, memberId: string): Team | undefined {
	return state.teams.find((team) => team.members.includes(memberId));
}

export function memberById(state: RoomState, memberId: string): Member | undefined {
	return state.members.find((member) => member.id === memberId);
}

export function sortMembers(members: readonly Member[]): Member[] {
	return [...members].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
}

/** 不在任何队里的人，按入房时间排——展示顺序才稳定。 */
export function freeMembers(state: RoomState): Member[] {
	const placed = new Set(state.teams.flatMap((team) => team.members));
	return sortMembers(state.members.filter((member) => !placed.has(member.id)));
}

export function createRoom(input: { code: string; name: string; host: Member; teamSize?: number }): RoomState {
	return {
		code: input.code,
		name: sanitizeName(input.name),
		hostId: input.host.id,
		teamSize: clampTeamSize(input.teamSize ?? DEFAULT_TEAM_SIZE),
		members: [input.host],
		// 先建好第一个队并把房主放进去：否则「空闲池坐着房主、队伍栏是空的」，
		// 而且先到的几个人会因为「没有队可放」而堆在空闲池里（后面的人反而先入队）。
		teams: [{ ...newTeam(0), members: [input.host.id] }],
		rolls: {},
		rollRound: 1,
		autoAssign: true,
		rev: 1,
	};
}

export function setTeamSize(state: RoomState, size: number): RoomState {
	const teamSize = clampTeamSize(size);
	if (teamSize === state.teamSize) return state;
	return autoPlace(restructure(bump(state, { teamSize }), false));
}

/**
 * 队伍结构调整：补齐欠缺的队、把超出每队上限的人放回空闲池。
 *
 * `allowTrim` 决定要不要把「多出来的队」也删掉：
 * - `false`（改每队上限时走这条）：只补不删。房主手动加的队是有意为之，
 *   改个上限就把它抹掉太粗暴；
 * - `true`（房主点「自动分队」时走这条）：按人数重算出该有几个队，多出来的拆掉。
 *
 * 不管走哪条，只要有人离开了队，人都是**回到空闲池**而不是跟着队消失。
 */
function restructure(state: RoomState, allowTrim: boolean): RoomState {
	const need = neededTeamCount(state.members.length, state.teamSize);
	const keepCount = allowTrim ? Math.min(need, state.teams.length) : state.teams.length;

	// 超员部分的队尾直接不带走（队尾是最后加进来的，最该被挪），
	// 被裁掉的队整个不带走。两者都不需要额外处理：`freeMembers` 是按「不在任何队里」算的，
	// 只要没被写进 teams，人就自动回到空闲池。
	const teams = state.teams
		.slice(0, keepCount)
		.map((team) => ({ ...team, members: team.members.slice(0, state.teamSize) }));
	while (teams.length < need) teams.push(newTeam(teams.length));

	return bump(state, { teams });
}

/**
 * 把空闲的人补进「还没满且人最少」的队。房主手动排过的人不动。
 *
 * `memberId` 只处理一个人（新人进房时用），不传就处理全部空闲的人。
 */
export function autoPlace(state: RoomState, memberId?: string): RoomState {
	const targets = memberId ? state.members.filter((member) => member.id === memberId) : freeMembers(state);
	if (targets.length === 0) return state;

	let next = state;
	for (const member of sortMembers(targets)) {
		if (teamOf(next, member.id)) continue;
		const candidates = next.teams.filter((team) => team.members.length < next.teamSize);
		if (candidates.length === 0) break;
		// 人最少的优先，并列时取靠前的队，结果可预期。
		const target = candidates.reduce((best, team) => (team.members.length < best.members.length ? team : best));
		next = moveMember(next, member.id, target.id);
	}
	return next;
}

/** 「自动分队」：按人数重算队伍数，再把空闲的人填满。 */
export function autoFormTeams(state: RoomState): RoomState {
	return autoPlace(restructure(state, true));
}

/**
 * 增减成员。返回值里 `added` 用来区分「新来的」和「同一个人重连」——后者不该再记一条
 * 「加入房间」，但两者都要更新展示字段。
 *
 * **不设人数上限**：这是开黑房，队都排到 5v5 往上了，卡一个数字只会挡自己人。
 * 真正的上限是浏览器与网络（P2P 全网状，N 个人 N×(N-1)/2 条连接），人多了自然会卡。
 */
export function upsertMember(state: RoomState, member: Member): { state: RoomState; added: boolean } {
	const existing = memberById(state, member.id);
	if (existing) {
		// 同一个人重连（刷新页面、切网络）只更新展示字段，不动入房时间和队伍位置。
		const members = state.members.map((item) =>
			item.id === member.id ? { ...item, name: member.name, avatar: member.avatar } : item,
		);
		return { state: bump(state, { members }), added: false };
	}

	const next = bump(state, { members: sortMembers([...state.members, member]) });
	// 先按「人数 ÷ 每队上限」把队补齐，再放人：第 6 个人进来时第一队刚好满，
	// 不补齐的话他会一直坐在空闲池里，而队伍数不会自己长出来。
	return { state: state.autoAssign ? autoPlace(restructure(next, false), member.id) : next, added: true };
}

/** 把人从所有队里摘掉。返回的状态没有 bump，调用方自己决定要不要算一次改动。 */
function detach(state: RoomState, memberId: string): RoomState {
	const teams = state.teams.map((team) =>
		team.members.includes(memberId) ? { ...team, members: team.members.filter((id) => id !== memberId) } : team,
	);
	return { ...state, teams };
}

export function removeMember(state: RoomState, memberId: string): RoomState {
	if (!memberById(state, memberId)) return state;
	const rolls = { ...state.rolls };
	delete rolls[memberId];
	const without = detach(state, memberId);
	return bump(without, { members: without.members.filter((member) => member.id !== memberId), rolls });
}

/**
 * 把一个人放进指定队伍（`null` 表示放回空闲池）。
 *
 * 目标队满了就**不搬**并返回原状态：静默把人塞进超员的队比拒绝更糟——
 * 房主看到的是「我挪过去了」，而人数与上限对不上。
 */
export function moveMember(state: RoomState, memberId: string, teamId: string | null): RoomState {
	if (!memberById(state, memberId)) return state;
	if (teamId === null) return bump(detach(state, memberId), {});

	const target = findTeam(state, teamId);
	if (!target || target.members.includes(memberId)) return state;
	if (target.members.length >= state.teamSize) return state;

	const detached = detach(state, memberId);
	const teams = detached.teams.map((team) =>
		team.id === teamId ? { ...team, members: [...team.members, memberId] } : team,
	);
	return bump(detached, { teams });
}

/** 房主手动新增一个空队。 */
export function addTeam(state: RoomState): RoomState {
	return bump(state, { teams: [...state.teams, newTeam(state.teams.length)] });
}

/**
 * 删掉一个队，队里的人回到空闲池。
 * **最后一个队不允许删**——房间至少要有一个能放人的容器。
 */
export function removeTeam(state: RoomState, teamId: string): RoomState {
	if (state.teams.length <= 1) return state;
	const target = findTeam(state, teamId);
	if (!target) return state;
	const rest = state.teams.filter((team) => team.id !== teamId);
	return bump(detach(state, target.id), { teams: rest });
}

export function renameTeam(state: RoomState, teamId: string, name: string): RoomState {
	const clean = sanitizeName(name);
	if (clean.length === 0 || !findTeam(state, teamId)) return state;
	const teams = state.teams.map((team) => (team.id === teamId ? { ...team, name: clean } : team));
	return bump(state, { teams });
}

/**
 * 随机重排：清空所有分配，把名册洗牌后按顺序填回现有的队。
 *
 * 队本身（数量与名字）保留，只重排人——房主可能把队名改成了「带妹组」之类，
 * 随机一次就抹掉是不礼貌的。
 */
export function randomizeTeams(state: RoomState, rand: Rand = Math.random): RoomState {
	const emptied = state.teams.map((team) => ({ ...team, members: [] as string[] }));
	let next = bump(state, { teams: emptied });
	for (const member of shuffle(sortMembers(state.members), rand)) {
		const candidates = next.teams.filter((team) => team.members.length < next.teamSize);
		if (candidates.length === 0) break;
		const target = candidates.reduce((best, team) => (team.members.length < best.members.length ? team : best));
		next = moveMember(next, member.id, target.id);
	}
	return next;
}

/**
 * 按 roll 值蛇形分队：手气最好的先挑，然后回头，像选人那样（0,1,2,2,1,0…）。
 * 没 roll 的人按入房顺序排在最后，不至于被漏掉。
 */
export function formTeamsByRoll(state: RoomState): RoomState {
	const ranked = sortMembers(state.members).sort((a, b) => {
		const av = state.rolls[a.id]?.value ?? -1;
		const bv = state.rolls[b.id]?.value ?? -1;
		return bv - av || a.joinedAt - b.joinedAt;
	});

	const resized = restructure(state, false);
	const teams = resized.teams.map((team) => ({ ...team, members: [] as string[] }));
	let next = bump(resized, { teams });

	const count = teams.length;
	ranked.forEach((member, index) => {
		const lap = Math.floor(index / count);
		const offset = index % count;
		const target = teams[lap % 2 === 0 ? offset : count - 1 - offset];
		next = moveMember(next, member.id, target.id);
	});
	return next;
}

export function clearRolls(state: RoomState): RoomState {
	return bump(state, { rolls: {}, rollRound: state.rollRound + 1 });
}

/** 房主代记一次 roll。同一个人重复 roll 以最后一次为准。 */
export function setRoll(state: RoomState, memberId: string, value: number, at = Date.now()): RoomState {
	if (!memberById(state, memberId)) return state;
	const rolls = { ...state.rolls, [memberId]: { value: Math.min(100, Math.max(1, Math.round(value))), at } };
	return bump(state, { rolls });
}

/** 已 roll 的人，点数从高到低。 */
export function rollBoard(state: RoomState): { member: Member; roll: RollRecord }[] {
	return state.members
		.filter((member) => state.rolls[member.id])
		.map((member) => ({ member, roll: state.rolls[member.id] }))
		.sort((a, b) => b.roll.value - a.roll.value || a.roll.at - b.roll.at);
}

export function setAutoAssign(state: RoomState, autoAssign: boolean): RoomState {
	return state.autoAssign === autoAssign ? state : bump(state, { autoAssign });
}

// ---------------------------------------------------------------- 聊天

/**
 * 追加一条聊天记录并裁到上限。
 *
 * 系统消息（进出房、roll、分队变更）走同一个列表：它们和聊天在时间上是同一条线，
 * 分成两个面板反而看不出「谁在什么时候说了什么、那时队伍是什么样」。
 */
export function appendChat(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
	const next = [...list, message];
	return next.length > CHAT_KEEP ? next.slice(next.length - CHAT_KEEP) : next;
}

export function clampChatText(input: string): string {
	return [...input.replace(/\s+$/, '')].slice(0, CHAT_TEXT_MAX).join('');
}

/** 时间只到分钟：开黑房里不需要秒级时间戳。 */
export function clockOf(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function initialOf(name: string): string {
	return name.trim().slice(0, 1) || '?';
}
