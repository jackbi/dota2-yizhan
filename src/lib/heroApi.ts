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
	armor: number;
	magicResistance: number;
	moveSpeed: number;
	maxHealth: number;
	healthRegen: number;
	maxMana: number;
	manaRegen: number;
	sightDay: number;
	sightNight: number;
}

export interface HeroAbility {
	name: string;
	nameLoc: string;
	desc: string;
	img: string;
	videoMp4: string;
	videoWebm: string;
	hasScepter: boolean;
	hasShard: boolean;
	isInborn: boolean;
	scepterVideo: string;
	shardVideo: string;
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
	bio: string;
	hype: string;
	stats: HeroStats;
	abilities: HeroAbility[];
	topVideo: string;
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

// role_levels 位置顺序（实测校准）：carry/support/nuker/disabler/jungler/durable/escape/pusher/initiator
const ROLE_ORDER = ['carry', 'support', 'nuker', 'disabler', 'jungler', 'durable', 'escape', 'pusher', 'initiator'];
export const ROLE_LABEL: Record<string, string> = {
	carry: '核心',
	support: '辅助',
	nuker: '爆发',
	disabler: '控制',
	jungler: '打野',
	durable: '肉盾',
	escape: '逃生',
	pusher: '推进',
	initiator: '先手',
};

const ATTR_MAP: Record<number, Attribute> = { 0: 'STR', 1: 'AGI', 2: 'INT', 3: 'UNI' };

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

export async function fetchHero(id: number | string): Promise<Hero> {
	const data = await getJson<{ result: { heroes: any } }>(`${BASE}/hero?hero_id=${id}`);
	const h = data.result.heroes;
	const roles = ROLE_ORDER.map((key, i) => ({ key, label: ROLE_LABEL[key], level: h.role_levels?.[i] ?? 0 }))
		.filter((r) => r.level > 0)
		.sort((a, b) => b.level - a.level);
	return {
		id: h.id,
		name: h.name_loc,
		nameEn: h.name_english_loc,
		attr: ATTR_MAP[h.primary_attr] ?? 'UNI',
		complexity: h.complexity,
		attack: h.attack_capability === 2 ? 'ranged' : 'melee',
		roles,
		img: h.index_img,
		imgCrop: h.crops_img,
		bio: stripHtml(h.bio_loc),
		hype: stripHtml(h.hype_loc),
		topVideo: h.top_video,
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
			armor: h.armor,
			magicResistance: h.magic_resistance,
			moveSpeed: h.movement_speed,
			maxHealth: h.max_health,
			healthRegen: h.health_regen,
			maxMana: h.max_mana,
			manaRegen: h.mana_regen,
			sightDay: h.sight_range_day,
			sightNight: h.sight_range_night,
		},
		abilities: (h.abilities ?? []).map((a) => ({
			name: a.name,
			nameLoc: a.name_loc,
			desc: stripHtml(a.desc_loc),
			img: a.img,
			videoMp4: a.video_mp4,
			videoWebm: a.video_webm,
			hasScepter: Boolean(a.video_scepter_webm) || Boolean(a.video_scepter_mp4),
			hasShard: Boolean(a.video_shard_webm) || Boolean(a.video_shard_mp4),
			isInborn: Boolean(a.is_inborn),
			scepterVideo: a.video_scepter_webm || a.video_scepter_mp4,
			shardVideo: a.video_shard_webm || a.video_shard_mp4,
		})),
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
