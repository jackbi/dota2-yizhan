const LIST_BASE = 'https://www.dota2.com.cn/news/gamepost';

export interface PatchUpdate {
	title: string;
	date: string;
	href: string;
	img: string;
	version: string;
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
