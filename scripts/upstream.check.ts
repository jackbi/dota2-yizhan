import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 上游给的东西不能直接信。四条不变量，共同点是**坏了不报错**：页面看着一切正常，只是慢、
 * 或者某张图永远是破的、某个日期永远印着 1970。每一条都对应一个真实踩过的坑：
 *
 * 1. **`src/lib` 里每个 fetch 都要能超时。** 上游挂起时，没有超时的取数会把整轮构建拖到平台
 *    的 30 分钟上限，而在浏览器里就是把那颗按钮永远挂在"加载中"。这条以前只有 `itemApi`
 *    一处例外，补齐之后它可以当不变量用。
 * 2. **图片缓存必须原子写**（先临时文件再 rename）。图片的命中判定是 `fs.access`：一个被 kill 掉的
 *    构建留下的半张 JPG 会被当成已有缓存，还会被拷进 `dist/`，变成一张永远修不好的破图。
 * 3. **取数助手要把正文读完再清超时。** 拿到 `Response` 只代表响应头到了，正文还得下载；
 *    在 `finally` 里立刻 `clearTimeout` 等于超时只护住了响应头，正文可以无限期挂着。
 * 4. **0 不是时间戳。** OpenDota 的进行中比赛会给 `activate_time: 0`，而 `??` 只挡 null/undefined；
 *    `new Date(0)` 是合法的 1970-01-01，卡片上就会多出一个看着像真日期的假信息。取数侧要兜底，
 *    展示侧也要有守卫（同一个值在 `draft.astro` 里早就有守卫）。
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
for (const name of files) {
	const source = readFileSync(new URL(name, libDir), 'utf8');
	if (!/\bfetch\(/.test(source)) continue;
	withFetch.push(name);
	// 粗粒度：只问「这份文件里有没有任何 signal」。它挡的是「新写一个裸 fetch」，不去解析
	// 每一次调用——按调用点判断得引 AST，而这个仓库没有那套工具链。
	assert.match(
		stripComments(source),
		/signal/,
		`${name} 里有 fetch 但没有任何 signal：上游挂起会把它挂死（要么加 AbortSignal.timeout，要么走带超时的公共底座）`,
	);
}
assert.ok(withFetch.length >= 10, `只扫到 ${withFetch.length} 个取数文件，解析多半坏了`);

// ---------------------------------------------------------------- 2. 图片缓存原子写

const localImages = lib('localImages.ts');
assert.ok(localImages.includes('writeCacheBytes('), 'localImages 的图片缓存要走原子写（buildCache.writeCacheBytes）');
assert.ok(!/fs\.writeFile\(/.test(localImages), 'localImages 不该自己就地写文件：半张图会被当成命中');

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

console.log(`upstream.check 通过（扫了 ${withFetch.length} 个取数文件）`);
