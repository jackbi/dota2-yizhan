#!/usr/bin/env node
/*
 * 把本轮**新增**的 URL 推给 IndexNow（Bing / Yandex / Seznam / Naver 都吃这套）。
 *
 * 为什么值得做，而且比百度那条省心：
 * - **不需要账号、不需要验证站点、没有配额**。只要站点根目录能访问到
 *   `/<key>.txt`（内容就是 key 本身，见 `public/indexnow-key.txt`），
 *   再把 JSON POST 到 `https://api.indexnow.org/indexnow` 就完事。
 * - Bing 官方推荐的上限是单次 10000 条，我们每轮只推新增，一般个位数。
 *
 * 与 `baiduPush.ts` 的分工：百度那边配额只有 10 条/天，得精打细算；这里没有配额，
 * 所以「新增就推」即可。两边共用同一个思路（清单存 `.cache/`，跟着 CI 滚动缓存走），
 * 但各自记各自的状态文件，互不干扰。
 *
 * 本地跑：`node --experimental-strip-types scripts/indexNow.ts --dry-run`
 * 上游报错不让部署失败——一次成功的部署不该因为推送接口抖动变成红的。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SITEMAP = 'dist/client/sitemap-0.xml';
const KEY_FILE = 'public/indexnow-key.txt';
const STATE = '.cache/indexnow-pushed.json';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
/** 一次请求最多推几条。官方上限 10000，这里取 500——多批推也没成本，但小批更好定位问题。 */
const BATCH = 500;

const dryRun = process.argv.includes('--dry-run');

if (!existsSync(SITEMAP)) {
	console.error(`[indexnow] 找不到 ${SITEMAP}，构建产物不对`);
	process.exit(1);
}
if (!existsSync(KEY_FILE)) {
	console.error(`[indexnow] 找不到 ${KEY_FILE}——key 文件必须放在站点根目录可访问的位置`);
	process.exit(1);
}

const key = readFileSync(KEY_FILE, 'utf8').trim();
const urls = [...readFileSync(SITEMAP, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!.trim());
if (urls.length === 0) {
	console.error('[indexnow] sitemap 里一个 URL 都没有');
	process.exit(1);
}

interface State {
	pushed: string[];
	lastRun: string;
}

function readState(): State {
	try {
		const raw = JSON.parse(readFileSync(STATE, 'utf8')) as Partial<State>;
		return { pushed: raw.pushed ?? [], lastRun: raw.lastRun ?? '' };
	} catch {
		return { pushed: [], lastRun: '' };
	}
}

const state = readState();
const known = new Set(state.pushed);
const pending = urls.filter((url) => !known.has(url));

console.log(`[indexnow] sitemap ${urls.length} 条，已推 ${state.pushed.length} 条，本轮待推 ${pending.length} 条`);
if (pending.length === 0) {
	console.log('[indexnow] 没有新增页面，跳过推送');
	process.exit(0);
}

const host = new URL(urls[0]!).host;
const keyLocation = `https://${host}/${path.basename(KEY_FILE)}`;

let pushed = 0;
for (let index = 0; index < pending.length; index += BATCH) {
	const batch = pending.slice(index, index + BATCH);
	if (dryRun) {
		console.log(`[indexnow] （dry-run）会推 ${batch.length} 条到 ${ENDPOINT}，keyLocation=${keyLocation}`);
		break;
	}

	let status = 0;
	try {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ host, key, keyLocation, urlList: batch }),
			signal: AbortSignal.timeout(20_000),
		});
		status = res.status;
		if (!res.ok) console.warn(`[indexnow] 这一批返回 HTTP ${status}：${(await res.text()).slice(0, 200)}`);
	} catch (error) {
		console.warn(`[indexnow] 请求失败：${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	// 200 = 全部收到；202 = 收到但待校验（key 文件还没生效时见过），两种都算推成功。
	if (status !== 200 && status !== 202) {
		console.warn('[indexnow] 本轮到此为止，下轮会重推这批（清单没记账）');
		break;
	}
	state.pushed.push(...batch);
	pushed += batch.length;
	console.log(`[indexnow] 推成功 ${batch.length} 条（HTTP ${status}）`);
}

state.pushed = [...new Set(state.pushed)];
state.lastRun = new Date().toISOString();
if (!dryRun) {
	mkdirSync(path.dirname(STATE), { recursive: true });
	writeFileSync(STATE, `${JSON.stringify(state, null, '\t')}\n`);
}
console.log(`[indexnow] 本轮推了 ${pushed} 条，清单里共 ${state.pushed.length} 条`);
