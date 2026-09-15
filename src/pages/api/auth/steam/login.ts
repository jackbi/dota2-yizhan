import type { APIRoute } from 'astro';
import { sessionConfigured } from '../../../../lib/session';
import { isSecureOrigin, siteOrigin } from '../../../../lib/siteOrigin';
import { buildLoginUrl, LOGIN_STATE_COOKIE, LOGIN_STATE_MAX_AGE_SECONDS, randomState } from '../../../../lib/steamAuth';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
	if (!sessionConfigured()) {
		return new Response('未配置 SESSION_SECRET，无法登录。请参考 README 的环境变量一节。', {
			status: 500,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	const origin = siteOrigin(url);
	const secure = isSecureOrigin(origin);

	// state 防的是登录 CSRF：没有它，攻击者可以把自己的 Steam 回调链接塞给受害者，
	// 让受害者的浏览器「被登录」成攻击者的账号。
	const state = randomState();
	const callback = new URL('/api/auth/steam/callback', origin);
	callback.searchParams.set('state', state);

	cookies.set(LOGIN_STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: LOGIN_STATE_MAX_AGE_SECONDS,
	});

	return redirect(buildLoginUrl(callback.toString(), origin), 302);
};
