import type { NewsCardItem } from '../data/types.ts';
import { escapeHtml } from './articleHtml.ts';
import { SOURCE_LABEL, type CommunityPost } from './communityPost.ts';
import { formatCount, formatMatchTime } from './format.ts';

/**
 * 资讯卡与社区帖卡的**唯一一份标记**。
 *
 * 原先这两张卡是 `.astro` 组件，只能构建期用。列表页的「加载更多」是运行时按需取下一页的，
 * 那边拼不出 Astro 组件——要么让两边各写一套标记（迟早分家），要么把标记收在这里：
 * `NewsCard.astro` / `ThreadCard.astro` 变成它的一层薄壳，运行时那条路直接用它。
 *
 * 代价是**转义得自己负责**：组件里是框架自动做的，字符串这边漏一处就是一个注入点
 * （标题与摘要有一部分来自社区用户）。所以每个用户文本都必须过 `escapeHtml`，
 * 自检里也钉了一条「标题里的尖括号不许原样出现在输出里」。
 */

/** 卡片的公共外壳：可点整卡是 `<a>`，没有链接的是 `<article>`。 */
function cardTag(href: string | undefined, className: string, inner: string): string {
	if (!href) return `<article class="${className}">${inner}</article>`;
	const external = href.startsWith('http');
	const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
	return `<a href="${escapeHtml(href)}"${attrs} class="${className}">${inner}</a>`;
}

const ARROW =
	'<svg class="ml-auto h-4 w-4 shrink-0 transition group-hover:translate-x-0.5 group-hover:text-gold" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
	'<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' +
	'</svg>';

/** 资讯卡（官网新闻、完美世界、Reddit 共用一个形状）。 */
export function renderNewsCard(item: NewsCardItem): string {
	const shell = [
		'group flex gap-4 rounded-2xl border p-4 transition',
		item.featured
			? 'border-dota/40 bg-gradient-to-br from-dota/10 to-surface hover:border-dota'
			: 'border-line bg-surface hover:border-dota/40 hover:bg-surface-2',
	].join(' ');

	const thumb = item.img
		? `<img src="${escapeHtml(item.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="h-24 w-32 shrink-0 rounded-xl border border-line object-cover transition group-hover:border-dota/40 sm:h-28 sm:w-40" />`
		: '<span class="flex h-24 w-32 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2 font-display text-lg text-faint sm:h-28 sm:w-40">资讯</span>';

	const badgeClass = item.badge ? 'bg-gold/15 text-gold' : 'bg-dota/15 text-dota-light';
	const tags = item.tags.map((tag) => `<span class="text-faint">${escapeHtml(tag)}</span>`).join('');
	const originalTitle = item.originalTitle
		? `<p class="mt-1 line-clamp-1 text-xs text-faint">${escapeHtml(item.originalTitle)}</p>`
		: '';
	const summary = item.summary
		? `<p class="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">${escapeHtml(item.summary)}</p>`
		: '';

	const body =
		`<div class="flex min-w-0 flex-1 flex-col">` +
		`<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">` +
		`<span class="rounded px-2 py-0.5 font-semibold ${badgeClass}">${escapeHtml(item.badge ?? '官方信息')}</span>` +
		`${tags}<span class="ml-auto shrink-0 text-faint">${escapeHtml(item.date)}</span></div>` +
		`<h3 class="mt-2 line-clamp-2 font-display leading-snug transition group-hover:text-dota-light">${escapeHtml(item.title)}</h3>` +
		`${originalTitle}${summary}` +
		`<div class="mt-auto flex items-center gap-2 pt-3 text-xs text-faint">` +
		`<span class="truncate">${escapeHtml(item.meta)}</span>${item.href ? ARROW : ''}</div>` +
		`</div>`;

	return cardTag(item.href, shell, thumb + body);
}

/** 社区帖卡（NGA / 虎扑）。 */
export function renderThreadCard(post: CommunityPost, nowSec: number): string {
	const shell =
		'group flex h-full flex-col rounded-2xl border border-line bg-surface p-4 transition hover:border-dota/40 hover:bg-surface-2';

	const summary = post.summary
		? `<p class="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">${escapeHtml(post.summary)}</p>`
		: '';
	const views = post.views
		? `<span aria-hidden="true">·</span><span title="浏览量">${formatCount(post.views)} 浏览</span>`
		: '';

	const inner =
		`<div class="flex items-start gap-3">` +
		`<h3 class="min-w-0 flex-1 font-display leading-snug transition group-hover:text-dota-light">${escapeHtml(post.title)}</h3>` +
		`<span class="shrink-0 rounded-md bg-gold/15 px-2 py-1 text-xs font-semibold text-gold">${post.replies} 回复</span>` +
		`</div>${summary}` +
		`<div class="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-xs text-faint">` +
		`<span class="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold text-muted">${escapeHtml(SOURCE_LABEL[post.source])}</span>` +
		`<span class="truncate">${escapeHtml(post.author)}</span>` +
		`<span aria-hidden="true">·</span><span>最后回复 ${formatMatchTime(post.lastReplyAt, nowSec)}</span>` +
		`${views}${ARROW}</div>`;

	return cardTag(post.href, shell, inner);
}
