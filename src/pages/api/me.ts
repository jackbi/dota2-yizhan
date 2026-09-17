import type { APIRoute } from 'astro';
import { displayName, hydrateSessionProfile } from '../../lib/sessionProfile';
import { readSession, sessionConfigured } from '../../lib/session';

export const prerender = false;

/**
 * 当前登录态，供页头那段客户端脚本查询。
 *
 * 只回展示所需的最小字段（id / 昵称 / 头像），**不回会话里的任何其它内容**，
 * 也不回 SteamID64 —— 页头用不上，少暴露一点是一点。
 *
 * 顺带把会话里缺失的昵称头像补齐（登录时 STRATZ 抖动过一次的会话会带着空名字）：
 * 页头每个页面都会打这个接口，放在这里补最省事——补到了就回写 Cookie，
 * 之后连 SSR 页面（`/party`、`/me`）拿到的也是补齐后的会话。
 */
export const GET: APIRoute = async ({ cookies, url }) => {
	const session = await hydrateSessionProfile(cookies, await readSession(cookies), url.protocol === 'https:');
	return new Response(
		JSON.stringify({
			configured: sessionConfigured(),
			user: session
				? { accountId: session.accountId, name: displayName(session), avatar: session.avatar }
				: null,
		}),
		{
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				// 登录态因人而异，绝不能被 CDN 或浏览器缓存下来。
				'Cache-Control': 'no-store, private',
			},
		},
	);
};
