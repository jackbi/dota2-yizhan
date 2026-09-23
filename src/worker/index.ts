/**
 * Worker 入口：在 Astro 的 server handler 外面包一层，挂上开黑房间的 Durable Object。
 *
 * `wrangler.jsonc` 的 `main` 指到这里（默认是 `@astrojs/cloudflare/entrypoints/server`）。
 * 两者都是同一次 Vite 构建的产物，所以适配器那些 `virtual:*` 依赖照样解析得到——
 * 换成自定义入口以后，`/api/party/*` 这类请求可以**先被我们接住**，其余原样交给 Astro。
 */
import server from '@astrojs/cloudflare/entrypoints/server';
import { PartyLobby, PartyRoom } from './partyRoom';

export { PartyLobby, PartyRoom };

interface Env {
	PARTY_ROOMS: DurableObjectNamespace;
	PARTY_LOBBY: DurableObjectNamespace;
	/** 触发重建用：`owner/repo`。配在 `wrangler.jsonc` 的 vars 里。 */
	GITHUB_REPO?: string;
	/** 触发重建用：细粒度 token，只要 `Actions: write`。走 `wrangler secret put`。 */
	GITHUB_DISPATCH_TOKEN?: string;
}

/**
 * 定时触发一轮重建。
 *
 * 为什么由 Cloudflare 来触发、而不是用 GitHub Actions 自带的 `on.schedule`：后者的定时队列
 * 是尽力而为的，官方文档写着高负载时「some queued jobs may be dropped」。实测过 66.8 小时里
 * 本该跑 134 次，实际只有 18 次（13%），间隔中位数三个多小时——而真正跑到的那几次分针紧贴
 * `:17` / `:47`，说明是**被丢掉**而不是被延后。内容的新鲜度直接等于重建频率，靠不住就等于
 * 页面上的「数据更新于」永远停在昨天。
 *
 * Cloudflare 的 Cron Triggers 是准点的，而这个 Worker 本来就在同一个域名上跑着，
 * 加这一段不需要新服务、不计费。GitHub 那条 schedule 保留着但放宽到 6 小时一次，
 * 当作「token 过期 / Worker 挂了」时的兜底。
 *
 * 只调 `workflow_dispatch` 这一个接口，所以 token 只要 `Actions: write` 就够，
 * 读不到代码、也推不了东西。
 */
async function dispatchRebuild(env: Env): Promise<void> {
	const repo = env.GITHUB_REPO?.trim();
	const token = env.GITHUB_DISPATCH_TOKEN?.trim();
	if (!repo || !token) {
		console.warn('[cron] 没配 GITHUB_REPO / GITHUB_DISPATCH_TOKEN，跳过。见 docs/deploy.md');
		return;
	}

	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/rebuild.yml/dispatches`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'content-type': 'application/json',
				'x-github-api-version': '2022-11-28',
				// GitHub 要求带 User-Agent，缺了会 403。
				'user-agent': 'dota2-yizhan-worker',
			},
			// 分支写死 main：重建永远基于已发布的那条线，不受本地开发现场影响。
			body: JSON.stringify({ ref: 'main' }),
		});

		if (response.status === 204) {
			console.log('[cron] 已触发一轮重建');
			return;
		}
		// 失败原因写全：401/403 是 token 过期或权限不对，404 是仓库名或 workflow 名写错。
		console.warn(`[cron] 触发失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
	} catch (error) {
		console.warn(`[cron] 请求 GitHub 时出错：${error instanceof Error ? error.message : error}`);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api/party/rooms') {
			// 大厅的 POST 是房间内部的「上报」通道，外面只允许读：否则谁都能往列表里塞假房间。
			if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
			return env.PARTY_LOBBY.get(env.PARTY_LOBBY.idFromName('lobby')).fetch(request);
		}
		if (url.pathname.startsWith('/api/party/room/')) {
			const code = decodeURIComponent(url.pathname.slice('/api/party/room/'.length)).toUpperCase();
			if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response('房间码不对', { status: 400 });
			return env.PARTY_ROOMS.get(env.PARTY_ROOMS.idFromName(code)).fetch(request);
		}
		return server.fetch(request, env as never, ctx);
	},

	/**
	 * Cron Triggers 到点时走这里（时间表在 `wrangler.jsonc` 的 `triggers.crons`）。
	 *
	 * 不从 `fetch` 里转一次：cron 调用本来就不带请求，直接发出去更简单。
	 * 用 `waitUntil` 是为了让这次调用在函数返回后仍然算「未结束」，否则运行时可能在
	 * 请求还没发完时回收实例。
	 */
	async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(dispatchRebuild(env));
	},
};
