import { SITE_URL } from 'astro:env/server';

/**
 * 站点对外的 origin，用来拼 Steam OpenID 的 realm 与 return_to。
 *
 * 优先用 `SITE_URL`：生产环境常挂在反向代理后面，请求里的 Host 未必是对外域名，
 * 拼错了 Steam 就会把用户送回一个打不开的地址。
 * 没配时退回请求本身的 origin —— 本地开发、`astro preview` 都不用额外配置。
 */
export function siteOrigin(requestUrl: URL): string {
	const configured = (SITE_URL ?? '').trim().replace(/\/+$/, '');
	return configured || requestUrl.origin;
}

/** 只有 https 才给 Cookie 打 Secure：本地 http 打上会导致 Cookie 根本存不下来。 */
export function isSecureOrigin(origin: string): boolean {
	return origin.startsWith('https://');
}
