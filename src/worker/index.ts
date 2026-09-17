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
};
