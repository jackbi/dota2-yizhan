/**
 * 把 Google Fonts 的两个字体家族取回本地，改成本站自托管。
 *
 *   node scripts/fonts.mjs
 *
 * 产出：
 *   public/fonts/<家族>-<字重>-<子集>-<哈希>.woff2   （19 个文件，约 200 KB）
 *   src/styles/fonts.css                              @font-face，url 指向 /fonts/
 *
 * 为什么不再直接引 fonts.googleapis.com：
 *
 * - **它在中国大陆是连不通的**（fonts.gstatic.com 同样），也就是绝大多数访客其实
 *   一直在看回退字体——`Russo One` 和 `Chakra Petch` 根本没生效，而且首屏还要多等
 *   一次必然失败的跨域请求。
 * - 少一个第三方请求，就少一次 DNS / TLS 握手，也不用再为了绕开渲染阻塞去写
 *   `media="print"` + `onload` 那一套。
 *
 * 脚本保留 Google 的 `unicode-range` 分片方式：中文走 PingFang SC / 微软雅黑，
 * 这两个拉丁字体只在页面真的出现拉丁字符时才下载对应的那一片，所以 19 个文件里
 * 一个页面通常只会取 1～5 个。
 *
 * 字体文件是**构建产物**，和 public/ 下的 logo 一样提交进仓库（这是静态资源，
 * 不是抓取缓存）。换字体、换字重、或者 Google 发新版本时重跑这个脚本即可。
 *
 * 本机到 fonts.gstatic.com 会被重置，脚本走 Node 的 env 代理：
 *   NODE_USE_ENV_PROXY=1 http_proxy=http://127.0.0.1:7890 node scripts/fonts.mjs
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CSS_URL =
	'https://fonts.googleapis.com/css2?family=Russo+One&family=Chakra+Petch:wght@400;500;600;700&display=swap';

/** 必须是现代浏览器的 UA：给老 UA 时 Google 只会返回 ttf，没有 woff2 和 unicode-range。 */
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ROOT = path.resolve(import.meta.dirname, '..');
const FONT_DIR = path.join(ROOT, 'public', 'fonts');
const CSS_FILE = path.join(ROOT, 'src', 'styles', 'fonts.css');

/** `/* latin *\/` + 紧跟的 @font-face 块；Google 的 CSS 恰好每个分片一段。 */
const BLOCK_RE = /\/\* ([\w-]+) \*\/\s*(@font-face \{[^}]+\})/g;

const FAMILY_SLUG = {
	'Russo One': 'russo-one',
	'Chakra Petch': 'chakra-petch',
};

function field(block, name) {
	return new RegExp(`\\b${name}:\\s*([^;]+);`).exec(block)?.[1].trim() ?? '';
}

/** 两条路都会偶发失败，重试几轮；全挂了就把「怎么带代理」写在报错里。 */
async function get(url) {
	let last;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const res = await fetch(url, { headers: { 'User-Agent': UA } });
			if (res.ok) return res;
			last = new Error(`HTTP ${res.status}`);
		} catch (error) {
			last = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 800));
	}
	throw new Error(
		`取不到 ${url}（${last?.message ?? last}）。\n` +
			'本机到 fonts.googleapis.com / fonts.gstatic.com 的连接会被重置，带代理再跑：\n' +
			'  NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7890 pnpm fonts',
	);
}

async function main() {
	const css = await (await get(CSS_URL)).text();

	await fs.mkdir(FONT_DIR, { recursive: true });
	const keep = new Set();
	const out = [
		'/*',
		' * 自托管字体：由 `node scripts/fonts.mjs` 生成，不要手改，改脚本。',
		' *',
		' * 每个 @font-face 对应 Google 的一个 unicode-range 分片：浏览器只会下载页面',
		' * 真的用到的那几片。中文不走这里（回退到 PingFang SC / 微软雅黑）。',
		' */',
		'',
	];

	let index = 0;
	for (const [, subset, block] of css.matchAll(BLOCK_RE)) {
		const family = field(block, 'font-family').replace(/['"]/g, '');
		const weight = field(block, 'font-weight');
		const slug = FAMILY_SLUG[family] ?? family.toLowerCase().replace(/\s+/g, '-');
		const source = /url\((\S+?)\)/.exec(block)?.[1];
		if (!source) throw new Error(`${family} ${weight} ${subset} 没有 url`);

		const bytes = Buffer.from(await (await get(source)).arrayBuffer());
		const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
		const name = `${slug}-${weight}-${subset}-${hash}.woff2`;
		await fs.writeFile(path.join(FONT_DIR, name), bytes);
		keep.add(name);
		index += 1;
		process.stdout.write(`\r下载 ${index} 个字体分片…`);
		out.push(`/* ${family} ${weight} · ${subset} */`);
		out.push(block.replace(source, `/fonts/${name}`));
		out.push('');
	}
	process.stdout.write('\r');

	await fs.writeFile(CSS_FILE, `${out.join('\n').trimEnd()}\n`, 'utf8');

	// 重跑之后 Google 可能换了文件名，清掉不在本轮清单里的旧文件，别越攒越多。
	let removed = 0;
	for (const name of await fs.readdir(FONT_DIR)) {
		if (keep.has(name)) continue;
		await fs.rm(path.join(FONT_DIR, name), { force: true });
		removed += 1;
	}

	const total = (
		await Promise.all([...keep].map(async (name) => (await fs.stat(path.join(FONT_DIR, name))).size))
	).reduce((sum, size) => sum + size, 0);
	console.log(
		`${keep.size} 个分片（${(total / 1024).toFixed(1)} KB）→ public/fonts/` +
			(removed > 0 ? `，清掉 ${removed} 个旧文件` : '') +
			`\n@font-face → ${path.relative(ROOT, CSS_FILE)}`,
	);
}

await main();
