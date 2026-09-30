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
	/** 这位选手的统计口径；缺省表示这份名单没有带口径。 */
	scope?: string;
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
export function buildTeamSignature(name: string, members: readonly SignatureMember[]): TeamSignature | null {
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
	if (heroes.length === 0) return null;

	return { name: name.trim(), scope: scopes.size === 1 ? [...scopes][0] : '', heroes };
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
