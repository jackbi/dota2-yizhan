import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 自托管字体的自检。
 *
 * `src/styles/fonts.css` 是 `scripts/fonts.mjs` 生成的，它引用的 woff2 全在
 * `public/fonts/` 里。这份对应关系坏掉时**页面不会报错**——浏览器只是悄悄回退到
 * 系统字体，字重和字形都还在，肉眼很难发现。所以在这里钉死三条：
 * 引用得到文件、文件都被引用、以及没有任何地方又跑回去连 Google。
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const CSS = path.join(ROOT, 'src', 'styles', 'fonts.css');
const DIR = path.join(ROOT, 'public', 'fonts');
const SRC = path.join(ROOT, 'src');

const css = await fs.readFile(CSS, 'utf8');
const referenced = new Set([...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => path.basename(m[1])));
const present = new Set(await fs.readdir(DIR));

const missing = [...referenced].filter((name) => !present.has(name));
const orphan = [...present].filter((name) => !referenced.has(name));
assert.deepEqual(missing, [], 'fonts.css 引用了不存在的字体文件，重跑 `pnpm fonts`');
assert.deepEqual(orphan, [], 'public/fonts 里有没人引用的文件，重跑 `pnpm fonts` 清理');

// 两个家族的实际用到的字重，少一个都会静默回退——`--font-body` 用的是 400/500/600/700。
for (const need of [
	'chakra-petch-400-latin-',
	'chakra-petch-500-latin-',
	'chakra-petch-600-latin-',
	'chakra-petch-700-latin-',
	'russo-one-400-latin-',
]) {
	assert.ok(
		[...referenced].some((name) => name.startsWith(need)),
		`fonts.css 里没有 ${need}（global.css 的字体栈要用它）`,
	);
}
assert.ok(css.includes("font-family: 'Russo One'"), 'Russo One 没了');
assert.ok(css.includes("font-family: 'Chakra Petch'"), 'Chakra Petch 没了');
assert.ok(css.includes('font-display: swap'), '缺 font-display: swap，首屏会等字体');

// `unicode-range` 是省流量的关键：中文不进这两个字体，浏览器只下拉丁那一片。
assert.ok(/unicode-range:\s*U\+0000-00FF/.test(css), '缺 unicode-range，浏览器会把 19 个分片全下下来');

// --- 别再引回第三方 ---
async function walk(dir) {
	const out = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (/\.(astro|ts|css|mjs|js)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** 把注释剥掉再查域名：Layout.astro 的注释里就留着这两个域名，用来说明为什么不用它们。 */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const offenders = [];
for (const file of await walk(SRC)) {
	const code = stripComments(await fs.readFile(file, 'utf8'));
	for (const line of code.split('\n')) {
		if (/fonts\.(googleapis|gstatic)\.com/.test(line)) {
			offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
		}
	}
}
assert.deepEqual(offenders, [], 'src 里还有人引 Google Fonts 的域名');

console.log(`fonts 全部断言通过（${referenced.size} 个分片，引用与文件一一对应）`);
