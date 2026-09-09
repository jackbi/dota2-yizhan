const LIST_BASE = 'https://www.dota2.com.cn/news/gamepost';

export interface PatchUpdate {
	title: string;
	date: string;
	href: string;
	img: string;
	version: string;
	id: string;
}

const ITEM_RE =
	/<a href="(https:\/\/www\.dota2\.com\.cn\/article\/details\/[^"]+)" class="item"[^>]*>[\s\S]*?<div class="news_logo"><img src="([^"]+)" alt="([^"]*)"[^>]*>[\s\S]*?<h2 class="title">([^<]+)<\/h2>[\s\S]*?<p class="date">([^<]+)<\/p>/g;

function parseList(html: string): PatchUpdate[] {
	const out: PatchUpdate[] = [];
	for (const m of html.matchAll(ITEM_RE)) {
		const title = m[4].replace(/&amp;/g, '&').trim();
		out.push({
			href: m[1],
			img: m[2],
			title,
			date: m[5].trim(),
			version: title.match(/\d+(?:\.\d+)+[a-z]?/)?.[0] ?? title,
			id: articleIdFromHref(m[1]),
		});
	}
	return out;
}

/**
 * 构建时抓取官方「更新日志」列表页并解析条目。
 * 官方页面为 HTML 且无 CORS 头，浏览器无法 fetch，故仅在构建期（Node）使用。
 */
export async function fetchPatchUpdates(pages = 3): Promise<PatchUpdate[]> {
	const seen = new Set<string>();
	const all: PatchUpdate[] = [];
	for (let p = 1; p <= pages; p++) {
		const url = p === 1 ? `${LIST_BASE}/index1.htm` : `${LIST_BASE}/index${p}.htm`;
		let text: string;
		try {
			const res = await fetch(url);
			if (!res.ok) break;
			text = await res.text();
		} catch {
			break;
		}
		for (const item of parseList(text)) {
			if (seen.has(item.href)) continue;
			seen.add(item.href);
			all.push(item);
		}
		if (all.length === 0) break;
	}
	return all;
}

function articleIdFromHref(href: string): string {
	return href.match(/\/(\d+)\.html$/)?.[1] ?? href;
}

/** 抽取官方详情页 <div class="content"> 的正文 HTML，去掉内联样式。 */
function extractContent(html: string): string {
	const openTag = '<div class="content">';
	const start = html.indexOf(openTag);
	if (start < 0) return '';
	const contentStart = start + openTag.length;
	let depth = 1;
	const re = /<\/?div\b[^>]*>/gi;
	re.lastIndex = contentStart;
	let end = html.length;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[0][1] === '/') {
			depth--;
			if (depth === 0) {
				end = m.index;
				break;
			}
		} else if (/<div[ >]/i.test(m[0])) {
			depth++;
		}
	}
	return html.slice(contentStart, end);
}

/**
 * 构建期抓取官方文章，返回清洗后的正文 HTML（去脚本/样式/内联样式）。
 * 官方文章无 CORS 头，仅能在 Node 构建期请求。
 */
export async function fetchArticle(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const html = (await res.text())
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\sstyle="[^"]*"/g, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\s(?:contenteditable|tabindex|draggable)\s*=\s*"[^"]*"/gi, '')
		.replace(/http:\/\/(www\.|cdn\.|img\.)?dota2\.com\.cn/gi, (m) => 'https://' + m.replace(/^http:\/\//, ''));
	return extractContent(html);
}
