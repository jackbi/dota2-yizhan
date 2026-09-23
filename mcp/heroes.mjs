/**
 * 英雄查询：把「火猫」「AM」「灰烬之灵」都指到同一个人身上。
 *
 * 匹配顺序是先精确后模糊，且**模糊只在没有精确命中时才用**——「敌法」既是俗称也恰好是
 * 「敌法师」的前缀，精确那一步就把它定死了，不会跑到别的英雄上。
 */

import { HERO_ALIASES } from './heroAliases.mjs';

/**
 * 查询用的正规化：忽略大小写、空格、连字符、撇号与点。
 *
 * 只动这些分隔符，不碰中文——「影魔」和「影 魔」都该命中，但「小牛」不能被拆成「小」「牛」。
 */
export const normalizeQuery = (value) =>
	String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s\-_'’.·、,，]/g, '');

/** 数据对象上用 WeakMap 挂索引，取一份数据只建一次。 */
const indexes = new WeakMap();

/**
 * 建索引。返回里带 `unmatchedKeys`：俗称表里对不上英雄的键（英雄改名、表里写错字都会落这儿），
 * 自检脚本拿它来报错，不在运行时报。
 */
export function buildIndex(data) {
	const cached = indexes.get(data);
	if (cached) return cached;

	const map = new Map();
	const add = (key, heroId, via) => {
		const normalized = normalizeQuery(key);
		if (!normalized) return;
		const bucket = map.get(normalized) ?? [];
		// 同一个键被两处指到不同英雄时保留两个，交给调用方去纠结（宁可报歧义，不要悄悄选一个）。
		if (!bucket.some((row) => row.heroId === heroId)) bucket.push({ heroId, via });
		map.set(normalized, bucket);
	};

	for (const hero of data.heroes) {
		add(hero.name, hero.id, '中文名');
		add(hero.nameEn, hero.id, '英文名');
	}

	const unmatchedKeys = [];
	for (const [officialName, aliases] of Object.entries(HERO_ALIASES)) {
		const hero = data.heroes.find((entry) => entry.name === officialName);
		if (!hero) {
			unmatchedKeys.push(officialName);
			continue;
		}
		for (const alias of aliases) add(alias, hero.id, '俗称');
	}

	const index = {
		byId: new Map(data.heroes.map((hero) => [hero.id, hero])),
		map,
		unmatchedKeys,
	};
	indexes.set(data, index);
	return index;
}

function uniqueMatches(data, rows, limit) {
	const index = buildIndex(data);
	const seen = new Set();
	const out = [];
	for (const row of rows) {
		if (seen.has(row.heroId)) continue;
		const hero = index.byId.get(row.heroId);
		if (!hero) continue;
		seen.add(row.heroId);
		out.push({ hero, via: row.via });
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 按名字、id 或俗称找英雄。
 *
 * 返回 `{ matches, via, ambiguous }`。`matches` 最多 `limit` 条；一条都没有时才做子串匹配，
 * 免得「火」这种输入把一堆英雄捞出来盖掉真正的精确命中。
 */
export function findHeroes(query, data, limit = 5) {
	const index = buildIndex(data);
	const raw = String(query ?? '').trim();
	if (!raw) return { matches: [], via: null, note: '查询是空的' };

	// 纯数字当 id：`get_hero_stats(106)` 这种直接给 id 的用法不用绕一圈名字。
	if (/^\d+$/.test(raw)) {
		const hero = index.byId.get(Number(raw));
		return hero ? { matches: [{ hero, via: 'id' }], via: 'id' } : { matches: [], via: 'id', note: `没有 id 为 ${raw} 的英雄` };
	}

	const exact = index.map.get(normalizeQuery(raw));
	if (exact?.length) {
		return {
			matches: uniqueMatches(data, exact, limit),
			via: exact[0].via,
			ambiguous: exact.length > 1,
		};
	}

	const key = normalizeQuery(raw);
	const loose = [];
	for (const hero of data.heroes) {
		if (normalizeQuery(hero.name).includes(key) || normalizeQuery(hero.nameEn).includes(key)) {
			loose.push({ heroId: hero.id, via: '模糊' });
		}
	}
	return { matches: uniqueMatches(data, loose, limit), via: loose.length ? '模糊' : null };
}

/** 只要一个英雄时用它：找不到或指向多个就抛错，别让调用方猜。 */
export function resolveHero(query, data) {
	const { matches, via, note } = findHeroes(query, data, 5);
	if (matches.length === 0) {
		throw new Error(`找不到英雄「${query}」${note ? `（${note}）` : ''}。换官方中文名或英文名试试。`);
	}
	if (matches.length > 1 && via === '模糊') {
		const names = matches.map((row) => `${row.hero.name}（${row.hero.nameEn}）`).join('、');
		throw new Error(`「${query}」匹配到多个英雄：${names}。用完整一点的名字。`);
	}
	return { hero: matches[0].hero, via, matches };
}
