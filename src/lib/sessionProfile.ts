import type { AstroCookies } from 'astro';
import { type SessionUser, writeSession } from './session';
import { loadPlayerAvatar } from './stratzPlayer';

/**
 * 会话里的昵称头像补齐。
 *
 * 登录回调要先验 Steam 断言、再顺带取资料；取资料那一步可能失败（STRATZ 抖动、中转没通），
 * 而**登录本身不该因为展示信息失败而失败**。于是回调会写一份 `name` 为空的会话，
 * 由这里在下次请求时补齐并回写 Cookie。
 *
 * 曾经的做法是当场写一个 `玩家 <账号 id>` 的兜底名，结果那个名字被签进了 30 天的 Cookie：
 * STRATZ 恢复之后也没人会去改它，页头就一直显示「玩家 125249704」。所以现在兜底只在**展示时**
 * 用（见 `/api/me`），不进会话；会话里为空就代表「资料还没拿到」。
 */

/**
 * 老版本写进 Cookie 的兜底名（形如 `玩家 125249704`）。
 *
 * 留着这条判断是为了让**已经中招的会话**自愈：它们带着这个名字，但同样属于「资料没拿到」。
 * 判断只认「玩家 + 纯数字」，正常的 Steam 昵称不会被误伤。
 */
const LEGACY_FALLBACK_NAME = /^玩家 \d+$/;

/**
 * 失败后的冷却：`cached()` 故意不缓存失败（个人页要区分「上游挂了」和「这人没数据」），
 * 而这里挂在每个页面的热路径上（页头每次都打 `/api/me`），不挡一下就会变成
 * 「每刷新一次就打一次 STRATZ」。成功的那份由 `cached()` 的 6 小时兜住，不进这张表。
 */
const FAILED_COOLDOWN_MS = 5 * 60_000;
const failedAt = new Map<number, number>();

export function profileMissing(session: SessionUser | null): boolean {
	if (!session) return false;
	if (!session.name) return true;
	return LEGACY_FALLBACK_NAME.test(session.name);
}

/** 展示用的名字：会话里没有就用兜底，但**兜底只出现在这里**，不会被写回 Cookie。 */
export function displayName(session: SessionUser): string {
	return session.name || `玩家 ${session.accountId}`;
}

/**
 * 资料缺失时去 STRATZ 补一次，拿到就回写 Cookie 并返回新的会话。
 *
 * 拿不到（上游故障、账号被删）就原样返回，调用方照常渲染兜底名——**不抛错、不挡页面**。
 * `loadPlayerAvatar` 自带 6 小时缓存，所以这里不会每次刷新都打一次上游。
 */
export async function hydrateSessionProfile(
	cookies: AstroCookies,
	session: SessionUser | null,
	secure: boolean,
): Promise<SessionUser | null> {
	if (!profileMissing(session) || !session) return session;
	if (Date.now() - (failedAt.get(session.accountId) ?? 0) < FAILED_COOLDOWN_MS) return session;

	const profile = await loadPlayerAvatar(session.accountId).catch(() => null);
	if (!profile?.name) {
		failedAt.set(session.accountId, Date.now());
		return session;
	}
	failedAt.delete(session.accountId);

	const next: SessionUser = { ...session, name: profile.name, avatar: profile.avatar || session.avatar };
	await writeSession(
		cookies,
		{ accountId: next.accountId, steamId: next.steamId, name: next.name, avatar: next.avatar },
		secure,
	);
	return next;
}
