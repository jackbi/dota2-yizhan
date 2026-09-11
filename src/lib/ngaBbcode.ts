import { decodeEntities } from './articleHtml';

/**
 * NGA 帖子正文的 BBCode 渲染。
 *
 * 实测一份 22 帖 369 楼的样本，正文里出现的 HTML 标签只有 `<br/>`，
 * BBCode 只有 b / del / quote / img / url / uid / pid / tid / collapse / s:表情 这几种，
 * 所以这里只做这一小撮标签的转换，其余标签一律去掉标签、保留文字。
 *
 * 安全前提：正文是用户内容，必须先反转义再统一转义，最后才做 BBCode → HTML 替换，
 * 这样正文里出现的任何尖括号都不可能变成标签；URL 也要过滤掉非 http(s) 的协议。
 */

const ATTACHMENT_BASE = 'https://img.nga.cn/attachments/';
const NGA_ORIGIN = 'https://bbs.nga.cn';
/** 图片来源白名单：绝对地址、站内绝对路径，或 `./mon_xxx/...` 形式的附件。 */
const IMAGE_SRC_RE = /^(?:https?:\/\/|\/\/|\/|\.\/|mon_\d)/i;

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 附件在正文里是 `./mon_202609/07/xxx.jpg` 这样的相对路径。 */
function imageUrl(raw: string): string {
	const url = raw.trim();
	if (/^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
	if (url.startsWith('//')) return `https:${url}`;
	if (url.startsWith('./')) return ATTACHMENT_BASE + url.slice(2);
	if (url.startsWith('/')) return `${NGA_ORIGIN}${url}`;
	return ATTACHMENT_BASE + url;
}

function anchor(rawHref: string, label: string): string {
	const href = rawHref.trim();
	if (!/^https?:\/\//i.test(href)) return label;
	return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
}

/** 表情图片在 img4.ngacn.cc / img4.nga.178.com 上，部分网络不可达，统一渲染成文字标签。 */
function emote(rawName: string): string {
	const name = rawName.split(':').pop()?.trim() || rawName.trim();
	return `<span class="nga-emote">${name}</span>`;
}

/**
 * 从楼层正文里收集 `[uid=123]昵称[/uid]`。
 * 接口对未登录访问会把昵称统一打码成 `UID:123`，只有引用里带着真实昵称，
 * 所以这是站内唯一能拿到回复者昵称的来源。
 */
export function collectNicknames(contents: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const content of contents) {
		for (const match of content.matchAll(/\[uid=(\d+)\]([^[]+)\[\/uid\]/gi)) {
			const name = match[2].trim();
			if (name && !/^UID:?\d+$/i.test(name)) map.set(match[1], name);
		}
	}
	return map;
}

/** 把一层楼的 BBCode 正文渲染成可安全注入的 HTML。 */
export function renderNgaPost(bbcode: string): string {
	// 先把官方换行统一成 \n，再反转义 & 转义，之后才允许出现我们自己生成的标签。
	let text = bbcode.replace(/<br\s*\/?>/gi, '\n');
	text = escapeHtml(decodeEntities(text));

	// 折叠块要在其它标签之前处理，内部内容照常参与后续替换。
	text = text.replace(
		/\[collapse(?:=([^\]]*))?\]([\s\S]*?)\[\/collapse\]/gi,
		(_whole, title: string | undefined, inner: string) =>
			`<details class="nga-collapse"><summary>${title?.trim() || '展开'}</summary><div>${inner}</div></details>`,
	);
	text = text.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, (_whole, inner: string) => `<blockquote class="nga-quote">${inner}</blockquote>`);
	text = text.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_whole, src: string) => {
		if (!IMAGE_SRC_RE.test(src.trim())) return '';
		const url = imageUrl(src);
		return /^https:\/\//i.test(url)
			? `<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
			: '';
	});
	text = text.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_whole, href: string, label: string) => anchor(href, label));
	text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_whole, href: string) => anchor(href, href));
	text = text.replace(
		/\[uid=(\d+)\]([\s\S]*?)\[\/uid\]/gi,
		(_whole, uid: string, label: string) =>
			`<a href="${NGA_ORIGIN}/nuke.php?func=ucp&uid=${uid}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`,
	);
	text = text.replace(
		/\[pid=([\d,]+)\]([\s\S]*?)\[\/pid\]/gi,
		(_whole, ids: string, label: string) =>
			`<a href="${NGA_ORIGIN}/read.php?pid=${ids.split(',')[0]}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`,
	);
	text = text.replace(
		/\[tid=(\d+)\]([\s\S]*?)\[\/tid\]/gi,
		(_whole, tid: string, label: string) =>
			`<a href="${NGA_ORIGIN}/read.php?tid=${tid}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`,
	);
	text = text.replace(/\[s:([^\]]{1,24})\]/gi, (_whole, name: string) => emote(name));
	text = text.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>');
	text = text.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>');
	text = text.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>');
	text = text.replace(/\[del\]([\s\S]*?)\[\/del\]/gi, '<del>$1</del>');

	// 剩下没处理的标签只去掉标记本身。
	text = text.replace(/\[[^\]\n]{0,40}\]/g, '');
	return text
		.split('\n')
		.map((line) => line.trim())
		.join('<br/>');
}
