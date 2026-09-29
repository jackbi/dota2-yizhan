import type { EsportsMatch, LeagueTier } from '../data/types';
// 只借类型：`playerHeroes` 引了 node:fs，而本模块要被纯 node 的自检直接 import（见文件头注释）。
import type { PlayerHeroPool } from './playerHeroes.ts';
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
	/** Liquipedia 页面标题，例如 `Team_Liquid`；取名单要靠它。 */
	wiki?: string;
}

/** 解百分号编码；`%` 后面不是合法编码时原样返回，不能让一个怪地址把整页解析打断。 */
function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/*
 * `class` 后面必须允许跟别的类名：Liquipedia 对**只有亮色队标**的队伍会输出
 * `class="team-template-image-icon team-template-lightmode"`（如 Team Nemesis、Team Lynx）。
 * 要求 class 恰好等于 `team-template-image-icon` 时这类队伍解析成空，而调用方是
 * 「一方未定就跳过整场」，于是连对手一起丢——实测主赛程页 100 场里丢 56 场，
 * 其中 29 场是这个原因，包括 Xtreme Gaming vs Team Nemesis（9013522151 那场）。
 */
const TEAM_ANCHOR_RE = /team-template-image-icon[^"]*">\s*<a[^>]*title="([^"]*)"/;
/**
 * 同一条 anchor 的 href 也要取——它是**这支队的 Liquipedia 页面标题**，战队页取名单要用。
 *
 * 不能拿队名去猜标题：`Xtreme Gaming` 的队标文件叫 `Xtreme_Gaming_%28China%29_allmode.png`，
 * 看着像标题里带 (China)，实际页面就是 `/dota2/Xtreme_Gaming`（照图片名猜过一次，直接查不到）。
 */
const TEAM_WIKI_RE = /team-template-image-icon[^"]*">\s*<a href="\/dota2\/([^"#?]+)"/;
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
	const wiki = segment.match(TEAM_WIKI_RE)?.[1];
	return {
		name,
		short: segment.match(TEAM_SHORT_RE)?.[1]?.trim() ?? '',
		logo: logo ? `https://liquipedia.net${logo}` : undefined,
		// href 里可能有百分号编码（括号之类），解不出来就按原样用。
		wiki: wiki ? decodeSafe(wiki) : undefined,
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

/** 一届赛事的档位。`showmatch` 与档位并存，不是二选一（见下）。 */
export interface LeagueTierInfo {
	tier: LeagueTier;
	showmatch?: boolean;
}

/**
 * 赛事页 Infobox 里的 `Liquipedia Tier` 一行。
 *
 * 取渲染后的 HTML 而不是 wikitext，是因为我们抓的就是渲染结果（`action=parse` 的 text）——
 * 同一份字节里既有对阵也有档位，不用为它多发一次请求。
 *
 * **一个坑：阶段子页上没有这一行。** 实测 `PGL/Wallachia/9/Group_Stage` 没有 Infobox
 * （档位在父页面 `PGL/Wallachia/9` 上），而我们的 `sourceUrl` 恰恰常常指向阶段子页，
 * 所以调用方要按 `eventPathOf()` 归到根页面再去取，别拿子页的 HTML 硬解析。
 *
 * **另一个坑：档位与"表演赛"是两个字段。** Liquipedia 的 wikitext 是
 * `liquipediatier=3` + `liquipediatiertype=showmatch` 两条，渲染出来是
 * `Showmatch (Tier 3)`——也就是说表演赛**仍然有正式档位**，不是"没有档位"。
 * 所以这里两个都读出来，由调用方决定怎么用（一线队只看档位）。
 *
 * 认不出的值返回 undefined（页面不显示档位），不猜。实测 Liquipedia 用的是 1–4。
 */
const TIER_CELL_RE = /Liquipedia Tier:?<\/div>\s*<div>([\s\S]*?)<\/div>/;

export function parseLeagueTier(html: string): LeagueTierInfo | undefined {
	const cell = html.match(TIER_CELL_RE)?.[1];
	if (!cell) return undefined;
	const text = cell
		// 去掉标签之后只剩文字，`title="Tier 1 Tournaments"` 这类属性也就不会误命中。
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;|&#160;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const numbered = text.match(/Tier\s*([1-4])\b/i);
	if (!numbered) return undefined;
	const tier = Number(numbered[1]) as LeagueTier;
	// 有类型才带上这个键：这份对象会被缓存成 JSON，留一个 undefined 的键读写两轮形状就不一样了。
	return /showmatch/i.test(text) ? { tier, showmatch: true } : { tier };
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
		home: { id: `lp-team-${slug(home.name)}`, name: home.name, logo: home.logo, wiki: home.wiki, score: score?.[0] },
		away: { id: `lp-team-${slug(away.name)}`, name: away.name, logo: away.logo, wiki: away.wiki, score: score?.[1] },
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

/*
 * ---- 战队名单 --------------------------------------------------------------------
 *
 * 来源换成 Liquipedia 战队页的 wikitext，不再用 OpenDota 的 `/teams/<id>/players`。
 * 理由是那个接口给的是**历史全量**：实测 Team Liquid 名下同时有现役的 miCKe、Boxi、tOfe，
 * 也有几年前的 Miracle-、GH、kky，连教练 Jabbz 都被标成"在队"——页面上看着就是
 * "名单不完整又混着离队的人"。Liquipedia 的名单是人工维护的现役五人 + 替补 + 教练组。
 *
 * 页面结构（实测 Team Spirit / Team Liquid）：
 *
 * ```
 * ===Active Roster===
 * {{Squad|status=active
 * |{{Person|flag=ua|id=Yatoro|name=Illya Mulyarchuk|position=1|joindate=2020-12-19<ref .../>}}
 * }}
 * ===Coaching Staff===
 * {{Squad|type=staff|status=active
 * |{{Person|flag=ru|id=sikle|name=Mark Lerman|role=Analyst|joindate=2022-08-09}}
 * }}
 * ===Inactive Roster===
 * {{Squad|status=inactive|{{Person|...|inactivedate=2026-09-21}}}}
 * ```
 *
 * 判据用模板参数而不是章节标题：`status=active` 是现役、`status=inactive` 是离队（要丢）、
 * `type=staff` 是教练组。标题会变、会缺席（Team Liquid 就没有 `===Stand-ins===`），参数不会。
 */

/** 战队名单里的一个人。 */
export interface RosterMember {
	/** 昵称（`id=`），页面上显示的就是它。 */
	nick: string;
	/**
	 * 这个人自己的 Liquipedia 页面标题（`link=`，缺省时就是昵称）。
	 * 查 Steam 账号 id 要靠它——账号 id 只写在选手页上。
	 */
	page?: string;
	/** 真名；Liquipedia 没有时缺省。 */
	realName?: string;
	/** 一到五号位；教练组没有这个。 */
	position?: number;
	/** 教练组的角色（Coach / Analyst …）；选手没有这个。 */
	role?: string;
	/** 国籍代码，例如 se / ru。 */
	flag?: string;
	/** 加入日期，YYYY-MM-DD。 */
	joined?: string;
	captain?: boolean;
	/**
	 * Steam 账号 id。**不由解析得到**：它在选手页的 Infobox 里，由 `liquipediaApi` 补上
	 * （见 `fetchLiquipediaPlayerIds`）。
	 */
	accountId?: number;
	/** 按版本算好的招牌英雄，由 `playerHeroes` 补上。 */
	heroPool?: PlayerHeroPool;
}

export interface TeamRoster {
	players: RosterMember[];
	standins: RosterMember[];
	staff: RosterMember[];
}

/**
 * 去掉 HTML 注释。
 *
 * Liquipedia 用注释"停用"整段模板：Team Spirit 的替补表就写在 `<!--{{stand-ins table|...}}-->` 里，
 * Team Liquid 的 `===Inactive Roster===` 也整个被注释掉了。不去掉的话，退役名单会被当成现役。
 */
const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '');

/**
 * 从 `from` 处的 `{{` 读出一整个模板体（含嵌套），返回 `{{` 与 `}}` 之间的内容。
 *
 * 必须配对计数：`{{Squad|...|{{Person|...}}|...}}` 里第一个 `}}` 关掉的是 Person，
 * 不是 Squad。用非贪婪正则会把 Squad 截断在第一个 Person 之后。
 */
function readTemplateBody(text: string, from: number): string | null {
	if (!text.startsWith('{{', from)) return null;
	let depth = 0;
	for (let i = from; i < text.length - 1; i += 1) {
		const two = text.slice(i, i + 2);
		if (two === '{{') {
			depth += 1;
			i += 1;
			continue;
		}
		if (two === '}}') {
			depth -= 1;
			i += 1;
			if (depth === 0) return text.slice(from + 2, i - 1);
		}
	}
	return null;
}

/**
 * 按顶层 `|` 切开模板体。
 *
 * 同样要认嵌套：`{{Person|flag=se|id=miCKe}}` 里也有 `=` 与 `|`，直接 split 会把
 * 某个人的参数当成 Squad 自己的。`[[链接|文字]]` 里的竖线也要放过。
 */
function splitParams(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i += 1) {
		const two = body.slice(i, i + 2);
		if (two === '{{' || two === '[[') {
			depth += 1;
			i += 1;
			continue;
		}
		if (two === '}}' || two === ']]') {
			depth -= 1;
			i += 1;
			continue;
		}
		if (body[i] === '|' && depth === 0) {
			out.push(body.slice(start, i));
			start = i + 1;
		}
	}
	out.push(body.slice(start));
	return out;
}

/** 参数值里可能有 `<ref>`、内链、多余空白；显示之前统一清一遍。 */
function cleanValue(raw: string | undefined): string {
	return (raw ?? '')
		.replace(/<ref[^>]*\/>/g, '')
		.replace(/<ref[\s\S]*?<\/ref>/g, '')
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 片段们 → 参数字典。只认 `键=值` 形状的片段，嵌套模板（`{{Person|…}}`）自己跳过。 */
function paramMap(segments: string[]): Map<string, string> {
	const params = new Map<string, string>();
	for (const segment of segments) {
		const eq = segment.indexOf('=');
		if (eq <= 0) continue;
		const key = segment.slice(0, eq).trim().toLowerCase();
		// `{{Person|…}}` 里也有 `=`，但键会是 `{{Person|flag` 这种，正则挡掉。
		if (!/^[a-z0-9_-]+$/.test(key)) continue;
		params.set(key, cleanValue(stripComments(segment.slice(eq + 1))));
	}
	return params;
}

/** `{{Person|…}}` / `{{stand-in|…}}` 的片段 → 一个人。没有昵称的条目直接丢。 */
function toMember(segments: string[]): RosterMember | null {
	const params = paramMap(segments);
	const nick = params.get('id') ?? '';
	if (!nick) return null;
	const position = Number(params.get('position'));
	const member: RosterMember = { nick };
	// `link=` 只在昵称撞名时才写；没有它时页面标题就是昵称本身（MediaWiki 首字母不区分大小写）。
	member.page = params.get('link') || nick;
	const realName = params.get('name');
	if (realName) member.realName = realName;
	if (Number.isInteger(position) && position > 0) member.position = position;
	const role = params.get('role');
	if (role) member.role = role;
	const flag = params.get('flag');
	if (flag) member.flag = flag;
	const joined = params.get('joindate');
	if (joined) member.joined = joined;
	if (params.get('captain') === 'yes') member.captain = true;
	return member;
}

/** 把一处模板调用（从 `from` 处开始）解析成"模板名 + 参数片段"。 */
function readCall(text: string, from: number): { name: string; segments: string[] } | null {
	const body = readTemplateBody(text, from);
	if (body === null) return null;
	const segments = splitParams(body);
	return { name: segments[0]?.trim() ?? '', segments: segments.slice(1) };
}

/**
 * 现役那一段的终点。
 *
 * 页面后面还有整块的历史名单——`===Inactive===` / `===Former===` 这类标题，以及大量
 * `{{Squad|status=former|title=Former Players}}`（实测 NAVI 一页 33 个、OG 24 个）。选手靠
 * `status=active` 就能挡住，但**替补表挡不住**：那些历史段里塞满了 `{{stand-in}}`
 * （实测 OG 27 条，其中一个人出现 5 次），不分段的话页面上就会出现「替补：Ceb、Ceb、Ceb…」——
 * 正是"以前的人也被算进来"这件事换了个样子。
 */
function activeSectionEnd(text: string): number {
	const marks = [
		text.search(/\n=+[^=\n]*(?:former|inactive)[^=\n]*=+/i),
		text.indexOf('{{Squad|status=former'),
		text.indexOf('{{Squad|status=inactive'),
	].filter((index) => index >= 0);
	return marks.length > 0 ? Math.min(...marks) : text.length;
}

/**
 * 战队页 wikitext → 名单。
 *
 * 只认 `{{Squad|status=active}}` 这一档：`status=inactive`（离队）整块丢掉，
 * `type=staff` 归到教练组，其余归到选手。替补走 `{{stand-in}}`。
 */
export function parseTeamRoster(wikitext: string): TeamRoster {
	const stripped = stripComments(wikitext);
	const text = stripped.slice(0, activeSectionEnd(stripped));
	const players: RosterMember[] = [];
	const standins: RosterMember[] = [];
	const staff: RosterMember[] = [];

	for (let i = text.indexOf('{{Squad'); i !== -1; i = text.indexOf('{{Squad', i + 2)) {
		const squad = readCall(text, i);
		if (!squad) continue;
		const params = paramMap(squad.segments);
		// 离队名单：整块不要。`status` 缺失时按现役处理会混进退役的人，所以要求显式 active。
		if (params.get('status') !== 'active') continue;
		const target = params.get('type') === 'staff' ? staff : players;
		for (const segment of squad.segments) {
			if (!segment.startsWith('{{Person')) continue;
			const member = toMember(splitParams(readTemplateBody(segment, 0) ?? '').slice(1));
			if (member) target.push(member);
		}
	}

	for (let i = text.indexOf('{{stand-in'); i !== -1; i = text.indexOf('{{stand-in', i + 2)) {
		const call = readCall(text, i);
		if (!call) continue;
		const member = toMember(call.segments);
		if (member) standins.push(member);
	}

	// 选手按号位排，没写号位的排最后——否则名单顺序跟着 wikitext 的编辑顺序走，每轮都可能变。
	players.sort((a, b) => (a.position ?? 9) - (b.position ?? 9) || a.nick.localeCompare(b.nick));
	staff.sort((a, b) => (a.role ?? '').localeCompare(b.role ?? '') || a.nick.localeCompare(b.nick));
	standins.sort((a, b) => a.nick.localeCompare(b.nick));

	return { players, standins, staff };
}
