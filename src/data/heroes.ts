import heroData from './heroes.json';
import type { Attribute, Hero } from './types';

export interface HeroMeta {
	count: number;
	updated: number;
	source: string;
}

const payload = heroData as { heroes: Hero[]; count: number; updated: number; source: string };

/** 官方接口获取的英雄数据（127 位，含属性、定位、数值、技能与背景）。 */
export const HEROES: Hero[] = payload.heroes;
export const HERO_META: HeroMeta = {
	count: payload.count,
	updated: payload.updated,
	source: payload.source,
};

export function getHeroById(id: number | string | undefined): Hero | undefined {
	return HEROES.find((h) => h.id === Number(id));
}

export function heroIndex(id: number | string): number {
	return HEROES.findIndex((h) => h.id === Number(id));
}

export function heroNeighbors(id: number | string): { prev?: Hero; next?: Hero } {
	const i = heroIndex(id);
	if (i < 0) return {};
	return {
		prev: HEROES[(i - 1 + HEROES.length) % HEROES.length],
		next: HEROES[(i + 1) % HEROES.length],
	};
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

/** 数值单位换算：法术恢复/护甲等保留 2 位 */
export function fmt(n: number, digits = 0): string {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}
