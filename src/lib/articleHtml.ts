/**
 * 官方站点（dota2.com.cn）文章正文的抽取与清洗。
 *
 * 新闻详情页的正文是 `<div class="content">`，这里把 HTML 处理集中在一处。
 * 更新日志曾经也走这条路，现在改成了 dota2.com 的结构化 datafeed
 * （渲染在 `patchNotes.ts` 里），和这套正则无关了。
 *
 * 清洗走**白名单**，规则与用例见下面的 `sanitizeArticleHtml`。
 */

const SITE_ORIGIN = 'https://www.dota2.com.cn';

/** 官方正文里的常见实体，`&amp;` 之类的通用实体由正则兜底。 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ldquo: '“',
	rdquo: '”',
	lsquo: '‘',
	rsquo: '’',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	middot: '·',
	times: '×',
	copy: '©',
	reg: '®',
	trade: '™',
	laquo: '«',
	raquo: '»',
	deg: '°',
	bull: '•',
};

/** 把标题与摘要里的 HTML 实体还原成文本。 */
export function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => codePoint(parseInt(hex, 16), whole))
		.replace(/&#(\d+);/g, (whole, dec: string) => codePoint(Number(dec), whole))
		.replace(/&([a-z][a-z0-9]*);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function codePoint(value: number, fallback: string): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return fallback;
	try {
		return String.fromCodePoint(value);
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------- 正文清洗

/**
 * 允许保留的标签：按各来源正文里**实测出现过**的标签取（新闻、完美世界、Reddit、虎扑四路
 * 共 484 份正文实测：p / br / span / img / div / a / strong / li / ul / section / h1-h4 /
 * table 系 / code / em / ol / del），去掉 `script` / `style` / `iframe` 这些带执行能力的，
 * 也不要 `body` / `html` 这类整页标签。加来源时照着实测结果补，别凭印象加。
 */
const ALLOWED_TAGS = new Set([
	'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'figcaption', 'figure', 'h1', 'h2',
	'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'section', 'span',
	'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** 没有闭合形式的标签，别给它们配 `</x>`。 */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * 各标签允许保留的属性。表里没有的一律丢掉——`on*` 事件属性根本不在这张表上，
 * 所以不存在"漏掉某种引号写法"的问题。
 */
const ALLOWED_ATTRS: Record<string, readonly string[]> = {
	a: ['href', 'title'],
	img: ['src', 'alt', 'title', 'width', 'height'],
	td: ['colspan', 'rowspan'],
	th: ['colspan', 'rowspan'],
};

/** 标签体：两种引号都认，属性值里带 `>` 也不会被截断。 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
/** 只认「有名有值」的属性，光有名字的（`controls`）在本站这几路正文里没出现过。 */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** 文字里唯一要处理的是 `<`：它可能是被上游写坏的半截标签。 */
function escapeText(text: string): string {
	return text.replace(/</g, '&lt;');
}

/** 属性值重新拼回 HTML 前整份转义（进来时已经 `decodeEntities` 过，所以 `&` 必须重新转义）。 */
function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 地址只放行 http(s) 与没有协议的相对路径。
 *
 * 不能只判 `javascript:` 前缀：实体（`&#106;avascript:`）和控制字符（`java\tscript:`）
 * 都会被浏览器还原之后再执行，所以先 `decodeEntities`、去掉控制字符，再**按协议判**，
 * 认不出的协议返回 null，由调用方连属性一起丢掉。
 */
function safeUrl(raw: string, origin: URL): string | null {
	const value = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
	if (!value) return null;
	if (value.startsWith('//')) return `https:${value}`;
	if (value.startsWith('/')) return `${origin.origin}${value}`;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
	if (!scheme) return value;
	switch (scheme[1].toLowerCase()) {
		case 'https':
			return value;
		case 'http':
			// 上游爱留 http 的老地址，同站的换成 https，免得页面吃混合内容告警。
			return value.startsWith(`http://${origin.hostname}`) ? `https://${value.slice('http://'.length)}` : value;
		default:
			return null;
	}
}

/** 只保留白名单里的属性；地址类属性还要过一遍协议检查。 */
function sanitizeAttrs(name: string, body: string, origin: URL): string {
	const allowed = ALLOWED_ATTRS[name];
	if (!allowed) return '';
	let out = '';
	for (const match of body.matchAll(ATTR_RE)) {
		const attr = match[1].toLowerCase();
		if (!allowed.includes(attr)) continue;
		const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
		if (attr === 'src' || attr === 'href') {
			const url = safeUrl(rawValue, origin);
			if (url === null) continue;
			out += ` ${attr}="${escapeAttr(url)}"`;
			continue;
		}
		out += ` ${attr}="${escapeAttr(decodeEntities(rawValue))}"`;
	}
	// 图片一律懒加载：正文里的图往往十几张，首屏没必要全下。
	if (name === 'img') out += ' loading="lazy"';
	return out;
}

/**
 * 删掉 `<script>` / `<style>` 与注释——**连内容一起删**。
 * 只删标签的话，里面的代码会变成页面上的可见文字。
 */
function stripRawBlocks(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

export interface SanitizeArticleOptions {
	/** 相对地址（`/xxx.jpg`）按哪个站点补全。默认官方新闻站；虎扑正文要传自己的域名。 */
	baseOrigin?: string;
}

/**
 * 第三方正文 → 可安全 `set:html` 的 HTML。
 *
 * **为什么是白名单**：黑名单那版只删双引号形态的 `on\w+="…"`，还显式放行 `javascript:`，
 * 于是 `<img src=x onerror=…>`（无引号）、`<svg/onload=…>`、`<a href="javascript:…">`
 * 全都活得下来——正文来自 Reddit / 虎扑这类**用户内容**，等于把上游的一次漏网变成本站的存储型 XSS。
 * `scripts/articleHtml.check.ts` 里那组用例就是这几种写法的回归。
 *
 * 规则：
 * 1. `script` / `style` / 注释连内容一起删；
 * 2. 标签不在白名单里就丢标签、留文字；
 * 3. 属性不在白名单里就丢——`on*` 不在表里，无所谓它写成什么引号；
 * 4. 地址只认 http(s) 与相对路径，`javascript:` / `data:` 连属性一起丢；
 * 5. 文字里的 `<` 一律转义，免得半截标签（`<img src=x onerror=…` 少一个 `>`）
 *    跟后面的标记拼成真标签；
 * 6. 被丢掉的标签不会留下孤零零的闭合标签——配平用的是自己吐出去的那份栈。
 */
export function sanitizeArticleHtml(html: string, options: SanitizeArticleOptions = {}): string {
	const origin = new URL(options.baseOrigin ?? SITE_ORIGIN);
	const source = stripRawBlocks(html);
	const out: string[] = [];
	/** 已经吐出去的开放标签，用来配平闭合。 */
	const open: string[] = [];
	let last = 0;
	for (const match of source.matchAll(TAG_RE)) {
		out.push(escapeText(source.slice(last, match.index)));
		last = (match.index ?? 0) + match[0].length;
		const closing = match[1] === '/';
		const name = match[2].toLowerCase();
		if (!ALLOWED_TAGS.has(name)) continue;
		if (closing) {
			if (VOID_TAGS.has(name)) continue;
			const at = open.lastIndexOf(name);
			if (at < 0) continue;
			// 中间那些没闭合的标签一并补上，免得半个标签把后面的正文吃进去。
			while (open.length > at) out.push(`</${open.pop()}>`);
			continue;
		}
		out.push(`<${name}${sanitizeAttrs(name, match[3] ?? '', origin)}>`);
		if (!VOID_TAGS.has(name)) open.push(name);
	}
	out.push(escapeText(source.slice(last)));
	while (open.length > 0) out.push(`</${open.pop()}>`);
	return out.join('');
}

/** 找到第一个 class 恰好包含 content 的 div，返回其内容起始下标。 */
function findContentStart(html: string): number | null {
	const openRe = /<div\b[^>]*\bclass\s*=\s*"([^"]*)"[^>]*>/gi;
	for (const match of html.matchAll(openRe)) {
		if (match[1].split(/\s+/).includes('content')) return match.index + match[0].length;
	}
	return null;
}

/** 抽取官方详情页 <div class="content"> 的正文 HTML（按 div 嵌套深度配对闭合标签）。 */
export function extractArticleContent(html: string): string {
	const start = findContentStart(html);
	if (start === null) return '';
	let depth = 1;
	let end = html.length;
	const tagRe = /<\/?div\b[^>]*>/gi;
	tagRe.lastIndex = start;
	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(html))) {
		if (match[0][1] === '/') {
			depth--;
			if (depth === 0) {
				end = match.index;
				break;
			}
		} else {
			depth++;
		}
	}
	return html.slice(start, end);
}

/**
 * 官方详情页 HTML → 可直接注入页面的正文 HTML。
 *
 * **顺序不能反**：抽正文靠的是 `<div class="content">` 这个 class，而 `sanitizeArticleHtml`
 * 会把 class 属性丢掉（它只留白名单里的属性），先清洗就再也找不到容器、全部抽出空正文。
 * （这不是假设——实测 62 份新闻缓存，顺序反了就是 62 份空正文。）
 */
export function toArticleContent(html: string): string {
	return sanitizeArticleHtml(extractArticleContent(html));
}

/**
 * 从正文里取第一段有效文字作为列表页摘要。
 * 官方列表页的摘要字段是空的，只能从正文首段反推。
 */
export function summarizeArticle(contentHtml: string, maxLength = 96): string {
	for (const match of contentHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
		const text = decodeEntities(match[1].replace(/<[^>]+>/g, ' '))
			.replace(/\s+/g, ' ')
			.trim();
		if (text.length < 16) continue;
		return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
	}
	return '';
}
