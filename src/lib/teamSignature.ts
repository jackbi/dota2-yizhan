/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */

/**
 * 「战队 + 人员的擅长英雄」。
 *
 * 数据来源是名单里每个人的招牌英雄（`playerHeroes.ts`，按版本统计、样本不够回退到 90 天），
 * 这里只做一件事：**把一个人的名单折成一队的名单**。折的前提是每人带出来的口径要一致——
 * 口径不一致就整队不标版本（见 `scopeLabel` 的注释），宁可少一句话，也不要把两套窗口
 * 混出来的数字写成一个版本号。
 *
 * 为什么要有这一层而不是直接读 `member.heroPool`：
 * - BP 里要看的是"这支队会拿什么"，一个人列五个英雄会得到二十多个格子，看不出重点；
 * - 同一个英雄多个人在打（DOTA 里很常见），要合并成一个条目并把打它的选手留下，
 *   否则提示词里会出现同一条数据写两遍、模型据此当成"他们特别爱用"。
 */

/** 队里某个英雄的合计。 */
export interface SignatureHero {
	heroId: number;
	/** 全队在这个英雄上的场次与胜场（把各人的合起来）。 */
	games: number;
	wins: number;
	/** 打这个英雄的选手昵称，按各人的场次降序；只留打得最多的几位。 */
	players: string[];
}

export interface TeamSignature {
	/** 队名；调用方给不出来时是空串，界面上的称呼会退回「我方 / 对面」。 */
	name: string;
	/**
	 * 统计口径（`7.41f 版本` / `近 90 天`）。
	 * **名单里口径不一致时是空串**——那种情况下写任何一个版本号都是错的。
	 */
	scope: string;
	/** 按场次降序，其次按胜场降序，再按英雄 id 定序（每轮结果要一样）。 */
	heroes: SignatureHero[];
}

/** `buildTeamSignature` 的输入：只要每位选手的招牌英雄，不关心名单里其它字段。 */
export interface SignatureMember {
	nick: string;
	heroes: readonly { heroId: number; games: number; wins: number }[];
	/** 一到五号位。**有它才谈得上"这个位置上的这个人"**——见 `buildRosterProfile`。 */
	position?: number;
	/** 这位选手的统计口径；缺省表示这份名单没有带口径。 */
	scope?: string;
}

/**
 * 一个号位的池子：**打这个位置的那（几）个人本版本在拿什么**。
 *
 * 这是「摇摆」与「固定位置」的分界。一支队每个号位通常就是一到两个人，偶有换位
 * （一二号位轮流、辅助互换），所以这里按号位分组而不是按人分组：同一号位有两个人时
 * 合成一个池子，界面与提示词里都写清是谁在打。
 */
export interface RosterPositionPool {
	/** 1 到 5。 */
	position: number;
	/** 打这个号位的选手昵称（可能不止一位）。 */
	players: string[];
	/** 这个号位共同的统计口径；不一致时空串。 */
	scope: string;
	heroes: SignatureHero[];
}

/**
 * 一支队的名单画像：不分号位的合计（`heroes`，与 `TeamSignature` 同形）**加上按号位分的池子**。
 *
 * 为什么要在旧那份合计之外多这一层：BP 里问的不是"这支队爱用什么"，而是
 * **"他们的二号位会拿什么"**。只有号位对得上，才谈得上"这一手是他们的熟手"；
 * 合成一份的时候，把三号位的招牌算到二号位头上是看不出来的。
 */
export interface RosterProfile extends TeamSignature {
	/** 按号位升序；名单里缺哪个号位就没有那一项（教练组没有号位，不进来）。 */
	positions: RosterPositionPool[];
}

/**
 * 全队合计到几场才值得写。一个人的池子里本来就只留了打过几场的英雄（见 `heroPool`），
 * 合并之后再加一道：一场的合计说明不了"这支队爱用"，写在依据里只会挤掉真正该看的。
 */
export const SIGNATURE_MIN_GAMES = 2;
/** 一队最多留几个。BP 里能同时考虑的本来就不超过这个量级。 */
export const SIGNATURE_TOP_HEROES = 8;
/** 一个英雄最多列举几位选手，多了那行就念不完。 */
const MAX_PLAYERS_PER_HERO = 3;

/**
 * 把名单折成一份队伍签名。一位选手都没有（或都没有招牌英雄）时返回 null，
 * 调用方按"这支队没有可用的招牌数据"处理。
 */
function aggregate(members: readonly SignatureMember[]): { heroes: SignatureHero[]; scope: string } {
	const byHero = new Map<number, { games: number; wins: number; players: Map<string, number> }>();
	/** 有招牌数据的选手各自的口径；没带口径的那种不参与一致性判断。 */
	const scopes = new Set<string>();

	for (const member of members) {
		if (member.heroes.length === 0) continue;
		if (member.scope) scopes.add(member.scope);
		for (const stat of member.heroes) {
			if (!Number.isInteger(stat.heroId) || stat.heroId <= 0) continue;
			const entry = byHero.get(stat.heroId) ?? { games: 0, wins: 0, players: new Map<string, number>() };
			entry.games += stat.games;
			entry.wins += stat.wins;
			const nick = member.nick.trim();
			if (nick) entry.players.set(nick, (entry.players.get(nick) ?? 0) + stat.games);
			byHero.set(stat.heroId, entry);
		}
	}

	const heroes: SignatureHero[] = [...byHero]
		.filter(([, entry]) => entry.games >= SIGNATURE_MIN_GAMES)
		.sort((a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins || a[0] - b[0])
		.slice(0, SIGNATURE_TOP_HEROES)
		.map(([heroId, entry]) => ({
			heroId,
			games: entry.games,
			wins: entry.wins,
			players: [...entry.players]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
				.slice(0, MAX_PLAYERS_PER_HERO)
				.map(([nick]) => nick),
		}));
	return { heroes, scope: scopes.size === 1 ? [...scopes][0] : '' };
}

export function buildTeamSignature(name: string, members: readonly SignatureMember[]): TeamSignature | null {
	const { heroes, scope } = aggregate(members);
	if (heroes.length === 0) return null;
	return { name: name.trim(), scope, heroes };
}

/**
 * 名单画像：合计一份（与 `buildTeamSignature` 同源同形）+ 每个号位一份。
 *
 * 一位选手都没有招牌英雄时返回 null，调用方按"这支队没有可用的招牌数据"处理。
 * 名单里没写号位的人只进合计，不进制表——教练组没有号位，替他编一个位置等于造数据。
 */
export function buildRosterProfile(name: string, members: readonly SignatureMember[]): RosterProfile | null {
	const all = aggregate(members);
	if (all.heroes.length === 0) return null;

	const positions: RosterPositionPool[] = [];
	for (let position = 1; position <= 5; position += 1) {
		const group = members.filter((member) => member.position === position);
		if (group.length === 0) continue;
		const pool = aggregate(group);
		// 这个号位有名单、但这几个人本版本一场都没统计到：不摆一个空池子出来。
		if (pool.heroes.length === 0) continue;
		positions.push({
			position,
			players: group.map((member) => member.nick.trim()).filter(Boolean),
			scope: pool.scope,
			heroes: pool.heroes,
		});
	}

	return { name: name.trim(), scope: all.scope, heroes: all.heroes, positions };
}

/** 某个号位的池子；名单里没有这个号位时返回 null。 */
export function rosterPoolOf(profile: RosterProfile | null | undefined, position: number): RosterPositionPool | null {
	if (!profile) return null;
	return profile.positions.find((pool) => pool.position === position) ?? null;
}

/**
 * 这个英雄在这个号位的池子里那一行；不在里面返回 null。
 *
 * **号位必须对上**：同一个英雄在别的号位有人打，不等于这个位置上的人会打它——
 * 那正是"把三号位的招牌算到二号位头上"的错法。
 */
export function rosterHeroOf(
	profile: RosterProfile | null | undefined,
	position: number,
	heroId: number,
): SignatureHero | null {
	const pool = rosterPoolOf(profile, position);
	if (!pool) return null;
	return pool.heroes.find((hero) => hero.heroId === heroId) ?? null;
}

/**
 * 熟手加成的量级。
 *
 * 尺度对齐打分层：候选的 `ranking` 是"五号位估值之和的涨幅"，一个号位胜率差 5 个百分点
 * 折进去是 0.01（0.05 / 5）。所以这个数就是"**愿意用几号位的几个百分点，换他的熟手身份**"。
 *
 * **取值是量出来的，不是拍的。** 实测（2026-09-30，LGD Gaming vs Xtreme Gaming 各 24 手）：
 * 每一手"第一顺位"与"最好的熟手"基础分差是 0、0.0095…0.025（多数）、0.035–0.07（少数）、
 * 0.10（个别）——22 手里有 22 手存在熟手可选。取 0.04 时约 18/22 手能被熟手反超，
 * 也就是"**多数位置会挑他的熟手，但遇上明显更强的点仍然会让路**"，这正是真实 BP 的样子；
 * 取 0.02 只有 11/22，实测跑出来十手挑选里只有一手落在池子里，等于没参考英雄池。
 *
 * 为什么是加法而不是乘法：两者是**两种证据**，乘法会让"胜率一般但很熟"永远翻不了身。
 * 给到 0.04 之后，一个号位胜率高出 4 个百分点以上、而他本版本从没拿过的英雄仍然能排前面——
 * 那是有意的：那个取舍要留给读者看见，两边的数字都写在依据里。
 */
export const FAMILIARITY_WEIGHT = 0.04;
/** 加到多少场就封顶。再多也不过是"很熟"，与"刚练出来"的差距不该被场次无限拉大。 */
const FAMILIARITY_CAP_GAMES = 8;

/**
 * 熟手加成：这个英雄在这个号位的池子里有多少场，折算成排序分。
 * 不在池子里（或这个号位没有名单）时是 0——**不给负分**：我们不认识的人不等于不会玩。
 */
export function familiarityBonus(
	profile: RosterProfile | null | undefined,
	position: number,
	heroId: number,
	weight: number = FAMILIARITY_WEIGHT,
): number {
	const hero = rosterHeroOf(profile, position, heroId);
	if (!hero) return 0;
	return (Math.min(hero.games, FAMILIARITY_CAP_GAMES) / FAMILIARITY_CAP_GAMES) * weight;
}

/**
 * 口径文案。`scope` 已经在 `buildTeamSignature` 里统一过了，这里只把两套已知的说法翻一下；
 * 认不出的一律用空串，界面上就只说"招牌英雄"，不写任何时间范围。
 */
export function signatureScopeLabel(scope: string): string {
	if (!scope) return '';
	return scope === 'window' ? '近 90 天' : scope;
}

/** 队里最突出的几个英雄；空签名返回空数组。 */
export function signatureHighlights(signature: TeamSignature | null | undefined, count = 4): SignatureHero[] {
	if (!signature) return [];
	return signature.heroes.slice(0, Math.max(0, count));
}

/** 这个英雄在这份签名里的那一行；不在里面返回 null。 */
export function signatureHeroOf(signature: TeamSignature | null | undefined, heroId: number): SignatureHero | null {
	if (!signature) return null;
	return signature.heroes.find((hero) => hero.heroId === heroId) ?? null;
}

/**
 * 一行依据，候选卡与提示词共用。数字全部来自名单里那些人的真实对局，可以逐条核对。
 * 不在签名里时返回空串，调用方直接跳过这一条。
 *
 * `side` 说的是**这份签名属于哪一边**（相对正在算的这一方）：默认 `theirs`（对面），
 * 替对面落子时传 `ours`——那正是它自己的队伍，人称必须跟着翻。
 */
export function signatureLine(
	signature: TeamSignature | null | undefined,
	heroId: number,
	side: 'ours' | 'theirs' = 'theirs',
): string {
	const hero = signatureHeroOf(signature, heroId);
	if (!signature || !hero) return '';
	const whose = side === 'theirs' ? '对面' : '我方';
	const label = `${whose}${signature.name ? `（${signature.name}）` : ''}`;
	const scope = signatureScopeLabel(signature.scope);
	const who = hero.players.length > 0 ? `${hero.players.join('、')} 的招牌` : '招牌';
	const record = `${hero.games} 场 ${hero.wins} 胜`;
	return `${label}${scope ? `${scope}里` : '的'}${who}：${record}`;
}

/**
 * 一行**带号位**的依据：这个位置上的这个人，本版本拿它打过多少场。
 *
 * 与 `signatureLine` 的关系：那条只说"这支队有人打它"，这条说"**打这个号位的那个人**在打它"。
 * 只要号位池子里有，就该用这一条——BP 里追问的正是后半句。池子里没有时返回空串，
 * 由调用方回落到 `signatureLine`（他在别的号位打过）或 `rosterOutOfPool`（谁都没打过）。
 */
export function rosterFamilyLine(
	profile: RosterProfile | null | undefined,
	position: number,
	heroId: number,
	side: 'ours' | 'theirs' = 'theirs',
): string {
	const hero = rosterHeroOf(profile, position, heroId);
	if (!profile || !hero) return '';
	const whose = side === 'theirs' ? '对面' : '我方';
	const label = `${whose}${profile.name ? `（${profile.name}）` : ''}`;
	// 先看这个号位自己的口径：同队不同号位可能落在不同窗口里（一个人本版本打过、另一个靠回退）。
	const scope = signatureScopeLabel(rosterPoolOf(profile, position)?.scope || profile.scope);
	const who = hero.players.length > 0 ? hero.players.join('、') : '这个人';
	return `${label} ${position} 号位是 ${who}：${scope ? `${scope}里` : '近期对局里'}拿过它 ${hero.games} 场 ${hero.wins} 胜`;
}

/**
 * 不在这个号位池子里时的风险提示：要么"他在别的号位打它"（摇摆），要么"这支队没人常拿它"。
 *
 * 两种情况都不是错，但都得写出来——上一版正是缺这一句，页面才会出现"某人的天穹守望者"
 * 这种读者一眼就看出不对、界面却完全不提的情况。返回空串表示它就在这个号位的池子里。
 */
export function rosterOutOfPool(
	profile: RosterProfile | null | undefined,
	position: number,
	heroId: number,
): string {
	if (!profile || rosterHeroOf(profile, position, heroId)) return '';
	const elsewhere = profile.positions
		.filter((pool) => pool.position !== position)
		.map((pool) => ({ pool, hero: pool.heroes.find((row) => row.heroId === heroId) }))
		.filter((entry): entry is { pool: RosterPositionPool; hero: SignatureHero } => entry.hero !== undefined);
	if (elsewhere.length === 0) return '这支队本版本没有人常拿它，当作新练或外人看不出的战术';
	const main = elsewhere.sort((a, b) => b.hero.games - a.hero.games)[0]!;
	const who = main.hero.players.length > 0 ? main.hero.players.join('、') : '名单里的人';
	return `本版本是 ${main.pool.position} 号位 ${who} 在打它（${main.hero.games} 场），放 ${position} 号位算摇摆`;
}
