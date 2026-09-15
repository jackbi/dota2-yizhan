import type { APIRoute } from 'astro';
import { parseSteamIdInput } from '../../../lib/steamAuth';
import { StratzError, loadPlayerAvatar, stratzPlayerConfigured } from '../../../lib/stratzPlayer';

export const prerender = false;

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 查询结果带一点隐私属性（这个 IP 在查哪个账号），默认不让任何中间层留存；
			// 命中的资料才允许浏览器自己缓存一会儿，省掉重复查询。
			'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store',
		},
	});
}

/**
 * 按用户手填的 Steam ID 取昵称与头像，给开黑房间「不登录也想用自己的头像」用。
 *
 * 三件事必须说清楚：
 *
 * 1. **这不是登录，也证明不了任何事。** 返回的资料来自 STRATZ 的公开数据，
 *    谁都可以查任意一个账号。房间里显示的昵称和头像终究是**自报**的，
 *    真要表明身份只有走 Steam OpenID（`/api/auth/steam/login`）。
 * 2. **它是公网可调用的**，每次未命中的查询都会消耗一次 STRATZ 额度，所以
 *    `loadPlayerAvatar` 缓存 6 小时、`gql` 内部串行限速；这里不再另做限流，
 *    但**要把这个页面对外开放，就得知道这条代价**。
 * 3. **没配 STRATZ_TOKEN 时这个功能是关的**，此时回 503 并让用户直接填昵称，
 *    不是报错——和 `/me` 那边「未配置」的处理保持一致。
 */
export const GET: APIRoute = async ({ url }) => {
	const parsed = parseSteamIdInput(url.searchParams.get('id') ?? '');
	if (!parsed.ok) return respond({ ok: false, error: parsed.error }, 400);

	if (!stratzPlayerConfigured()) {
		return respond({ ok: false, error: '本站没有读取 Steam 资料的权限（未配置 STRATZ），直接填个昵称就行。' }, 503);
	}

	try {
		const profile = await loadPlayerAvatar(parsed.accountId);
		/*
		 * 两个字段都空就当作「查不到」。
		 *
		 * 实测不存在的 accountId（比如 4294967295）STRATZ **不会**返回 null，而是回一个
		 * `steamAccountId` 正常、`name`/`avatar` 全空的对象。不特判的话前端会显示
		 * 「读到资料了」，只是没名字没头像——用户会以为是自己网络的问题。
		 * 真正查不到与私密账号在这里无法区分，所以文案把两种情况都覆盖。
		 */
		if (!profile || (!profile.name && !profile.avatar)) {
			return respond({ ok: false, error: 'STRATZ 里查不到这个账号（也可能设成了私密），确认一下 ID 有没有抄错。' }, 404);
		}
		return respond(
			{
				ok: true,
				accountId: profile.accountId,
				steamId: parsed.steamId,
				name: profile.name,
				avatar: profile.avatar,
			},
			200,
			3600,
		);
	} catch (error) {
		// 上游故障要能和「没这个账号」分开：前者的文案是「稍后再试」，后者是「确认 ID」。
		const message = error instanceof StratzError ? error.message : '读取失败，稍后再试。';
		return respond({ ok: false, error: message }, 502);
	}
};
