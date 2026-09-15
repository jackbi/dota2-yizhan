import type { APIRoute } from 'astro';
import { readSession, sessionConfigured } from '../../lib/session';

export const prerender = false;

/**
 * 当前登录态，供页头那段客户端脚本查询。
 *
 * 只回展示所需的最小字段（id / 昵称 / 头像），**不回会话里的任何其它内容**，
 * 也不回 SteamID64 —— 页头用不上，少暴露一点是一点。
 */
export const GET: APIRoute = async ({ cookies }) => {
	const user = await readSession(cookies);
	return new Response(
		JSON.stringify({
			configured: sessionConfigured(),
			user: user ? { accountId: user.accountId, name: user.name, avatar: user.avatar } : null,
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
