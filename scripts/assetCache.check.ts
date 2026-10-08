import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 静态资源缓存头的自检。
 *
 * 为什么值得单开一条：这些头**写错了页面照样能看**，代价只是"每次切页都要多跑几圈校验"——
 * 在这条到 Cloudflare 的链路上单程 0.5~1 秒，读起来就是"网站变卡"。2026-10 就是这么发现的：
 * 除了适配器默认给的 `/_astro/*`，字体与六个图片频道拿到的都是 `max-age=0, must-revalidate`，
 * 每切一次页面就要为它们逐个发条件请求。
 *
 * 钉三件事：
 *
 * 1. 适配器那条 `/_astro/*` 必须还在（我们自己提供 `public/_headers` 之后它就不再注入了，
 *    少了这条整个样式表都会退回每次校验）；
 * 2. **`astro.config.mjs` 里每个图片频道都必须有对应的长缓存规则**——加频道时最容易漏这一步，
 *    而漏了不会报错，只会让那一批图每页都重新校验；
 * 3. 固定文件名的资源（logo、favicon、赞赏码…）**不许**跟着进长缓存，否则换图之后
 *    老访客要等一年才看得到新的。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/assetCache.check.ts`）。
 */

const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

/** `_headers` 的规则块：`/path/*` 一行，缩进一行写头。解析成 path → 头文本。 */
const rules = new Map<string, string>();
let current: string | null = null;
for (const line of headers.split('\n')) {
	if (line.startsWith('#')) continue;
	if (line.trim() === '') continue;
	if (!line.startsWith(' ')) {
		current = line.trim();
		rules.set(current, '');
		continue;
	}
	if (current) rules.set(current, `${rules.get(current)}${line.trim()}\n`);
}

assert.ok(rules.size >= 2, `_headers 只解析出 ${rules.size} 条规则，解析多半坏了`);

// 1. 适配器注入的那条
assert.match(
	rules.get('/_astro/*') ?? '',
	/Cache-Control:\s*public, max-age=31536000, immutable/,
	'/_astro/* 必须自己写上：适配器检测到有 public/_headers 就不再注入，少了它样式与脚本每次都要校验',
);

// 2. 图片频道：目录名直接对着 astro.config.mjs 里的 IMAGE_CHANNELS 抄，加了频道这里会红
const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
const channels = [...config.matchAll(/\{\s*dir:\s*'([^']+)'/g)].map((match) => match[1]);
assert.ok(channels.length >= 6, `只从 astro.config.mjs 里解析出 ${channels.length} 个图片频道，解析多半坏了`);
for (const dir of channels) {
	assert.match(
		rules.get(`/${dir}/*`) ?? '',
		/immutable/,
		`图片频道 /${dir}/* 没有长缓存规则：这批图的文件名带内容哈希，加一条 immutable 就行（见 public/_headers）`,
	);
}

// 字体同样是内容寻址的（`<字体>-<子集>-<sha1>.woff2`，见 scripts/fonts.mjs）
assert.match(rules.get('/fonts/*') ?? '', /immutable/, '字体也是内容寻址的，要长缓存');

// 3. 固定文件名的资源不许进长缓存
const FIXED_NAMES = ['/logo.webp', '/favicon.png', '/apple-touch-icon.png', '/universal.png', '/donate/*'];
for (const path of FIXED_NAMES) {
	assert.equal(
		rules.has(path),
		false,
		`${path} 是固定文件名：给它长缓存的话，换图之后老访客要等缓存过期才看得到`,
	);
}

console.log(`  ✓ ${channels.length} 个图片频道 + 字体 + _astro 都有长缓存，固定文件名的资源没有被误加`);
console.log('assetCache.check 通过');
