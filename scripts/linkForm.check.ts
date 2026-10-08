import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

/**
 * 站内链接形态的自检：**预渲染页带尾斜杠、SSR 路由按各自的收口形式**。
 *
 * 为什么值得单开一条：**形态错了页面照样能看**。Cloudflare 的静态资源规则会把 `/heroes/1`
 * 307 到 `/heroes/1/`，访客只是多一跳，肉眼看不出来；但对搜索引擎来说，站内每一条链接都指向
 * 一个「会重定向的地址」——2026-10 的 Search Console 报告里，「网页会自动重定向」那一栏堆的
 * 就是自己交上去的一批这种 URL。改起来只是一行一行加斜杠，但**没人盯着就会退回去**，所以钉两条：
 *
 * 1. **形态**：预渲染页的链接一律带尾斜杠（那才是它的规范形态，sitemap 与 canonical 也是这个）；
 *    SSR 路由按页面自己的收口形式——`/login`、`/me/*`、`/heroes/<id>/guides`、`/replay/<id>`
 *    不带斜杠，`/party/` 带（它是唯一一个反过来的，页面里 301 到带斜杠那版）。
 * 2. **存在**：链接要指到一个真实存在的页面。动态路由的 `[参数]` 与模板里的 `${…}` 都按
 *    「不确定的一段」参与匹配，于是 `/heroes/${id}/` 能对上 `src/pages/heroes/[id].astro`，
 *    而 `/heroes/${id}/nope/` 对不上任何页面，会当场报出来。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/linkForm.check.ts`）。
 */

const SRC = new URL('../src/', import.meta.url);
const PAGES = new URL('pages/', SRC);

/** 模板里的 `${…}` 在检查里换成这个占位符，匹配路由时按「一段」处理。 */
const HOLE = '\u0000';

// ---------------------------------------------------------------- 抠链接

/** 读一个字符串/模板字面量。里面的 `${…}` 一律换成占位符——它是一段不确定的值。 */
function readLiteral(source: string, at: number): { text: string; end: number } {
	const open = source[at];
	if (open === '"' || open === "'") {
		let i = at + 1;
		while (i < source.length && source[i] !== open) i += source[i] === '\\' ? 2 : 1;
		// 普通字符串里也能插值（`patchNotes` 那种拼 HTML 的写法），一样按占位符算。
		return { text: collapse(source.slice(at + 1, i)), end: i + 1 };
	}

	let text = '';
	let i = at + 1;
	while (i < source.length) {
		const char = source[i];
		if (char === '\\') {
			text += source.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (char === '`') break;
		if (char === '$' && source[i + 1] === '{') {
			i = skipBraces(source, i + 1);
			text += HOLE;
			continue;
		}
		text += char;
		i += 1;
	}
	return { text: collapse(text), end: i + 1 };
}

/** 把 `${…}` 折叠成占位符（模板里已经折过一遍，普通字符串靠这里）。 */
function collapse(text: string): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '$' && text[i + 1] === '{') {
			i = skipBraces(text, i + 1);
			out += HOLE;
			continue;
		}
		out += text[i];
		i += 1;
	}
	return out;
}

/** `source[at]` 是 `{`，返回与它配对的 `}` 之后那一位。 */
function skipBraces(source: string, at: number): number {
	let depth = 0;
	let i = at;
	while (i < source.length) {
		const char = source[i];
		if (char === '"' || char === "'" || char === '`') {
			i = readLiteral(source, i).end;
			continue;
		}
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
		i += 1;
	}
	return source.length;
}

/** 收集 `href="…"`、`href={\`…\`}`、`href: '…'`、`href: \`…\`` 四种写法的值。 */
function hrefsIn(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/href\s*[:=]\s*/g)) {
		let at = match.index + match[0].length;
		if (source[at] === '{') at += 1;
		const quote = source[at];
		if (quote !== '"' && quote !== "'" && quote !== '`') continue;
		found.push(readLiteral(source, at).text);
	}
	return found;
}

/**
 * 「链接地址变量」里的路径：`const backHref = eventExists ? \`/tournaments/${id}\` : '/tournaments'`。
 *
 * 这一遍是补 `href` 那一遍的漏：`href={backHref}` 上一个字面量都没有，光扫 `href` 抠不出东西来
 * ——实测就是这么漏掉一批比赛页的「返回赛事」链接的（它们全都 307 到带斜杠那版）。所以按
 * 「变量名里带 href」找声明语句，只在那几行里收路径字面量，别处（注释、接口路径、正则）一律不碰。
 */
function hrefVariablePaths(source: string): string[] {
	const found: string[] = [];
	for (const line of source.split('\n')) {
		if (!/\b(?:const|let|var)\s+\w*[Hh]ref\w*\s*=/.test(line)) continue;
		for (let i = 0; i < line.length; i += 1) {
			const char = line[i];
			if (char !== '"' && char !== "'" && char !== '`') continue;
			const { text, end } = readLiteral(line, i);
			i = end - 1;
			/*
			 * 只认「一整个看着就像路径」的：路径里不会有空格、引号、括号。这条同时挡掉正则字面量
			 * 里的引号被当成字符串开头的情况（`whole.match(/\bhref\s*=\s*"([^"]*)"/i)` 就是那样
			 * 读出一串垃圾来的）。
			 */
			if (text.startsWith('/') && !/[\s"'`()<>]/.test(text)) found.push(text);
		}
	}
	return found;
}

function listFiles(dir: URL, extension: RegExp): URL[] {
	const out: URL[] = [];
	for (const entry of readdirSync(dir)) {
		const child = new URL(entry, dir);
		if (statSync(child).isDirectory()) out.push(...listFiles(new URL(`${entry}/`, dir), extension));
		else if (extension.test(entry)) out.push(child);
	}
	return out;
}

// ---------------------------------------------------------------- 路由表

/** 路由路径 → 是否 SSR。动态段保持 `[参数]` 写法，比对时按「一段」处理。 */
function collectRoutes(dir: URL, prefix: string, out: Map<string, boolean>): void {
	for (const entry of readdirSync(dir)) {
		const child = new URL(entry, dir);
		if (statSync(child).isDirectory()) {
			collectRoutes(new URL(`${entry}/`, dir), `${prefix}${entry}/`, out);
			continue;
		}
		if (!entry.endsWith('.astro') || entry === '404.astro') continue;
		const name = entry.slice(0, -'.astro'.length);
		const route = name === 'index' ? prefix : `${prefix}${name}`;
		out.set(route, /export const prerender = false/.test(readFileSync(child, 'utf8')));
	}
}

const ROUTES = new Map<string, boolean>();
collectRoutes(PAGES, '/', ROUTES);

/*
 * SSR 路由的规范形态：**不带**尾斜杠。预渲染页的斜杠那套是 Cloudflare 静态资源规则定的；
 * SSR 路由由 Worker 直接处理，两种写法都会 200，而 canonical 是照 `Astro.url.pathname` 拼的，
 * 于是两个地址各指自己、Google 只能自己挑（docs/seo.md 记过这条）。页面自己把另一边 301 走，
 * 是唯一能让「只留一种」成立的做法——所以这里也只认那一种。
 */
/** 例外：`/party` 收口到带斜杠那版（页面里 301），链接也跟着写带斜杠。 */
const SSR_WITH_SLASH = new Set(['/party']);

/*
 * 每个路由的**规范形态**：预渲染页带尾斜杠，SSR 路由不带（`/party` 例外）。这份清单是唯一的判据——
 * 链接先按「`${…}` 与 `[参数]` 都是一段」变成正则，再去套规范形态，套不上就是不合法。
 * 于是「少了尾斜杠」与「指向不存在的页面」是同一套判断的两面，不需要各写一遍。
 */
const CANONICAL = [...ROUTES].map(([route, ssr]) =>
	ssr && !SSR_WITH_SLASH.has(route) ? route : route === '/' ? '/' : `${route}/`,
);

/*
 * 反向也验一遍：SSR 路由的清单得和页面文件对得上——加了新 SSR 路由却没想好它用哪种形态，
 * 或者哪天把 `prerender = false` 删了，都会在这里露出来。**这条是给未来的自己留的。**
 */
{
	const known = [/^\/login$/, /^\/me(\/.*)?$/, /^\/heroes\/[^/]+\/guides$/, /^\/replay\/[^/]+$/];
	for (const [route, ssr] of ROUTES) {
		if (!ssr) continue;
		const plain = route.replace(/\[[^\]]+\]/g, 'segment');
		assert.ok(
			known.some((pattern) => pattern.test(plain)) || SSR_WITH_SLASH.has(plain),
			`SSR 路由 ${route} 没在这份检查的收口清单里：先定好它用哪种形态，再把它补进来`,
		);
	}
}

// ---------------------------------------------------------------- 逐条核对

/** 把 `/heroes/${id}/` 这类路径（`${…}` 已换成占位符）变成匹配路由用的正则。 */
function matcher(route: string): RegExp {
	const body = route
		.split('/')
		.map((segment) => {
			if (/^\[[^\]]+\]$/.test(segment)) return '[^/]*';
			const escape = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			/*
			 * 占位符可能连着别的字面量（`/me/peers${option > 1 ? '?min=…' : ''}` 折出来是
			 * `/me/peers<占位符>`），所以按占位符切一刀，逐段转义、中间接 `[^/]+`。
			 * 用 `+` 而不是 `*`：`/heroes/${id}` 这种漏了尾斜杠的写法不能因为「空串也算一段」
			 * 就对上 `/heroes/` 那条列表路由。
			 */
			return segment.split(HOLE).map(escape).join('[^/]+');
		})
		.join('/');
	return new RegExp(`^${body}$`);
}

/**
 * 这条链接指向的页面存在吗？拿链接的正则去套每个路由的规范形态。
 *
 * 末尾那个占位符还可能整段是个查询串（`/me/peers${option > 1 ? '?min=…' : ''}`），
 * 那种情况下它在路径里是**不存在**的，所以再拿「去掉末尾占位符」的版本试一次。
 */
const hitsPage = (pathname: string): boolean => {
	/*
	 * 只有当那个占位符**粘在某个路径段尾巴上**时才回落（`/me/peers${option > 1 ? '?min=…' : ''}`
	 * 折出来就是 `/me/peers<占位符>`，整段其实就是查询串）。自己单独占一段的
	 * （`/heroes/${id}` 漏了尾斜杠那种）不能回落，否则会把它当成 `/heroes/` 列表页放过去。
	 */
	const glued = pathname.endsWith(HOLE) && pathname.at(-2) !== '/';
	const candidates = glued ? [pathname, pathname.slice(0, -1)] : [pathname];
	return candidates.some((candidate) => {
		const link = matcher(candidate);
		return CANONICAL.some((route) => link.test(route));
	});
};

/** 图片、脚本、接口这些不是页面，形态随便；`/api/` 与 `/` 也不在检查范围。 */
const NOT_A_PAGE = /\.(png|jpe?g|webp|svg|ico|txt|xml|json|css|js|mjs|map|woff2?|ttf|mp4|webm)$/i;

let checked = 0;
const problems: string[] = [];
/** 报错时把不可见的占位符还原成读得懂的样子。 */
const show = (raw: string): string => raw.replaceAll(HOLE, '${…}');
for (const file of listFiles(SRC, /\.(astro|ts)$/)) {
	const where = file.pathname.replace(SRC.pathname, 'src/');
	const source = readFileSync(file, 'utf8');
	for (const raw of new Set([...hrefsIn(source), ...hrefVariablePaths(source)])) {
		if (!raw.startsWith('/') || raw.startsWith('//')) continue;
		const cut = raw.search(/[?#]/);
		const pathname = (cut < 0 ? raw : raw.slice(0, cut)).replace(/\/{2,}/g, '/');
		if (pathname === '/' || pathname.startsWith('/api/') || NOT_A_PAGE.test(pathname)) continue;
		checked += 1;
		if (hitsPage(pathname)) continue;
		// 补一个斜杠就对了的，报「少了尾斜杠」；否则就是指向了根本不存在的页面。
		const hint = pathname.endsWith('/')
			? ''
			: hitsPage(`${pathname}/`)
				? '（预渲染页要带尾斜杠，这里少了）'
				: '（也对不上任何页面）';
		problems.push(`${where} → ${show(raw)}${hint}`);
	}
}

assert.deepEqual(problems, [], `站内链接有 ${problems.length} 处不合规：\n${problems.join('\n')}`);
// 抠链接的规则坏掉（比如正则写错）会一条都扫不到，所以留一条底。数字是「每个文件里不同的链接」，
// 同一个链接在同一个文件里出现多次只算一条。
assert.ok(checked > 80, `只扫到 ${checked} 条站内链接，抠链接的规则多半坏了`);

console.log(`  ✓ ${checked} 条站内链接：形态与落地页都对得上`);
console.log('linkForm.check 通过');
