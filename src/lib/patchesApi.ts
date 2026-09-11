import { toArticleContent } from './articleHtml';

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

/**
 * 构建期抓取官方文章，返回清洗后的正文 HTML（去脚本/样式/内联样式）。
 * 官方文章无 CORS 头，仅能在 Node 构建期请求。
 */
export async function fetchArticle(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return toArticleContent(await res.text());
}
