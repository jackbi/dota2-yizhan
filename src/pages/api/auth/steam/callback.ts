import type { APIRoute } from 'astro';
import { isSecureOrigin, siteOrigin } from '../../../../lib/siteOrigin';
import { sessionConfigured, writeSession } from '../../../../lib/session';
import { LOGIN_STATE_COOKIE, verifySteamAssertion } from '../../../../lib/steamAuth';
import { loadPlayerProfile } from '../../../../lib/stratzPlayer';

export const prerender = false;

/**
 * Steam 回调：校验断言 → 发会话 → 回个人页。
 *
 * return_to 必须与签发时**逐字节一致**（Steam 会把它原样回传，我们拿它和本地重建的
 * 比一次），所以这里用同一个 origin 与同一个 state 重新拼一遍，不能加别的参数。
 */
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
	if (!sessionConfigured()) {
		return new Response('未配置 SESSION_SECRET，无法登录。', {
			status: 500,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	const state = url.searchParams.get('state') ?? '';
	const expectedState = cookies.get(LOGIN_STATE_COOKIE)?.value ?? '';
	// state 一次性：无论成功与否都立刻清掉，避免重放。
	cookies.delete(LOGIN_STATE_COOKIE, { path: '/' });

	if (!state || !expectedState || state !== expectedState) {
		return redirect('/login?error=state', 302);
	}

	const origin = siteOrigin(url);
	const returnTo = new URL('/api/auth/steam/callback', origin);
	returnTo.searchParams.set('state', state);

	const identity = await verifySteamAssertion(url.searchParams, returnTo.toString());
	if (!identity) return redirect('/login?error=verify', 302);

	/*
	 * 昵称与头像顺带从 STRATZ 取。取不到**不该挡住登录**：SteamID 已经验过了，资料只是展示用。
	 *
	 * 取不到时 `name` 写空——**别在这里编一个「玩家 <账号 id>」**：那会被签进 30 天的 Cookie，
	 * 等 STRATZ 恢复也没人去改它，页头就一直显示那个假名（踩过）。空名由
	 * `hydrateSessionProfile()` 在下次请求时补齐，展示层的兜底在 `/api/me`。
	 */
	const profile = await loadPlayerProfile(identity.accountId, 1).catch(() => null);

	await writeSession(
		cookies,
			{
				accountId: identity.accountId,
				steamId: identity.steamId,
				name: profile?.name ?? '',
				avatar: profile?.avatar ?? '',
			},
		isSecureOrigin(origin),
	);

	return redirect('/me', 302);
};
