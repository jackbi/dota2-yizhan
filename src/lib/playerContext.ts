import { heroRefMap, itemRefMap, type HeroRef, type ItemRef } from './gameRefs';
import { loadPlayerProfile, stratzPlayerConfigured, StratzError, type PlayerProfile } from './stratzPlayer';

/**
 * 六个个人页共用的「取资料 + 分清失败原因」逻辑。
 *
 * 页面必须区分三种情况，因为它们要显示的话完全不同：
 * - `not-configured`：站点没配 `STRATZ_TOKEN`，是部署问题，提示去看 README；
 * - `not-found`：token 正常但查不到这个人（STRATZ 没有该账号的任何比赛）；
 * - `upstream-error`：限流 / 超时 / 挑战页，是临时的，值得让用户刷新重试。
 *
 * 混成一个「加载失败」会让人以为是自己的问题，也会让运维看不出该修配置还是该等。
 */
export type PlayerLoad =
	| { ok: true; profile: PlayerProfile }
	| { ok: false; reason: 'not-configured' | 'not-found' | 'upstream-error'; message: string };

export async function loadPlayer(accountId: number): Promise<PlayerLoad> {
	if (!stratzPlayerConfigured()) {
		return {
			ok: false,
			reason: 'not-configured',
			message: '站点未配置 STRATZ_TOKEN，个人战绩暂时不可用。',
		};
	}

	try {
		const profile = await loadPlayerProfile(accountId);
		if (!profile) {
			return {
				ok: false,
				reason: 'not-found',
				message: 'STRATZ 上查不到这个账号的比赛记录。若你从未公开过比赛数据，这里会是空的。',
			};
		}
		return { ok: true, profile };
	} catch (error) {
		return {
			ok: false,
			reason: 'upstream-error',
			message:
				error instanceof StratzError
					? `数据源暂时不可用：${error.message}`
					: '数据源暂时不可用，请稍后重试。',
		};
	}
}

/**
 * 英雄与装备的查表数据。
 *
 * 取不到时**退化成空表**而不是让整页报错：比赛的数字（KDA、经济、胜负）是主体，
 * 图标和英雄名只是装饰。两个来源都是第三方，不该因为它们抖动就把战绩整页打不开。
 * 页面上会显示成「英雄 123」这种兜底文案。
 */
export async function loadRefs(): Promise<{ heroes: Map<number, HeroRef>; items: Map<number, ItemRef> }> {
	const [heroes, items] = await Promise.all([
		heroRefMap().catch(() => new Map<number, HeroRef>()),
		itemRefMap().catch(() => new Map<number, ItemRef>()),
	]);
	return { heroes, items };
}

export interface NoticeProps {
	title: string;
	message: string;
	retryable: boolean;
}

/**
 * 把失败结果翻成提示卡的文案。
 *
 * 各页面的写法固定成
 * `{loaded.ok ? <正常内容 /> : <PlayerNotice {...noticeProps(loaded)} />}`，
 * 这样六个页面不必各自维护一份「哪种失败该说什么」。
 */
export function noticeProps(load: Extract<PlayerLoad, { ok: false }>): NoticeProps {
	if (load.reason === 'not-configured') return { title: '个人战绩未启用', message: load.message, retryable: false };
	if (load.reason === 'not-found') return { title: '没有找到比赛记录', message: load.message, retryable: false };
	return { title: '数据源暂时不可用', message: load.message, retryable: true };
}

/**
 * 分析页各维度的展示行：已经翻好中文标签的 `GroupRow`。
 *
 * 定义在这里而不是组件里，是为了让「页面负责翻译、组件只负责画」这条分工有个明确的类型。
 */
export interface BreakdownRow {
	label: string;
	matches: number;
	wins: number;
	/** 该维度平均 IMP。取不到时给 null（显示为 `—`），不给 0——0 是一个有意义的值。 */
	imp?: number | null;
}

// ---------------------------------------------------------------- 展示用的小工具

/** 秒 → 32:15。负数/异常值统一显示 `--:--`，不让 NaN 漏到页面上。 */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** 胜率，保留一位小数；场次为 0 时返回 `—` 而不是 `0.0%`。 */
export function winRate(wins: number, matches: number): string {
	if (matches <= 0) return '—';
	return `${((wins / matches) * 100).toFixed(1)}%`;
}

export function percent(wins: number, matches: number): number {
	return matches > 0 ? (wins / matches) * 100 : 0;
}

/** KDA = (K+A)/D，0 死亡按整场算（与 STRATZ/OpenDota 的口径一致）。 */
export function kda(kills: number, deaths: number, assists: number): number {
	return (kills + assists) / Math.max(1, deaths);
}

/** 千分位。经济、伤害这类数字要能一眼读出量级。 */
export function thousands(value: number): string {
	if (!Number.isFinite(value)) return '—';
	return Math.round(value).toLocaleString('en-US');
}
