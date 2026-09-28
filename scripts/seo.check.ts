import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 全站 SEO 那几样东西的静态自检（都在 `src/layouts/Layout.astro`）。
 *
 * 这些东西的特点是**坏掉了页面照样好看、控制台也一声不吭**：从浏览器里看完全正常，
 * 只有搜索引擎或分享卡片那边少一块。已经发生过一次——结构化数据的 `@context` 丢了，
 * 节点还在、JSON 也合法，但 `@type: 'WebSite'` 绑不到 schema.org 词表上，
 * 等于整项 SEO 空转了很久没人发现。
 *
 * 所以这里钉住的都是「删掉/写坏不会报错」的那几条：
 *
 * 1. JSON-LD 必须有 `@context`（且多个节点挂在 `@graph` 下共用一个上下文）；
 * 2. `canonical` 与 `og:url` 用同一个值——两者不一致时搜索引擎按自己那套挑，等于没声明；
 * 3. 分享卡片那套（og:title/description/image、twitter:card）都在。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/seo.check.ts`）。
 */

const layout = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8');

// ---------------------------------------------------------------- 结构化数据

assert.match(
	layout,
	/inlineJson\(\{ '@context': 'https:\/\/schema\.org', '@graph': structuredData \}\)/,
	'JSON-LD 要带 @context 并挂在 @graph 下：少了 @context，@type 只是普通字符串，整项 SEO 等于没写',
);
assert.ok(layout.includes('application/ld+json'), '要把结构化数据真的输出到页面里');
assert.ok(layout.includes("'@type': 'WebSite'"), '站点节点还在');
assert.ok(layout.includes("'@type': 'WebPage'"), '页面节点还在');
// 面包屑只给详情页，序列化那份也要跟着（这里只挡「连字段都被删掉」）。
assert.ok(layout.includes("'@type': 'BreadcrumbList'"), '面包屑节点还在');

// ---------------------------------------------------------------- canonical 与分享卡片

assert.match(layout, /const canonical = new URL\(path, Astro\.site \?\? Astro\.url\)\.href/, 'canonical 要按 Astro.site 拼绝对地址');
assert.match(layout, /<link rel="canonical" href=\{canonical\} \/>/, 'canonical 要输出');

const headStart = layout.indexOf('<meta property="og:type"');
const headEnd = layout.indexOf('</head>');
assert.ok(headStart > 0 && headEnd > headStart, '没能从 Layout.astro 里切出 head 区，解析多半坏了');
const head = layout.slice(headStart, headEnd);
for (const [pattern, label] of [
	[/<meta property="og:url" content=\{canonical\} \/>/, 'og:url 必须用同一个 canonical'],
	[/<meta property="og:title" content=\{title\} \/>/, 'og:title'],
	[/<meta property="og:description" content=\{description\} \/>/, 'og:description'],
	[/<meta property="og:image" content=\{ogImage\} \/>/, 'og:image'],
	[/<meta name="twitter:card" content="summary_large_image" \/>/, 'twitter:card'],
] as const) {
	assert.match(head, pattern, `分享卡片少了 ${label}`);
}

// `<title>` 在 og 那几行之前，所以对着整份文件查。
assert.match(layout, /<title>\{title\}<\/title>/, '<title> 要跟着页面 title 走，不能写死');

console.log('seo.check 通过');
