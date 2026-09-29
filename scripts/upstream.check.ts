import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 上游给的东西不能直接信。五条不变量，共同点是**坏了不报错**：页面看着一切正常，只是慢、
 * 或者某张图永远是破的、某个日期永远印着 1970。每一条都对应一个真实踩过的坑：
 *
 * 1. **每个对外的 fetch 都要能超时。** 上游挂起时，没有超时的取数会把整轮构建拖到平台的
 *    30 分钟上限，而在浏览器里就是把那颗按钮永远挂在"加载中"、在 MCP 里就是一次工具调用
 *    永远不返回。这条以前只有 `itemApi` 一处例外，补齐之后它可以当不变量用。
 *    计数按**调用点**来：原先只问"这份文件里有没有 signal"，往一个已经有 signal 的文件里
 *    再加一个裸 fetch 是查不出来的。`src/worker` 与 `mcp` 里那种 DO / 内部调用（`.fetch(`）
 *    不算——它们是本机 RPC，没有超时语义；只数字面量 `fetch('https://…')`。
 * 2. **图片缓存必须原子写**（先临时文件再 rename）。图片的命中判定是 `fs.access`：一个被 kill 掉的
 *    构建留下的半张 JPG 会被当成已有缓存，还会被拷进 `dist/`，变成一张永远修不好的破图。
 * 3. **取数助手要把正文读完再清超时。** 拿到 `Response` 只代表响应头到了，正文还得下载；
 *    在 `finally` 里立刻 `clearTimeout` 等于超时只护住了响应头，正文可以无限期挂着。
 * 4. **0 不是时间戳。** OpenDota 的进行中比赛会给 `activate_time: 0`，而 `??` 只挡 null/undefined；
 *    `new Date(0)` 是合法的 1970-01-01，卡片上就会多出一个看着像真日期的假信息。取数侧要兜底，
 *    展示侧也要有守卫（同一个值在 `draft.astro` 里早就有守卫）。
 * 5. **退回旧缓存要有年龄上限。** 直播状态的缓存文件是上一次构建留下的，可能已经好几天；
 *    见到文件就用，页面上就是一个绿点写着「直播中」。开播状态按分钟变，这条要么给上限、
 *    要么就得说清这份快照是什么时候的。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/upstream.check.ts`）。
 */

const libDir = new URL('../src/lib/', import.meta.url);

/** 去掉注释行，免得"注释里提到 signal"把断言骗过去。 */
function stripComments(source: string): string {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
		})
		.join('\n');
}

const lib = (name: string): string => stripComments(readFileSync(new URL(name, libDir), 'utf8'));

// ---------------------------------------------------------------- 1. 每个 fetch 都要能超时

const files = readdirSync(libDir).filter((name) => name.endsWith('.ts'));
const withFetch: string[] = [];

const countFetches = (source: string): number => (source.match(/\bfetch\(/g) ?? []).length;
const countSignals = (source: string): number => (source.match(/\bsignal\s*:/g) ?? []).length;
/**
 * 取数用的 `fetch(`：**裸调用**才算，`.fetch(`（DO 之间的内部 RPC）不算。
 *
 * 上一版要求 `fetch(` 后面紧跟字面量 `https://`，于是 `fetch(`${BASE}${path}`)` 这种模板串拼出来的
 * 地址被漏掉——`mcp/` 下所有文件因此被跳过，删掉刚补的超时也照样绿。
 */
const bareFetchRe = /(?<![.\w$])fetch\(/g;
/**
 * 去掉方法声明（`async fetch(request, env, ctx) {`）：那是 Worker 的入口，不是取数。
 *
 * 不能按"行首是不是 `fetch(`"一刀切：`Promise.all([` 里一行一个的 `fetch(a),` 同样以 `fetch(`
 * 开头，整行删掉之后下面那圈就再也看不见它，缺超时也报绿。判据要落在**方法体**上——
 * 括号配对之后（跳过返回类型）跟的是 `{` 才算声明；声明也可能是多行的（参数与返回类型各占一行）。
 */
function dropFetchDeclarations(code: string): string {
	/** 括号之后是不是方法体：可选的返回类型标注，再接 `{`。 */
	const methodBody = /^\s*(?::[^{;=()]*)?\s*\{/;
	let out = code;
	const head = /(^|\n)[ \t]*(?:async[ \t]+)?fetch[ \t]*\(/g;
	let match: RegExpExecArray | null;
	while ((match = head.exec(out))) {
		const open = out.indexOf('(', match.index);
		let depth = 0;
		let i = open;
		for (; i < out.length; i += 1) {
			if (out[i] === '(') depth += 1;
			else if (out[i] === ')') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) break;
		// `fetch(a),` 那种调用在这里对不上：括号后面跟的是 `,` / `)` / `.`，不是方法体。
		const body = methodBody.exec(out.slice(i + 1));
		if (!body) {
			head.lastIndex = i + 1;
			continue;
		}
		// 只摘掉声明本身，`{` 与整个方法体留着——里面可能还有真的取数 fetch。
		const start = match.index + (match[1] ? match[1].length : 0);
		const keepFrom = i + body[0].length; // 正好指到方法体那个 `{`
		out = out.slice(0, start) + out.slice(keepFrom);
		head.lastIndex = start;
	}
	return out;
}

/*
 * 这把尺子自己也要准。
 *
 * 上一版按"行首是不是 `fetch(`"删整行，于是 `Promise.all([` 里一行一个的 `fetch(a),` 会被一起
 * 删掉——那种写法缺超时也报绿。反过来，方法声明（含多行参数表）必须真的摘掉，否则每个 Worker
 * 入口都会被当成一处"没带超时的取数"。
 */
{
	const counted = (source: string): number => (dropFetchDeclarations(source).match(/\bfetch\(/g) ?? []).length;
	assert.equal(
		counted('async function f() {\n\tawait Promise.all([\n\t\tfetch(a),\n\t\tfetch(b),\n\t]);\n}'),
		2,
		'行首的 fetch 调用（多行列表里一行一个）不能被当成方法声明删掉',
	);
	assert.equal(
		counted('export class D {\n\tasync fetch(request: Request, env: Env): Promise<Response> {\n\t\treturn new Response();\n\t}\n}'),
		0,
		'方法声明要摘掉：那是 Worker 的入口，不是取数',
	);
	assert.equal(
		counted('export class D {\n\tasync fetch(\n\t\trequest: Request,\n\t): Promise<Response> {\n\t\treturn x;\n\t}\n}'),
		0,
		'参数与返回类型各占一行的声明也要摘掉',
	);
}

for (const name of files) {
	const source = readFileSync(new URL(name, libDir), 'utf8');
	if (!/\bfetch\(/.test(source)) continue;
	withFetch.push(name);
	const code = stripComments(source);
	const fetches = countFetches(code);
	const signals = countSignals(code);
	assert.ok(
		signals >= fetches,
		`${name} 里有 ${fetches} 处 fetch 但只有 ${signals} 处 signal：上游挂起会把它挂死（要么加 AbortSignal.timeout，要么走带超时的公共底座）`,
	);
}
assert.ok(withFetch.length >= 10, `只扫到 ${withFetch.length} 个取数文件，解析多半坏了`);

// 同一把尺子量 worker 与 MCP：它们也会打外部接口（GitHub dispatch、站点的 json 接口）。
for (const [label, dir, ext] of [
	['src/worker', new URL('../src/worker/', import.meta.url), '.ts'],
	['mcp', new URL('../mcp/', import.meta.url), '.mjs'],
] as const) {
	for (const name of readdirSync(dir).filter((file) => file.endsWith(ext))) {
		const code = dropFetchDeclarations(stripComments(readFileSync(new URL(name, dir), 'utf8')));
		const bare = (code.match(bareFetchRe) ?? []).length;
		if (bare === 0) continue;
		const signals = countSignals(code);
		assert.ok(
			signals >= bare,
			`${label}/${name} 有 ${bare} 处取数 fetch 但只有 ${signals} 处 signal：外层挂住时调用会一直等下去`,
		);
	}
}

// ---------------------------------------------------------------- 2. 图片缓存原子写

const localImages = lib('localImages.ts');
assert.ok(localImages.includes('writeCacheBytes('), 'localImages 的图片缓存要走原子写（buildCache.writeCacheBytes）');
assert.ok(!/fs\.writeFile\(/.test(localImages), 'localImages 不该自己就地写文件：半张图会被当成命中');
// 读侧也要看一眼：原子写只护住了新产生的文件，被 kill 的构建或还原到一半的滚动缓存
// 留下的半张 JPG，光看"文件在不在"照样当命中。
assert.ok(localImages.includes('inspectImageFile('), '命中判定要看图写完了没有，不能只看文件在不在');
assert.ok(!/fs\.access\(/.test(localImages), 'fs.access 只回答"在不在"：半张 JPG 会被当成已有缓存');

// ---------------------------------------------------------------- 3. 正文读完再清超时

const reddit = lib('redditApi.ts');
assert.ok(reddit.includes('return await response.text()'), 'redditApi 的取数助手要在超时窗口内读完正文，不能把 Response 交给调用方');
assert.ok(!/Promise<Response \| null>/.test(reddit), '取数助手不该返回 Response：正文下载会跑到超时之外');

// ---------------------------------------------------------------- 4. 0 不是时间戳

const tournaments = lib('tournamentsApi.ts');
assert.ok(
	tournaments.includes('item.activate_time || Math.floor(Date.now() / 1000)'),
	'进行中比赛的开赛时间要兜底：activate_time 是 0 时 ?? 挡不住（它只挡 null/undefined）',
);
assert.ok(!tournaments.includes('item.activate_time ?? Math.floor'), 'activate_time 的兜底不能用 ??：0 会漏过去');

const matchRow = readFileSync(new URL('../src/components/MatchRow.astro', import.meta.url), 'utf8');
assert.ok(
	matchRow.includes('const hasTime = Number.isFinite(match.startTime) && match.startTime > 0'),
	'比赛卡片要守卫 startTime=0：否则 datetime 会印出 1970-01-01',
);
assert.ok(matchRow.includes('时间待定'), '时间不可用时要有替代文案');
// 光在展示层堵一处不够：同一个 0 会流到记分板、赛程卡、比赛列表。守卫放在格式化函数里，
// 谁调都拦得住。
const format = lib('format.ts');
assert.match(
	format,
	/export function formatMatchTime\(unix: number, nowSec: number\): string \{\s*if \(!Number\.isFinite\(unix\) \|\| unix <= 0\) return '时间待定';/,
	'formatMatchTime 要自己守卫 0/NaN：不然每个漏写的调用点都会印出 1970-01-01',
);

// ---------------------------------------------------------------- 5. 退回旧缓存要有年龄上限

// 行为在 `scripts/liveApi.check.ts`（真文件 + 真门槛）；这里只钉两条**接线**，它们错了
// 行为断言也看不出来（那边只测 usableStale 本身，不测谁在用、用哪一档）。
const live = lib('liveApi.ts');
assert.ok(live.includes('STALE_MAX_MS') && live.includes('OFFLINE_STALE_MAX_MS'), '两档年龄上限都要在');
assert.ok(!live.includes('readRawJson'), '退回旧缓存不能走 readRawJson：那条路读不到年龄，等于没有上限');
assert.match(
	live,
	/waitForPeerCache\(file: string\)[\s\S]{0,400}readCache\(file, TTL_SECONDS\)/,
	'等同伴写缓存那一处要按 TTL 判：用宽门槛会把上一轮构建的旧文件当成同伴刚写的，还跳过"这是旧快照"的提示',
);
// 两档门槛要在**各自的分支**里：写反了（网络兜底用 7 天档）行为断言看不出来——那边只测
// `usableStale` 本身，不测谁在用、用哪一档。
assert.match(live, /const stale = usableStale\(hit, OFFLINE_STALE_MAX_MS\)/, '离线分支只能用离线那档');
assert.match(live, /const stale = usableStale\(await readCachedStatus\(file\), STALE_MAX_MS\)/, '网络兜底只能用网络那档');

/*
 * 「状态未知」的出口不能标成联网抓取。
 *
 * 这条只靠行为断言看不出来：`scripts/liveApi.check.ts` 把 'network' / 'cache' / 'none' 手写喂给
 * `sourceSummary`，从不经过 `loadRoom`——把 `loadRoom` 里所有 `source:` 改掉，那三个自检照样全绿。
 * 而 `sourceSummary` 是按标签计数的：「斗鱼房间页只读到主播名、开播状态没取到」那种情况一旦标成
 * `network`，构建摘要会把它算进"本轮联网 N 个"，`usable > 0 && cache === 0` 时整源还判成 fresh。
 */
const unknownExits = [...live.matchAll(/return \{ status: unknownStatus\((?:[^()]|\([^()]*\))*\), source: '([a-z]+)' \}/g)];
assert.ok(unknownExits.length >= 3, `只找到 ${unknownExits.length} 处 unknownStatus 出口，解析多半坏了`);
for (const exit of unknownExits) {
	assert.equal(exit[1], 'none', `unknownStatus 的出口只能标 'none'（现在是 '${exit[1]}'）：状态未知不能记成联网抓取`);
}
/*
 * 还有一条形状不同的兄弟出口：主解析路径**成功解析**、但平台给的 `show_status` 是没见过的值，
 * 于是 `parseDouyu` / `parseHuya` 把它映成 `unknown`。它 return 的是 `{ status, source }`，
 * 上面那条按字面量匹配的断言抓不到——漏掉它，"状态未知算成联网抓取"就会只修一半。
 */
assert.match(
	live,
	/source: parsed\.state === 'unknown' \? 'none' : 'network'/,
	'主解析出口认不出状态时也要按"没取到"记，不能标成联网抓取',
);

console.log(`upstream.check 通过（扫了 ${withFetch.length} 个取数文件）`);
