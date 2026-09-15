import type { APIRoute } from 'astro';
import { clearSession } from '../../../lib/session';

export const prerender = false;

/**
 * 只接受 POST。
 *
 * 登出本身不会泄漏数据，但 GET 登出可以被任意第三方页面用一张 `<img>` 触发，
 * 把人莫名其妙踢下线。页面里的按钮是个 form，成本一样低。
 */
export const POST: APIRoute = async ({ cookies, redirect }) => {
	clearSession(cookies);
	return redirect('/', 303);
};
