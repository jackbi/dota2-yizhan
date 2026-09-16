/**
 * 官方站点（dota2.com.cn）文章正文的抽取与清洗。
 *
 * 新闻详情页的正文是 `<div class="content">`，这里把 HTML 处理集中在一处。
 * 更新日志曾经也走这条路，现在改成了 dota2.com 的结构化 datafeed
 * （渲染在 `patchNotes.ts` 里），和这套正则无关了。
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

/** 官方正文里的相对地址（如 /news20160808/images/x.jpg）放到站外会 404，统一补成绝对地址。 */
function resolveUrl(url: string): string {
	if (!url || /^(?:data:|mailto:|javascript:|#)/i.test(url)) return url;
	if (url.startsWith('//')) return `https:${url}`;
	if (url.startsWith('/')) return `${SITE_ORIGIN}${url}`;
	return url.replace(/^http:\/\/([\w.-]*dota2\.com\.cn)/i, 'https://$1');
}

/** 去掉脚本、样式、内联样式与事件属性，并把图片来源改成懒加载。 */
export function sanitizeArticleHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\sstyle="[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\s(?:contenteditable|tabindex|draggable)\s*=\s*"[^"]*"/gi, '')
		.replace(/(\s(?:src|href)\s*=\s*")([^"]*)"/gi, (_whole, prefix: string, url: string) => `${prefix}${resolveUrl(url)}"`)
		.replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy"');
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

/** 官方详情页 HTML → 可直接注入页面的正文 HTML。 */
export function toArticleContent(html: string): string {
	return extractArticleContent(sanitizeArticleHtml(html));
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
