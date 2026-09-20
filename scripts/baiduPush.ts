#!/usr/bin/env node
/*
 * 把本轮**新增**的 URL 推给百度「普通收录」。
 *
 * 为什么只推新增：实测这个站当前配额是**每天 10 条**（第一次试推首页后返回 `remain: 9`），
 * 而 sitemap 里有 520 个页面。全量推不但当天就撞配额，之后每天重复推同一批也不增加收录——
 * 百度明确说过重复推送会被忽略。所以这里维护一份「推过哪些」的清单（放在 `.cache/`，
 * 由 CI 的滚动缓存带着走），每轮只推清单外的新页面。
 *
 * 失败的处理口径：**上游报错不让部署失败**。百度挂了、配额用完了，都不该把一次成功的部署
 * 标成红的；但每一行都会打进构建日志，包括还剩多少配额、积压多少条、按当前配额要多少天。
 * 唯一会非 0 退出的是「sitemap 读不到」——那说明构建产物不对，值得让人看见。
 *
 * 本地跑：`node --experimental-strip-types scripts/baiduPush.ts --dry-run`
 * 没有配 `BAIDU_PUSH_URL` 时直接跳过（fork 的人、本地构建都不受影响）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SITEMAP = 'dist/client/sitemap-0.xml';
const STATE = '.cache/baidu-pushed.json';
/**
 * 一次请求最多推几条。取 10 是因为当前配额就是 10。
 */
const BATCH = 10;
/**
 * 单轮最多发几次请求。配额用完后每次都会失败，没有这个上限就会一直撞。
 * 8 次足够把「从 10 缩到 1」的降级路径走完。
 */
const MAX_REQUESTS = 8;
/**
 * 优先推的页面：抓取入口。配额只有个位数时，先让百度拿到首页与各列表页，
 * 它自己会顺着链接往下爬；把 10 条配额全给长尾帖，等于一个入口都没交。
 */
const PRIORITY = ['/', '/heroes/', '/items/', '/patches/', '/tournaments/', '/draft/', '/live/', '/news/', '/community/', '/ob/'];

const pushUrl = (process.env.BAIDU_PUSH_URL ?? '').trim();
const dryRun = process.argv.includes('--dry-run');

interface State {
	/** 已经推成功的 URL。 */
	pushed: string[];
	/** 推过但被百度判为无效/非同站的 URL：记下来，免得每轮都重试同一条。 */
	rejected: string[];
	lastRun: string;
}

function readState(): State {
	try {
		const raw = JSON.parse(readFileSync(STATE, 'utf8')) as Partial<State>;
		return { pushed: raw.pushed ?? [], rejected: raw.rejected ?? [], lastRun: raw.lastRun ?? '' };
	} catch {
		return { pushed: [], rejected: [], lastRun: '' };
	}
}

function writeState(state: State): void {
	mkdirSync(path.dirname(STATE), { recursive: true });
	writeFileSync(STATE, `${JSON.stringify(state, null, '\t')}\n`);
}

if (!existsSync(SITEMAP)) {
	console.error(`[baidu] 找不到 ${SITEMAP}，构建产物不对`);
	process.exit(1);
}

const urls = [...readFileSync(SITEMAP, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!.trim());
if (urls.length === 0) {
	console.error('[baidu] sitemap 里一个 URL 都没有');
	process.exit(1);
}

const state = readState();
const known = new Set([...state.pushed, ...state.rejected]);
const priorityOf = (url: string): number => {
	const index = PRIORITY.indexOf(url.replace(/^https?:\/\/[^/]+/, ''));
	return index === -1 ? PRIORITY.length : index;
};
// 稳定排序：同一优先级内部保持 sitemap 的顺序（首页在前、列表页在详情页前）。
const pending = urls.filter((url) => !known.has(url)).sort((a, b) => priorityOf(a) - priorityOf(b));

console.log(`[baidu] sitemap ${urls.length} 条，已推 ${state.pushed.length} 条，本轮待推 ${pending.length} 条`);
if (pending.length === 0) {
	console.log('[baidu] 没有新增页面，跳过推送');
	process.exit(0);
}
// `--dry-run` 是给本地看一份白名单用的，没有 secret 也该能跑。
if (!pushUrl && !dryRun) {
	console.log('[baidu] 没配 BAIDU_PUSH_URL（fork / 本地构建会走到这里），跳过推送');
	process.exit(0);
}

interface PushResult {
	remain?: number;
	success?: number;
	not_same_site?: string[];
	not_valid?: string[];
	error?: number;
	message?: string;
}

async function push(batch: string[]): Promise<PushResult> {
	const res = await fetch(pushUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain' },
		body: batch.join('\n'),
		signal: AbortSignal.timeout(20_000),
	});
	const text = await res.text();
	try {
		return JSON.parse(text) as PushResult;
	} catch {
		return { message: `HTTP ${res.status}：${text.slice(0, 200)}` };
	}
}

let pushedNow = 0;
let index = 0;
let batchSize = BATCH;
let requests = 0;
while (index < pending.length && requests < MAX_REQUESTS) {
	const batch = pending.slice(index, index + batchSize);
	if (dryRun) {
		console.log(`[baidu] （dry-run）这一批会推 ${batch.length} 条：${batch.slice(0, 3).join('、')}…`);
		break;
	}

	requests += 1;
	const result = await push(batch);
	if (result.error || typeof result.success !== 'number') {
		/*
		 * 配额不足时百度**整批拒绝**（实测：剩 9 条时推 10 条，回 `over quota`，一条都没进）。
		 * 所以这里逐级对半缩批再试，一直缩到 1——否则配额不满整批的那些天会一条都推不出去，
		 * 而且表面上只会留下"没推成功"一行，很难看出是批量大小的问题。
		 */
		if (batchSize > 1) {
			batchSize = Math.max(1, Math.floor(batchSize / 2));
			console.warn(`[baidu] 这一批没推成功（${result.message ?? `error ${result.error}`}），缩到 ${batchSize} 条再试`);
			continue;
		}
		console.warn(`[baidu] 单条也推不进去（${result.message ?? `error ${result.error}`}），本轮到此为止`);
		break;
	}

	// 只有「整批都成功」才记账：部分成功时百度不告诉我们是哪几条，
	// 宁可下轮重推（多花一点配额），也不要漏推。
	if (result.success !== batch.length) {
		console.warn(`[baidu] 这一批只成功 ${result.success}/${batch.length} 条，具体是哪几条上游没给，本轮先不记账`);
		break;
	}
	state.pushed.push(...batch);
	pushedNow += batch.length;
	index += batch.length;
	if (result.not_valid?.length) state.rejected.push(...result.not_valid);
	if (result.not_same_site?.length) state.rejected.push(...result.not_same_site);

	console.log(`[baidu] 推成功 ${result.success} 条，当日剩余配额 ${result.remain ?? '未知'}`);
	if (result.remain === 0) break;
}

state.pushed = [...new Set(state.pushed)];
state.rejected = [...new Set(state.rejected)];
state.lastRun = new Date().toISOString();
if (!dryRun) writeState(state);

const remaining = urls.filter((url) => !new Set([...state.pushed, ...state.rejected]).has(url)).length;
console.log(`[baidu] 本轮推了 ${pushedNow} 条；清单里共 ${state.pushed.length} 条，还差 ${remaining} 条没推`);
if (remaining > 0) {
	// 这条最重要：它直接回答「要不要为这件事做别的」——按 10 条/天，520 个页面要 52 天。
	console.log(`[baidu] 按当前配额（约 10 条/天）算，剩下的要 ${Math.ceil(remaining / 10)} 天才能推完`);
}
