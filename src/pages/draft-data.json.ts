import type { APIRoute } from 'astro';
import { loadDraftData } from '../lib/draftData';

export const prerender = true;

/**
 * `/draft-data.json`：`/draft` 页内联的那份构建期数据，单独再发一份。
 *
 * 内容与页面里 `<script id="draft-data">` 的那份**完全一致，不裁剪**。页面靠它录 BP、算胜率、
 * 给建议，缺字段就会让两条路对不上；而且两边都调 `loadDraftData()`，结构上不可能各自漂移——
 * 要加字段就改 `draftData.ts`，页面和这份 JSON 一起变。
 *
 * 为什么能白拿一份：`loadDraftData()` 是模块级单飞（见 `draftData.ts` 的 `dataPromise`），
 * 这条路由与页面在同一次构建、同一个 Node 进程里渲染（`prerenderEnvironment: 'node'`），
 * 命中同一个 promise，不额外联网也不额外占缓存。
 *
 * 这份的作用是让人**从程序里取数据，而不是去解 `/draft` 的 HTML**——和 `/draft-lanes.json`、
 * `/draft-teams.json` 是同一类东西。
 *
 * 两个已经量过的行为，改这块之前先看一眼：
 *
 * - **下面这个 `Cache-Control` 在 Workers 上不生效。** 预渲染产物落到磁盘上就是个静态文件，
 *   APIRoute 里设的响应头会被丢掉。实测线上 `/draft-lanes.json` 返回的是
 *   `cache-control: public, max-age=0, must-revalidate`，靠 Cloudflare 边缘缓存兜住
 *   （`cf-cache-status: HIT`）。想改浏览器缓存得动 `_headers`，注意适配器检测到已有规则会跳过注入，
 *   别把 `_astro/*` 那条挤掉。
 * - **它不进 sitemap。** `@astrojs/sitemap` 不收录 json，所以百度与 IndexNow 那两条推送脚本
 *   （都读 `sitemap-0.xml`）不会把它当成新增 URL，那点配额留给真正的内容页。
 */
export const GET: APIRoute = async () => {
	const data = await loadDraftData();
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 版本与英雄统计一天一变，构建产物每次部署都会换，交给浏览器缓存一天即可。
			'Cache-Control': 'public, max-age=86400',
		},
	});
};
