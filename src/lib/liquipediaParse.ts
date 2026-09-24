import type { EsportsMatch } from '../data/types';
import { routeSlug } from './routeSlug.ts';

/**
 * Liquipedia 赛程解析：纯函数，不碰网络也不碰文件系统。
 *
 * 单独成一个模块的理由与 `guideBuild.ts` 相同——`scripts/liquipedia.check.ts` 要直接 import 它，
 * 而 `liquipediaApi.ts` 引了 `buildCache`（node:fs），自检在 Node 里跑不起来。
 *
 * 这里要认**两种页面**，它们的内层结构是一样的（timer-object + match-info-header + block-team）：
 *
 * - 主赛程页 `Liquipedia:Matches`：一场一个 `<div class="match-info">`，但它只是**滚动窗口**
 *   （未来赛程 + 近期赛果），一届赛事打久了前面的对阵会滚出去；
 * - 赛事页与阶段子页：bracket 模板，每场的详情在隐藏弹层 `brkts-match-info-popup` 里，是完整的。
 */

const slug = routeSlug;

interface ParsedTeam {
	name: string;
	short: string;
	logo?: string;
}

/*
 * `class` 后面必须允许跟别的类名：Liquipedia 对**只有亮色队标**的队伍会输出
 * `class="team-template-image-icon team-template-lightmode"`（如 Team Nemesis、Team Lynx）。
 * 要求 class 恰好等于 `team-template-image-icon` 时这类队伍解析成空，而调用方是
 * 「一方未定就跳过整场」，于是连对手一起丢——实测主赛程页 100 场里丢 56 场，
 * 其中 29 场是这个原因，包括 Xtreme Gaming vs Team Nemesis（9013522151 那场）。
 */
const TEAM_ANCHOR_RE = /team-template-image-icon[^"]*">\s*<a[^>]*title="([^"]*)"/;
const TEAM_SHORT_RE = /<span class="name"[^>]*>\s*<a[^>]*>([^<]*)<\/a>/;
const TEAM_LOGO_RE = /<img[^>]*src="([^"]*)"/;

/**
 * 从「主队或客队那一段」里取队伍信息。
 * 调用方已经用比分栏把一段比赛切成左右两半，所以这里取第一支队伍即可；
 * 找不到（对阵未定，Liquipedia 用 TBD 占位）时返回 null，整场跳过。
 */
function parseTeam(part: string): ParsedTeam | null {
	const start = part.indexOf('<div class="block-team');
	if (start === -1) return null;
	const segment = part.slice(start);
	const name = segment.match(TEAM_ANCHOR_RE)?.[1]?.trim();
	if (!name) return null;
	const logo = segment.match(TEAM_LOGO_RE)?.[1];
	return {
		name,
		short: segment.match(TEAM_SHORT_RE)?.[1]?.trim() ?? '',
		logo: logo ? `https://liquipedia.net${logo}` : undefined,
	};
}

/** 比分栏在未开赛时是 "vs"，已开赛是 `2 : 0` 这种带标签的结构，去掉标签再取数字。 */
function parseScore(upperHtml: string | undefined): [number, number] | null {
	if (!upperHtml) return null;
	const text = upperHtml.replace(/<[^>]+>/g, ' ').trim();
	if (!text || /vs/i.test(text)) return null;
	const numbers = text.match(/\d+/g);
	return numbers && numbers.length >= 2 ? [Number(numbers[0]), Number(numbers[1])] : null;
}

/** 赛事页路径 → 站内展示用的赛事名，例如 `BLAST/SLAM/9/Southeast_Asia` → `BLAST SLAM 9 Southeast Asia`。 */
export function eventNameFromPath(wikiPath: string): string {
	return wikiPath
		.split('/')
		.map((segment) => segment.replace(/_/g, ' ').trim())
		.filter(Boolean)
		.join(' ');
}

/**
 * 阶段子页：Liquipedia 把一届赛事的各个阶段放在同一页的子页上——`PGL/Wallachia/9` 是季后赛，
 * `PGL/Wallachia/9/Group_Stage` 是小组赛。
 *
 * 不归并就会被拆成两个站内赛事：实测 `pgl-wallachia-9` 只剩 1 场，小组赛那 15 场全跑到
 * `pgl-wallachia-9-group-stage` 名下，于是读者点进赛事页看到的是「即将开始」加一场孤零零的对阵。
 *
 * 只认这些明确的阶段名。像 `BLAST/SLAM/9/Southeast_Asia` 那种区域子赛有自己独立的赛程，
 * 不该并进上一级，所以保持单独一个赛事。
 */
const STAGE_SEGMENTS = new Set(['group_stage', 'playoffs', 'main_event', 'main_tournament', 'regular_season', 'swiss_stage']);

export function eventPathOf(pagePath: string): string {
	const segments = pagePath.split('/');
	const last = segments.at(-1)?.toLowerCase() ?? '';
	if (segments.length > 2 && STAGE_SEGMENTS.has(last)) return segments.slice(0, -1).join('/');
	return pagePath;
}

/**
 * 从一段「以某场比赛的详情开头」的 HTML 里取出一场对阵。
 *
 * 切块交给调用方（见下面两个 parse 函数），字段解析只写这一份：两种页面的内层结构完全一样。
 */
function parseMatchBlock(block: string, pagePath: string, nowSec: number): EsportsMatch | null {
	const timerAttrs = block.match(/<span class="timer-object[^"]*"([^>]*)>/)?.[1];
	const startTime = Number(timerAttrs?.match(/data-timestamp="(\d+)"/)?.[1] ?? 0);
	if (!startTime) return null;

	const [leftPart, rightPart] = block.split('class="match-info-header-scoreholder"');
	const home = leftPart ? parseTeam(leftPart) : null;
	const away = rightPart ? parseTeam(rightPart) : null;
	// 一方未定的比赛没有对阵，跳过而不是编一个占位队名。
	if (!home || !away || home.name === away.name) return null;

	const finished = Boolean(timerAttrs?.includes('data-finished="finished"'));
	const status = finished ? 'completed' : startTime > nowSec ? 'upcoming' : 'live';

	const boText = block.match(/scoreholder-lower">\(?Bo(\d)\)?/)?.[1];
	const upperHtml = block.match(
		/scoreholder-upper">([\s\S]*?)<\/span>\s*<span class="match-info-header-scoreholder-lower"/,
	)?.[1];
	const score = status === 'upcoming' ? null : parseScore(upperHtml);
	// 胜方由比分区上的高亮决定，比"比谁大"更可靠（也适用于还没显示比分的场景）。
	const homeWon = /match-info-header-opponent-left[^"]*match-info-header-winner|match-info-header-winner[^"]*match-info-header-opponent-left/.test(
		leftPart ?? '',
	);
	const awayWon = Boolean(rightPart && rightPart.split('match-info-tournament')[0]?.includes('match-info-header-winner'));

	const eventPath = eventPathOf(pagePath);
	return {
		id: `lp-${startTime}-${slug(home.name)}-${slug(away.name)}`,
		eventId: slug(eventPath),
		eventName: eventNameFromPath(eventPath) || eventPath,
		startTime,
		status,
		bo: boText ? Number(boText) : undefined,
		home: { id: `lp-team-${slug(home.name)}`, name: home.name, logo: home.logo, score: score?.[0] },
		away: { id: `lp-team-${slug(away.name)}`, name: away.name, logo: away.logo, score: score?.[1] },
		winner: homeWon ? 'home' : awayWon ? 'away' : undefined,
		source: 'liquipedia',
		// 指回**这一场所在的页面**（可能是阶段子页），赛事页补全要靠它取回路径。
		sourceUrl: `https://liquipedia.net/dota2/${pagePath}`,
	};
}

/**
 * 主赛程页 `Liquipedia:Matches`：一场一个 `<div class="match-info">`。
 * 切出来的一段自然以该场开头，所以"第一处匹配"必定属于这一场，不会串到下一场。
 */
export function parseMatches(html: string, nowSec: number): EsportsMatch[] {
	const out: EsportsMatch[] = [];
	const seen = new Set<string>();
	for (const block of html.split('<div class="match-info">').slice(1)) {
		const pagePath = block.match(/league-icon-small-image[^>]*>\s*<a href="([^"]+)"/)?.[1]?.replace(/^\/dota2\//, '').split('#')[0];
		if (!pagePath) continue;
		const match = parseMatchBlock(block, pagePath, nowSec);
		if (!match || seen.has(match.id)) continue;
		seen.add(match.id);
		out.push(match);
	}
	return out;
}

/**
 * 赛事页与阶段子页（bracket 模板）：每场的详情在隐藏弹层 `brkts-match-info-popup` 里。
 *
 * 认这个模板是因为主赛程页只有滚动窗口，赛事页才是完整的——实测同一时刻 PGL Wallachia 9 的
 * 小组赛页有 33 场且全部带比分，主赛程页只有 15 场，季后赛更是只剩 1 场。
 */
const BRACKET_BLOCK_RE = /<div[^>]*class="[^"]*brkts-match-info-popup[^"]*"/;

export function parseBracketMatches(html: string, pagePath: string, nowSec: number): EsportsMatch[] {
	const out: EsportsMatch[] = [];
	const seen = new Set<string>();
	for (const block of html.split(BRACKET_BLOCK_RE).slice(1)) {
		const match = parseMatchBlock(block, pagePath, nowSec);
		if (!match || seen.has(match.id)) continue;
		seen.add(match.id);
		out.push(match);
	}
	return out;
}
