/**
 * 官方更新日志的结构模型与渲染。
 *
 * `dota2.com/datafeed/patchnotes` 返回的是一份**结构化**数据，不是一段排好版的 HTML：
 * 每个条目只登记 `hero_id` / `ability_id` 与若干行改动文本，名字要另外查
 * `herolist` / `itemlist` / `abilitylist` 才拼得出来。这比抓官网正文麻烦，
 * 但换来两件正文给不了的东西：
 *
 * - **完整**。中文站「游戏性更新」只发到 7.41d，而 datafeed 从 7.08 起的
 *   118 个版本一个不缺（同一份数据也是官网 /patches 页的源）。
 * - **可比对**。改动是分层的（英雄 → 技能 / 天赋 / 命石），可以按结构排版，
 *   不用去猜官方那段 HTML 里哪个 `<div>` 是标题。
 *
 * 这里只做纯函数：抓取、缓存、图片本地化都在 `patchesApi.ts` / `patchIcons.ts`，
 * 于是渲染规则可以在 `scripts/patchNotes.check.ts` 里直接用固定数据验。
 */

/** 一行改动。`hide_dot` 的行官方也不打点（多为占位换行），`info` 是 i 图标里的补充说明。 */
export interface PatchNoteLine {
	indent_level?: number;
	note: string;
	hide_dot?: boolean;
	info?: string;
	/** `scepter` / `shard`：这一行是神杖或魔晶升级后的效果。 */
	aghanims?: string;
}

export interface PatchAbilityBlock {
	ability_id: number;
	ability_notes?: PatchNoteLine[];
}

export interface PatchSubsection {
	title?: string;
	/** `innate`（先天技能）或 `hero_facet`（命石），后者可能带 `NewFacet` / `ReworkedFacet`。 */
	style?: string;
	facet?: string | null;
	general_notes?: PatchNoteLine[];
	talent_notes?: PatchNoteLine[];
	abilities?: PatchAbilityBlock[];
}

export interface PatchHeroEntry {
	hero_id: number;
	title?: string;
	hero_notes?: PatchNoteLine[];
	talent_notes?: PatchNoteLine[];
	abilities?: PatchAbilityBlock[];
	subsections?: PatchSubsection[];
}

export interface PatchItemEntry {
	/** `-1` 表示这不是某个具体物品，而是一段带 `title` 的分组说明。 */
	ability_id: number;
	title?: string;
	is_general_note?: boolean;
	ability_notes?: PatchNoteLine[];
}

export interface PatchCreepEntry {
	name: string;
	localized_name?: string;
	title?: string;
	is_general_note?: boolean;
	neutral_creep_notes?: PatchNoteLine[];
}

export interface PatchNotes {
	patch_number: string;
	patch_name?: string;
	patch_timestamp?: number;
	/**
	 * 两个大版本（7.23「世外之争」、7.28「林渊秘境」）的日志**不在这份数据里**：
	 * 官方把它们做成了专题站，datafeed 只留下专题页的 slug。
	 */
	patch_website?: string;
	patch_website_anchor?: string;
	general_notes?: { title?: string; generic?: PatchNoteLine[] }[];
	items?: PatchItemEntry[];
	neutral_items?: PatchItemEntry[];
	neutral_creeps?: PatchCreepEntry[];
	heroes?: PatchHeroEntry[];
	success?: boolean;
}

/** 名字索引里的一条：`key` 是内部名（`antimage` / `blink`），用来拼图标地址。 */
export interface PatchEntityRef {
	key: string;
	name: string;
}

export interface PatchNames {
	heroes: Map<number, PatchEntityRef>;
	items: Map<number, PatchEntityRef>;
	abilities: Map<number, PatchEntityRef>;
}

/** 图标本地化后的站点路径，键是 `hero:<key>` / `item:<key>`。 */
export type PatchIconMap = Map<string, string>;

export function heroIconKey(key: string): string {
	return `hero:${key}`;
}

export function itemIconKey(key: string): string {
	return `item:${key}`;
}

/** 内部名去掉 `npc_dota_hero_` / `item_` 前缀后就是官网 cdn 的文件名。 */
export function heroKeyFromName(internalName: string): string {
	return internalName.replace(/^npc_dota_hero_/, '');
}

export function itemKeyFromName(internalName: string): string {
	return internalName.replace(/^item_/, '');
}

// ---------------------------------------------------------------- 消毒

/** 已知实体原样留着（正文里就是 `&nbsp;`），其余裸 `&` 补成 `&amp;`。 */
function escapeText(text: string): string {
	return text
		.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g;

/** 颜色只接受十六进制，避免从数据里带出任意的 `style` 值。 */
const COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;

/** 颜色可能带引号也可能不带（数据里两种都有），所以三段都要兜住。 */
const COLOR_ATTR_RE = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

interface OpenTag {
	html: string;
	/** 配对用的名字：`strong` 和 `b` 都收成 `b`，闭合标签才不会配错。 */
	match: string;
	close: string;
}

function openTag(name: string, attrs: string): OpenTag | null {
	switch (name) {
		case 'b':
		case 'strong':
			return { html: '<b>', match: 'b', close: '</b>' };
		case 'i':
		case 'em':
			return { html: '<i>', match: 'i', close: '</i>' };
		case 'font': {
			const color = COLOR_ATTR_RE.exec(attrs);
			const value = (color?.[1] ?? color?.[2] ?? color?.[3] ?? '').trim();
			const open = COLOR_RE.test(value) ? `<span style="color:${value}">` : '<span>';
			return { html: open, match: 'span', close: '</span>' };
		}
		case 'span': {
			if (/\bclass\s*=\s*"?Subtitle\b/i.test(attrs)) {
				return { html: '<span class="pn-inline-title">', match: 'span', close: '</span>' };
			}
			if (/\bclass\s*=\s*"?New\b/i.test(attrs)) {
				return { html: '<span class="pn-new">', match: 'span', close: '</span>' };
			}
			return null;
		}
		default:
			return null;
	}
}

/**
 * 改动文本的清洗。官方会在里面夹一点行内标签（`<br>`、`<b>`、
 * `<font color>`、`<span class="Subtitle">`），其余一律当纯文本。
 *
 * 这份数据要经过 `set:html` 注进页面，等于把第三方字符串当 HTML 用，
 * 所以走白名单而不是黑名单：逐段扫标签，**标签之间的文字先转义**，
 * 只有认得出的标签才放行（颜色还必须是十六进制），认不出的连标签带属性一起丢掉。
 * 丢掉标签时它的属性也一并消失，不会漏出半截 `onerror=` 之类的文本。
 */
export function sanitizeNote(html: string): string {
	const out: string[] = [];
	/** 已经吐出去的开放标签，用来配对闭合——被丢掉的标签不该留下孤零零的 `</span>`。 */
	const stack: OpenTag[] = [];
	let last = 0;
	for (const match of html.matchAll(TAG_RE)) {
		out.push(escapeText(html.slice(last, match.index)));
		last = (match.index ?? 0) + match[0].length;
		const name = match[2].toLowerCase();
		if (match[1]) {
			if (name === 'br') continue;
			const target = name === 'strong' ? 'b' : name === 'em' ? 'i' : name === 'font' ? 'span' : name;
			const at = stack.findLastIndex((open) => open.match === target);
			// 中间那些没闭合的标签一并补上，免得半个标签把后面的版面吃进去。
			while (at >= 0 && stack.length > at) out.push(stack.pop()!.close);
			continue;
		}
		if (name === 'br') {
			out.push('<br>');
			continue;
		}
		const open = openTag(name, match[3] ?? '');
		if (open) {
			out.push(open.html);
			stack.push(open);
		}
	}
	out.push(escapeText(html.slice(last)));
	// 数据把标签写坏时（少一个闭合）也别把后面的正文吞进样式里。
	while (stack.length > 0) out.push(stack.pop()!.close);
	return out.join('');
}

// ---------------------------------------------------------------- 渲染

/** 只用来决定缩进档位，超出范围的层级直接压到上限，免得数据异常把版面顶飞。 */
const MAX_INDENT = 4;

function indentOf(line: PatchNoteLine): number {
	const level = Math.trunc(line.indent_level ?? 1);
	return Math.min(Math.max(level, 1), MAX_INDENT) - 1;
}

function renderLine(line: PatchNoteLine): string {
	const text = sanitizeNote(line.note ?? '').trim();
	// 只剩一个换行的行是官方用来撑行距的占位，保留成空行才有"分段"的效果。
	if (!text || text === '<br>') {
		return '<li class="pn-line pn-blank" aria-hidden="true"></li>';
	}
	const dot = line.hide_dot ? ' pn-nodot' : '';
	const aghanims =
		line.aghanims === 'scepter'
			? '<span class="pn-tag">神杖</span>'
			: line.aghanims === 'shard'
				? '<span class="pn-tag">魔晶</span>'
				: '';
	const info = line.info ? `<span class="pn-info">${sanitizeNote(line.info)}</span>` : '';
	return `<li class="pn-line${dot}" style="--pn-indent:${indentOf(line)}">${aghanims}${text}${info}</li>`;
}

function renderLines(lines: PatchNoteLine[] | undefined): string {
	if (!lines || lines.length === 0) return '';
	return `<ul class="pn-lines">${lines.map(renderLine).join('')}</ul>`;
}

function renderAbility(block: PatchAbilityBlock, names: PatchNames): string {
	const ability = names.abilities.get(block.ability_id);
	const label = ability?.name ? `<div class="pn-ability-name">${escapeText(ability.name)}</div>` : '';
	return `${label}${renderLines(block.ability_notes)}`;
}

function renderEntity(
	icon: string | undefined,
	nameHtml: string,
	body: string,
	className: string,
): string {
	const image = icon
		? `<img class="pn-icon" src="${escapeText(icon)}" alt="" width="28" height="28" loading="lazy" decoding="async">`
		: '<span class="pn-icon pn-icon-empty" aria-hidden="true"></span>';
	return `<article class="${className}">${image}<div class="pn-body"><div class="pn-name">${nameHtml}</div>${body}</div></article>`;
}

/** 命石/先天技能的标题带个来源标记，官方页面上也是这样区分的。 */
function subsectionBadge(sub: PatchSubsection): string {
	const style = sub.style ?? '';
	if (/ReworkedFacet/.test(style)) return '<span class="pn-badge">重做命石</span>';
	if (/NewFacet/.test(style)) return '<span class="pn-badge">新命石</span>';
	if (/hero_facet/.test(style)) return '<span class="pn-badge">命石</span>';
	if (style === 'innate') return '<span class="pn-badge">先天技能</span>';
	return '';
}

function renderSubsection(sub: PatchSubsection, names: PatchNames): string {
	const title = sub.title?.trim();
	const heading = title
		? `<h3 class="pn-subtitle">${subsectionBadge(sub)}${escapeText(title)}</h3>`
		: subsectionBadge(sub);
	const abilities = (sub.abilities ?? []).map((a) => `<div class="pn-ability">${renderAbility(a, names)}</div>`).join('');
	return `${heading}${renderLines(sub.general_notes)}${abilities}${renderLines(sub.talent_notes)}`;
}

function renderHero(hero: PatchHeroEntry, names: PatchNames, icons: PatchIconMap): string {
	const ref = names.heroes.get(hero.hero_id);
	// 名字表里查不到时退到条目标题（`title` 里是官方给的小标记，如熊灵的「新英雄？」），
	// 再不行才出编号——总比整块认不出来强。
	const rawName = ref?.name || (hero.title ? sanitizeNote(hero.title) : '');
	const name = rawName || `英雄 #${hero.hero_id}`;
	const icon = ref && ref.key ? icons.get(heroIconKey(ref.key)) : undefined;
	const parts: string[] = [];
	parts.push(renderLines(hero.hero_notes));
	if (hero.abilities?.length) {
		parts.push(
			`<div class="pn-group">技能</div>${hero.abilities
				.map((a) => `<div class="pn-ability">${renderAbility(a, names)}</div>`)
				.join('')}`,
		);
	}
	if (hero.talent_notes?.length) {
		parts.push(`<div class="pn-group">天赋</div>${renderLines(hero.talent_notes)}`);
	}
	for (const sub of hero.subsections ?? []) parts.push(renderSubsection(sub, names));
	return renderEntity(icon, name, parts.join(''), 'pn-entity pn-hero');
}

function renderItem(item: PatchItemEntry, names: PatchNames, icons: PatchIconMap): string {
	// 挂不到具体物品上的条目是官方插的分组说明（`is_general_note` + `title`），
	// 官方页面上它们也只当小标题用，不配图标。
	const ref = item.is_general_note || item.ability_id <= 0 ? null : names.items.get(item.ability_id);
	if (!ref) {
		const title = item.title?.trim();
		return `<div class="pn-anon">${title ? `<div class="pn-group">${escapeText(title)}</div>` : ''}${renderLines(item.ability_notes)}</div>`;
	}
	const icon = ref.key ? icons.get(itemIconKey(ref.key)) : undefined;
	return renderEntity(icon, escapeText(ref.name), renderLines(item.ability_notes), 'pn-entity');
}

function renderCreep(creep: PatchCreepEntry): string {
	const name = creep.localized_name?.trim() || creep.title?.trim() || creep.name;
	return renderEntity(undefined, escapeText(name), renderLines(creep.neutral_creep_notes), 'pn-entity pn-creep');
}

function section(title: string, body: string): string {
	if (!body) return '';
	return `<section class="pn-section"><h2 class="pn-heading">${escapeText(title)}</h2>${body}</section>`;
}

/**
 * 把一份结构化更新日志渲染成 HTML 片段。
 *
 * 空板块直接不输出——早期版本常常只有英雄改动，硬留一个「物品」标题会让页面
 * 看起来像加载失败。
 */
export function renderPatchNotes(notes: PatchNotes, names: PatchNames, icons: PatchIconMap): string {
	const general = (notes.general_notes ?? [])
		.map((group) => {
			const title = group.title?.trim();
			const heading = title ? `<div class="pn-group">${escapeText(title)}</div>` : '';
			return `${heading}${renderLines(group.generic)}`;
		})
		.join('');

	const items = (notes.items ?? []).map((item) => renderItem(item, names, icons)).join('');
	const neutralItems = (notes.neutral_items ?? [])
		.map((item) => renderItem(item, names, icons))
		.join('');
	const creeps = (notes.neutral_creeps ?? []).map(renderCreep).join('');
	const heroes = (notes.heroes ?? []).map((hero) => renderHero(hero, names, icons)).join('');

	const html = [
		section('全局改动', general),
		section('物品', items),
		section('中立物品', neutralItems),
		section('中立生物', creeps),
		section('英雄', heroes),
	].join('');

	return `<div class="patch-notes">${html}</div>`;
}

/**
 * 这份更新日志里到底有没有可渲染的内容。
 *
 * 7.23 / 7.28 两个大版本的数据里只有 `patch_website`，其余字段全是空的——
 * 页面得据此改去专题站，而不是渲染一个空的正文框。
 */
export function hasPatchContent(notes: PatchNotes): boolean {
	return Boolean(
		(notes.general_notes ?? []).some((group) => (group.generic ?? []).length > 0) ||
			(notes.items ?? []).length > 0 ||
			(notes.neutral_items ?? []).length > 0 ||
			(notes.neutral_creeps ?? []).length > 0 ||
			(notes.heroes ?? []).length > 0,
	);
}

/** 列表页与首页卡片上的一句话摘要：改动规模一眼可见。 */
export function summarizePatch(notes: PatchNotes): string {
	const heroes = (notes.heroes ?? []).length;
	const items = (notes.items ?? []).filter((i) => i.ability_id > 0).length;
	const neutral = (notes.neutral_items ?? []).filter((i) => i.ability_id > 0).length;
	const general = (notes.general_notes ?? []).reduce((sum, g) => sum + (g.generic?.length ?? 0), 0);
	const parts: string[] = [];
	if (heroes > 0) parts.push(`${heroes} 名英雄`);
	if (items > 0) parts.push(`${items} 件物品`);
	if (neutral > 0) parts.push(`${neutral} 件中立物品`);
	if (general > 0) parts.push(`${general} 条通用改动`);
	return parts.length > 0 ? parts.join(' · ') : '小幅调整';
}

/**
 * 一份更新日志真正用到的英雄与物品（去重）。
 *
 * 图标是构建期一张张下载的，所以只取**这一页会出现**的那些：一个版本动到的英雄
 * 通常个位数，而 8 年下来全部英雄物品都要用上，按版本各取所需比一次全量下载省得多。
 */
export function referencedEntities(
	notes: PatchNotes,
	names: PatchNames,
): { heroes: PatchEntityRef[]; items: PatchEntityRef[] } {
	const heroIds = new Set<number>();
	const itemIds = new Set<number>();
	for (const hero of notes.heroes ?? []) heroIds.add(hero.hero_id);
	for (const list of [notes.items, notes.neutral_items]) {
		for (const item of list ?? []) {
			if (item.ability_id > 0) itemIds.add(item.ability_id);
		}
	}
	const heroes: PatchEntityRef[] = [];
	const items: PatchEntityRef[] = [];
	// 按 Map 里的顺序输出，让同一份数据每次构建生成的图标文件清单稳定。
	for (const [id, ref] of names.heroes) if (heroIds.has(id)) heroes.push(ref);
	for (const [id, ref] of names.items) if (itemIds.has(id)) items.push(ref);
	return { heroes, items };
}

/**
 * 版本列表按大版本分组。
 *
 * 8 年下来一百多个版本，摊平成一条时间线要滚十几屏，而玩家关心的粒度本来就是
 * 「7.41 下面有哪些子版本」。输入假定已按时间倒序，输出沿用「新 → 旧」。
 */
export function groupByMajor<T extends { major: string }>(
	updates: T[],
): { major: string; items: T[] }[] {
	const groups: { major: string; items: T[] }[] = [];
	const index = new Map<string, T[]>();
	for (const update of updates) {
		let items = index.get(update.major);
		if (!items) {
			items = [];
			index.set(update.major, items);
			groups.push({ major: update.major, items });
		}
		items.push(update);
	}
	return groups;
}
