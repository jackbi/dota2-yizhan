import type { AstroCookies } from 'astro';
import { heroRefMap, itemRefMap, type HeroRef, type ItemRef } from './gameRefs';
import { readSession, type SessionUser } from './session';
import { loadPlayerProfile, stratzPlayerConfigured, StratzError, type PlayerProfile } from './stratzPlayer';

/**
 * 七个 `/me` 路由共用的登录守卫。
 *
 * 返回 `SessionUser` 表示已登录；返回 `Response` 表示这份响应应当直接交给浏览器
 * （目前只有 302 到登录页），调用方写成：
 *
 *     const session = await requirePlayer(Astro.cookies);
 *     if (session instanceof Response) return session;
 *
 * 抽出来是因为这两行原先在七个页面里一字不差地抄了七遍——以后改重定向目标（比如带上
 * `?next=` 回跳）一定会漏掉几个。
 */
export async function requirePlayer(cookies: AstroCookies): Promise<SessionUser | Response> {
	const session = await readSession(cookies);
	return session ?? new Response(null, { status: 302, headers: { Location: '/login' } });
}

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
		return { ok: false, reason: 'upstream-error', message: upstreamMessage(error) };
	}
}

/** 上游故障的统一文案。`StratzError` 带的是可操作的原因（限流 / 挑战页 / token 未配置）。 */
function upstreamMessage(error: unknown): string {
	return error instanceof StratzError ? `数据源暂时不可用：${error.message}` : '数据源暂时不可用，请稍后重试。';
}

/**
 * 次级查询（统计表、对局列表）的结果。
 *
 * 与 `loadPlayer` 分开，是因为两者的容错级别不同：主资料取不到就没法渲染整页，可以整页
 * 报错；次级查询失败时页面主体还在，必须把「这块没取到」画在内容位置上。用
 * `.catch(() => [])` 把失败吞成空数组，只会让上游故障显示成「你还没有比赛记录」——是句假话。
 */
export type SecondaryLoad<T> = { ok: true; data: T } | { ok: false; message: string };

export async function loadSecondary<T>(run: () => Promise<T>): Promise<SecondaryLoad<T>> {
	try {
		return { ok: true, data: await run() };
	} catch (error) {
		return { ok: false, message: upstreamMessage(error) };
	}
}

/** 空查表：主资料没取到、或次级查询失败时用它兜底，页面照样能画（显示成「英雄 123」）。 */
export function emptyRefs(): { heroes: Map<number, HeroRef>; items: Map<number, ItemRef> } {
	return { heroes: new Map(), items: new Map() };
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
