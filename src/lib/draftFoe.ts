/**
 * 「对面擅长什么」这一段的数据形状与文案。
 *
 * 单独抽成**纯模块**（不碰 `astro:env`、不碰文件系统）是因为它有四个使用者：
 * 取数的运行时代码（`stratzTeamForm`）、打分层、提示词组装、页面脚本。
 * 形状和说法放在这里，四边就不会各写一套；也因为它纯，自检脚本能直接喂数据。
 *
 * 口径上只讲事实：**他们拿了多少场、赢了多少、对手禁了它多少次**。
 * 不做「招牌英雄」「核心位」这类判断——按队伍统计分不出位置，写出来就是编。
 */

export interface FoeHero {
	heroId: number;
	/** 他们自己拿了多少场（含结果尚未记录的场次）。 */
	picks: number;
	/** 其中分出胜负的场次，胜率按它算。 */
	decided: number;
	wins: number;
	/** 对手禁掉它多少次。 */
	bansAgainst: number;
}

export interface FoeForm {
	/** 队伍名，取不到时是空串（界面上就只说「对面」）。 */
	name: string;
	windowDays: number;
	matches: number;
	decided: number;
	wins: number;
	/** 按出场场次降序，其次按被对手禁用的次数降序。 */
	heroes: FoeHero[];
}

/** 统计窗口。短了样本不够，长了会把换人、换版本之前的习惯也算进来。 */
export const TEAM_FORM_WINDOW_DAYS = 30;

interface RawPickBan {
	heroId?: number | null;
	isPick?: boolean | null;
	isRadiant?: boolean | null;
}

/** STRATZ 那边 `team.matches` 的形状；放在这里是为了让自检能直接喂构造数据。 */
export interface RawFormMatch {
	id?: number | null;
	radiantTeamId?: number | null;
	direTeamId?: number | null;
	didRadiantWin?: boolean | null;
	pickBans?: RawPickBan[] | null;
}

/**
 * 把一批比赛折成「这支队伍的英雄偏好」。纯函数，不联网，自检直接喂数据。
 *
 * 只数两类：**他们自己选的**（`isPick` 且阵营与队伍一致）和**对手禁他们的**
 * （不是选、阵营是对方）。他们自己禁掉的不算——那是他们怕什么，不是他们擅长什么。
 */
export function summarizeTeamForm(
	teamId: number,
	name: string,
	matches: readonly RawFormMatch[],
	windowDays: number,
): FoeForm {
	const byHero = new Map<number, FoeHero>();
	let counted = 0;
	let decided = 0;
	let wins = 0;

	for (const match of matches) {
		const isRadiant = match.radiantTeamId === teamId;
		const isDire = match.direTeamId === teamId;
		// 名单里混进别人的比赛就跳过：宁可少算，也不要把无关的 BP 记到这支队伍头上。
		if (!isRadiant && !isDire) continue;
		counted += 1;

		// 结果未知（生成中的对局）时仍然数出场，只是不计入胜率。
		const known = typeof match.didRadiantWin === 'boolean';
		const won = known ? (isRadiant ? match.didRadiantWin === true : match.didRadiantWin === false) : null;
		if (known) {
			decided += 1;
			if (won) wins += 1;
		}

		for (const entry of match.pickBans ?? []) {
			const heroId = entry.heroId;
			if (typeof heroId !== 'number') continue;
			const mine = entry.isRadiant === isRadiant;
			if (entry.isPick ? !mine : mine) continue;

			const row = byHero.get(heroId) ?? { heroId, picks: 0, decided: 0, wins: 0, bansAgainst: 0 };
			if (entry.isPick) {
				row.picks += 1;
				if (known) {
					row.decided += 1;
					if (won) row.wins += 1;
				}
			} else {
				row.bansAgainst += 1;
			}
			byHero.set(heroId, row);
		}
	}

	const heroes = [...byHero.values()].sort(
		(a, b) => b.picks - a.picks || b.bansAgainst - a.bansAgainst || a.heroId - b.heroId,
	);
	return { name, windowDays, matches: counted, decided, wins, heroes };
}

/** 有几场才写胜率。低于这个数只报场次——「1 场 100%」除了误导没有别的用处。 */
const MIN_RATE_SAMPLE = 2;
/**
 * 有几场才值得当成「他们爱用」。
 *
 * 只打过一场的英雄说明不了偏好，写在依据里反而把真正该看的几个挤下去——
 * 一份 12 场的窗口里，「拿过 1 场」和「拿过 5 场」不是同一个量级的事。
 */
const MIN_PICKS = 2;

/** 胜率；样本不够或没有分出胜负时返回 null，调用方就别写百分比。 */
export function foeWinRate(hero: FoeHero): number | null {
	return hero.decided >= MIN_RATE_SAMPLE ? hero.wins / hero.decided : null;
}

/**
 * 对面最擅长的前几个：先出场场次、再被对手禁用的次数。
 *
 * 这两个排序键都会写在依据里，读者能自己判断；只取**真拿过**的（`picks > 0`），
 * 「对手总禁它、他们从没选过」说明不了他们擅长什么。
 */
export function foeHighlights(form: FoeForm | null | undefined, count = 3): FoeHero[] {
	if (!form) return [];
	return form.heroes.filter((hero) => hero.picks >= MIN_PICKS).slice(0, Math.max(0, count));
}

/** 这个英雄在对面偏好里的那一行；不在窗口里返回 null。 */
export function foeHeroOf(form: FoeForm | null | undefined, heroId: number): FoeHero | null {
	if (!form) return null;
	return form.heroes.find((hero) => hero.heroId === heroId) ?? null;
}

/** 队伍在文案里的称呼：有名字用名字，没有就说「对面」。 */
function foeLabel(form: FoeForm): string {
	return form.name.trim() || '对面';
}

/**
 * 一行依据，候选卡与提示词共用。数字全部来自窗口内的真实比赛，可以逐条核对。
 * 不在对面偏好里时返回空串，调用方直接跳过这一条。
 *
 * `side` 说的是**这份偏好属于哪一边**（相对正在算的这一方）：默认 `theirs`（对面），
 * 让模型替对面落子时是 `ours`——那正是它自己的队伍，人称必须跟着翻。
 */
export function foeHeroLine(form: FoeForm | null | undefined, heroId: number, side: 'ours' | 'theirs' = 'theirs'): string {
	const hero = foeHeroOf(form, heroId);
	if (!form || !hero || hero.picks < MIN_PICKS) return '';
	const label = `${side === 'theirs' ? '对面' : '我方'}${form.name.trim() ? `（${form.name.trim()}）` : ''}`;
	const rate = foeWinRate(hero);
	const scale = `${label}近 ${form.windowDays} 天拿了 ${hero.picks} 场`;
	const record = rate === null ? '胜负记录不足' : `${hero.wins} 胜 ${hero.decided - hero.wins} 负，胜率 ${(rate * 100).toFixed(1)}%`;
	// 被禁次数一律写出来，哪怕是 0：省略会让读者分不清「没人禁」和「这项没数据」。
	return `${scale}（${record}），对手禁过它 ${hero.bansAgainst} 次`;
}

/**
 * 只讲战绩的那半句：`近 30 天 23 场，15 胜 8 负`。带不带队名由调用方接。
 */
export function foeRecordLine(form: FoeForm | null | undefined): string {
	if (!form || form.matches === 0) return '';
	const record = form.decided > 0 ? `，${form.wins} 胜 ${form.decided - form.wins} 负` : '';
	return `近 ${form.windowDays} 天 ${form.matches} 场${record}`;
}

/**
 * 界面上那行摘要：队名 + 战绩。后面接哪几个英雄由页面拼——那里才有中文英雄名。
 */
export function foeHeadline(form: FoeForm | null | undefined): string {
	if (!form || form.matches === 0) return '';
	return `${foeLabel(form)} ${foeRecordLine(form)}`;
}
