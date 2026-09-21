const BASE = 'https://www.dota2.com.cn/datafeed';

export type Attribute = 'STR' | 'AGI' | 'INT' | 'UNI';
export type Attack = 'melee' | 'ranged';

export interface HeroRole {
	key: string;
	label: string;
	level: number;
}

export interface HeroStats {
	strBase: number;
	strGain: number;
	agiBase: number;
	agiGain: number;
	intBase: number;
	intGain: number;
	damageMin: number;
	damageMax: number;
	attackRate: number;
	attackRange: number;
	projectileSpeed: number;
	armor: number;
	magicResistance: number;
	moveSpeed: number;
	turnRate: number;
	maxHealth: number;
	healthRegen: number;
	maxMana: number;
	manaRegen: number;
	sightDay: number;
	sightNight: number;
}

export interface HeroAbility {
	/** 官方 ability id。与 STRATZ 的 `abilityId` 是同一套编号（见 `stratzGuides.ts`）。 */
	id: number;
	name: string;
	nameLoc: string;
	desc: string;
	img: string;
	videoMp4: string;
	videoWebm: string;
	videoPoster: string;
	hasScepter: boolean;
	hasShard: boolean;
	/** 官方 datafeed 的原生标记：这件装备是**升级**这个技能，还是**召唤**出一个新技能。 */
	scepterUpgrade: boolean;
	shardUpgrade: boolean;
	grantedByScepter: boolean;
	grantedByShard: boolean;
	isInborn: boolean;
	scepterMp4: string;
	scepterWebm: string;
	scepterPoster: string;
	shardMp4: string;
	shardWebm: string;
	shardPoster: string;
}

export interface TalentNode {
	id: number;
	key: string;
	name: string;
	desc: string;
}

export interface HeroListEntry {
	id: number;
	name: string;
	nameEn: string;
	attr: Attribute;
	complexity: 1 | 2 | 3;
	img: string;
	imgCrop: string;
}

export interface Hero extends HeroListEntry {
	attack: Attack;
	roles: HeroRole[];
	roleBars: { key: string; label: string; level: number }[];
	bio: string;
	hype: string;
	stats: HeroStats;
	abilities: HeroAbility[];
	topVideo: string;
	topImg: string;
	talents: TalentNode[];
	specialMap: Record<string, number>;
}

export const ATTRIBUTES: { id: Attribute; label: string; color: string }[] = [
	{ id: 'STR', label: '力量', color: '#C0392B' },
	{ id: 'AGI', label: '敏捷', color: '#2E8B57' },
	{ id: 'INT', label: '智力', color: '#2980B9' },
	{ id: 'UNI', label: '全能', color: '#E0A93F' },
];

export const ATTRIBUTE_META: Record<Attribute, { label: string; color: string }> = {
	STR: { label: '力量', color: '#C0392B' },
	AGI: { label: '敏捷', color: '#2E8B57' },
	INT: { label: '智力', color: '#2980B9' },
	UNI: { label: '全能', color: '#E0A93F' },
};

/**
 * 属性图标。力量/敏捷/智力用官方站点那三张，全能官方没有对应图，用站内自己那张
 * （`public/hero-filters/universal.png`，英雄页的筛选按钮也是它）。
 *
 * 放在这里而不是各页面各写一份：英雄页的筛选按钮、阵容分析的分组标题与筛选按钮
 * 都要用，抄三份迟早会出现"某处改了一处没改"。
 */
export const ATTRIBUTE_ICON: Record<Attribute, string> = {
	STR: 'https://www.dota2.com.cn/herostatic/icons/hero_strength.png',
	AGI: 'https://www.dota2.com.cn/herostatic/icons/hero_agility.png',
	INT: 'https://www.dota2.com.cn/herostatic/icons/hero_intelligence.png',
	UNI: '/hero-filters/universal.png',
};

// role_levels 位置顺序（实测校准）：carry/support/nuker/disabler/jungler/durable/escape/pusher/initiator
const ROLE_ORDER = ['carry', 'support', 'nuker', 'disabler', 'jungler', 'durable', 'escape', 'pusher', 'initiator'];
export const ROLE_LABEL: Record<string, string> = {
	carry: '核心',
	support: '辅助',
	nuker: '爆发',
	disabler: '控制',
	jungler: '打野',
	durable: '耐久',
	escape: '逃生',
	pusher: '推进',
	initiator: '先手',
};

const ATTR_MAP: Record<number, Attribute> = { 0: 'STR', 1: 'AGI', 2: 'INT', 3: 'UNI' };

/** 先天技能的固定图标（官方统一使用该素材） */
export const INNATE_ICON = 'https://img.dota2.com.cn/dota2static/facets/innate_icon.png';

/**
 * 各英雄天赋树的“官方精确文本”覆盖。
 * 官方 datafeed 未暴露天赋加成数值，因此对需要与官网一致的关键英雄在此补充。
 * 未覆盖的英雄会回退到接口 talents 数据渲染。
 */
export const HERO_TALENT_OVERRIDE: Record<
	number,
	{ attackIcon: string; levels: { level: number; left: string; right: string }[] }
> = {
	103: {
		attackIcon: 'https://static.pwesports.cn/esportsadmin/DOTA2/2022-7-6/6d2ae286-20bc-4989-9798-96b41cc4f737.svg',
		levels: [
			{ level: 25, left: '+100% 分裂', right: '-60秒 裂地沟壑冷却' },
			{ level: 20, left: '+150 自然秩序范围', right: '+30 灵体游魂触碰英雄攻击力' },
			{ level: 15, left: '20%移速加成转为攻速', right: '+75 回音重踏伤害' },
			{ level: 10, left: '+150 回音重踏唤醒伤害', right: '+2.5% 灵体游魂触碰英雄移速' },
		],
	},
};

export function stripHtml(input: string): string {
	if (!input) return '';
	return input
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 官方素材部分走 cdn.akamai.steamstatic.com / cdn.cloudflare.steamstatic.com（部分网络不可达），
 * 统一重写到可访问的 img.dota2.com.cn 静态目录。
 *
 * heroKey 为英雄的内部名（如 npc_dota_hero_elder_titan），用于正确拼出：
 * - 普通技能：herostatic/<heroKey>/<file>
 * - 魔晶/神杖升级：herostatic/upgrade/<heroKey>/<file>
 * 不能依赖 steamstatic URL 的“上一段目录”，因为图片路径为 .../images/dota_react/abilities/<file>
 * 上一段是 abilities，而视频路径为 .../videos/dota_react/abilities/<hero>/<file>，上一段才是英雄名。
 */
function normalizeCdn(url: string, heroKey?: string): string {
	if (!url) return url;
	let host = '';
	try {
		host = new URL(url).host;
	} catch {
		return url;
	}
	if (host === 'img.dota2.com.cn') return url;
	if (host.endsWith('steamstatic.com')) {
		const parts = url.split('/');
		const file = parts.pop();
		const isUpgrade = url.includes('/upgrade/');
		const dir = isUpgrade
			? `upgrade/${heroKey || `npc_dota_hero_${parts.pop()}`}`
			: heroKey || `npc_dota_hero_${parts.pop()}`;
		return `https://img.dota2.com.cn/dota2static/herostatic/${dir}/${file}`;
	}
	return url;
}

async function getJson<T>(url: string): Promise<T> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15000);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { status: string; result?: { heroes?: unknown } };
		if (data.status !== 'success') throw new Error(`接口状态 ${data.status}`);
		return data as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchHeroList(): Promise<HeroListEntry[]> {
	const data = await getJson<{ result: { heroes: any[] } }>(`${BASE}/heroList?task=herolist`);
	return data.result.heroes.map((h) => ({
		id: h.id,
		name: h.name_loc,
		nameEn: h.name_english_loc,
		attr: ATTR_MAP[h.primary_attr] ?? 'UNI',
		complexity: h.complexity,
		img: h.index_img,
		imgCrop: h.crops_img,
	}));
}

/** 官方角色标签的顺序与等级长度（9 项，等级 0-3）。 */
export const ROLE_COUNT = ROLE_ORDER.length;

export interface HeroProfile {
	/** 官方角色等级，顺序见 `ROLE_ORDER`。 */
	roles: number[];
	/** 近战还是远程。 */
	attack: Attack;
}

/**
 * 每个英雄的官方角色等级与攻击类型，用于阵容分析的结构判断。
 *
 * 这份标签是 Valve 自己给的，比手写"谁有控谁有爆发"稳：英雄池改了、某个英雄重做了，
 * 数据feed 会跟着变，不用我们维护。
 *
 * 拿不到某个英雄时按全 0 处理（等于这个英雄在能力维度上不加分），不因为一个英雄断了整批。
 */
export async function fetchHeroProfile(): Promise<Map<number, HeroProfile>> {
	const list = await fetchHeroList();
	const out = new Map<number, HeroProfile>();
	const chunkSize = 8;
	for (let index = 0; index < list.length; index += chunkSize) {
		const chunk = list.slice(index, index + chunkSize);
		await Promise.all(
			chunk.map(async (hero) => {
				try {
					const detail = await loadHeroDetail(hero.id);
					out.set(hero.id, {
						roles: ROLE_ORDER.map((_, roleIndex) => Number(detail?.role_levels?.[roleIndex] ?? 0)),
						attack: detail?.attack_capability === 2 ? 'ranged' : 'melee',
					});
				} catch {
					out.set(hero.id, { roles: new Array(ROLE_COUNT).fill(0), attack: 'melee' });
				}
			}),
		);
	}
	return out;
}

/**
 * 单个英雄的官方详情，按 id 去重。
 *
 * 英雄页的 `getStaticPaths` 会把 127 个英雄各拉一遍，阵容分析要的"角色等级"也在同一份详情里，
 * 没有这层去重就会白拉第二遍。
 */
const heroDetailCache = new Map<string, Promise<any>>();

function loadHeroDetail(id: number | string): Promise<any> {
	const key = String(id);
	let pending = heroDetailCache.get(key);
	if (!pending) {
		pending = getJson<{ result: { heroes: any } }>(`${BASE}/hero?hero_id=${key}`).then((data) => data.result.heroes);
		heroDetailCache.set(key, pending);
	}
	return pending;
}

export async function fetchHero(id: number | string): Promise<Hero> {
	const h = await loadHeroDetail(id);
	// 汇总所有技能的特殊数值，用于替换天赋/描述里的 {s:key} 占位
	const specialMap: Record<string, number> = {};
	for (const a of h.abilities ?? []) {
		for (const sv of a.special_values ?? []) {
			const name = sv.name;
			if (name) {
				// 技能描述里的 {s:name} 用基础值
				if (!(name in specialMap)) {
					const raw = sv.values_float?.length ? sv.values_float : sv.values_shard?.length ? sv.values_shard : sv.values_scepter?.length ? sv.values_scepter : [];
					if (raw.length) specialMap[name] = Number(raw[0]);
				}
				// 天赋加成用 bonus_<name>，数值在 bonuses[].value
				for (const b of sv.bonuses ?? []) {
					if (b.value != null) specialMap[`bonus_${name}`] = Number(b.value);
				}
			}
		}
	}
	const roles = ROLE_ORDER.map((key, i) => ({ key, label: ROLE_LABEL[key], level: h.role_levels?.[i] ?? 0 }))
		.filter((r) => r.level > 0)
		.sort((a, b) => b.level - a.level);
	const roleBars = ROLE_ORDER.map((key, i) => ({ key, label: ROLE_LABEL[key], level: h.role_levels?.[i] ?? 0 }));
	return {
		id: h.id,
		name: h.name_loc,
		nameEn: h.name_english_loc,
		attr: ATTR_MAP[h.primary_attr] ?? 'UNI',
		complexity: h.complexity,
		attack: h.attack_capability === 2 ? 'ranged' : 'melee',
		roles,
		roleBars,
		img: h.index_img,
		imgCrop: h.crops_img,
		bio: stripHtml(h.bio_loc),
		hype: stripHtml(h.hype_loc),
		topVideo: h.top_video,
		topImg: h.top_img,
		stats: {
			strBase: h.str_base,
			strGain: h.str_gain,
			agiBase: h.agi_base,
			agiGain: h.agi_gain,
			intBase: h.int_base,
			intGain: h.int_gain,
			damageMin: h.damage_min,
			damageMax: h.damage_max,
			attackRate: h.attack_rate,
			attackRange: h.attack_range,
			projectileSpeed: h.projectile_speed,
			armor: h.armor,
			magicResistance: h.magic_resistance,
			moveSpeed: h.movement_speed,
			turnRate: h.turn_rate,
			maxHealth: h.max_health,
			healthRegen: h.health_regen,
			maxMana: h.max_mana,
			manaRegen: h.mana_regen,
			sightDay: h.sight_range_day,
			sightNight: h.sight_range_night,
		},
		abilities: (h.abilities ?? []).map((a: any) => ({
			id: Number(a.id) || 0,
			name: a.name,
			nameLoc: a.name_loc,
			desc: resolveTemplate(stripHtml(a.desc_loc), specialMap),
			img: a.ability_is_innate || a.is_inborn ? INNATE_ICON : normalizeCdn(a.img, h.name),
			videoMp4: normalizeCdn(a.video_mp4, h.name),
			videoWebm: normalizeCdn(a.video_webm, h.name),
			videoPoster: normalizeCdn(a.video_jpg || a.img, h.name),
			hasScepter: Boolean(a.video_scepter_webm) || Boolean(a.video_scepter_mp4),
			hasShard: Boolean(a.video_shard_webm) || Boolean(a.video_shard_mp4),
			scepterUpgrade: Boolean(a.ability_has_scepter),
			shardUpgrade: Boolean(a.ability_has_shard),
			grantedByScepter: Boolean(a.ability_is_granted_by_scepter),
			grantedByShard: Boolean(a.ability_is_granted_by_shard),
			isInborn: Boolean(a.is_inborn) || Boolean(a.ability_is_innate),
			scepterMp4: normalizeCdn(a.video_scepter_mp4, h.name),
			scepterWebm: normalizeCdn(a.video_scepter_webm, h.name),
			scepterPoster: normalizeCdn(a.video_scepter_jpg || a.img, h.name),
			shardMp4: normalizeCdn(a.video_shard_mp4, h.name),
			shardWebm: normalizeCdn(a.video_shard_webm, h.name),
			shardPoster: normalizeCdn(a.video_shard_jpg || a.img, h.name),
		})),
		talents: (h.talents ?? []).map((t: any) => ({
			id: t.id,
			key: t.name,
			name: t.name_loc,
			desc: stripHtml(t.desc_loc),
		})),
		specialMap,
	};
}

export function fmt(n: number, digits = 0): string {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function heroListUrl(): string {
	return `${BASE}/heroList?task=herolist`;
}

/** 替换 {s:key} 占位符；取不到时优先从天赋内部名称解析结尾数值，其次用 ? 占位 */
export function resolveTemplate(text: string, map: Record<string, number>, fallbackName?: string): string {
	if (!text) return '';
	return text.replace(/\{s:([^}]+)\}/g, (_, key: string) => {
		const v = map[key];
		if (v != null) return String(Math.round(v * 10) / 10);
		if (key === 'value' && fallbackName) {
			const m = fallbackName.match(/_(\d+(?:\.\d+)?)$/);
			if (m) return m[1];
		}
		return '?';
	});
}
