import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'src/data/heroes.json');

const BASE = 'https://www.dota2.com.cn/datafeed';
const HEADERS = {
	'User-Agent': 'Mozilla/5.0',
	Referer: 'https://www.dota2.com.cn/heroes',
	Accept: 'application/json',
};

// primary_attr: 0=STR 1=AGI 2=INT 3=UNI
const ATTR_MAP = ['STR', 'AGI', 'INT', 'UNI'];
// role_levels 位置顺序（经实测校准）：carry/support/nuker/disabler/jungler/durable/escape/pusher/initiator
const ROLE_ORDER = ['carry', 'support', 'nuker', 'disabler', 'jungler', 'durable', 'escape', 'pusher', 'initiator'];
const ROLE_LABEL = {
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

async function getJson(url) {
	let lastErr;
	for (let i = 0; i < 3; i++) {
		try {
			const res = await fetch(url, { headers: HEADERS });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.status !== 'success') throw new Error(`status=${data.status}`);
			return data;
		} catch (e) {
			lastErr = e;
			await new Promise((r) => setTimeout(r, 500 * (i + 1)));
		}
	}
	throw lastErr;
}

function simplifyDetail(h) {
	const roles = ROLE_ORDER.map((key, i) => ({ key, label: ROLE_LABEL[key], level: h.role_levels?.[i] ?? 0 }))
		.filter((r) => r.level > 0)
		.sort((a, b) => b.level - a.level);

	const abilities = (h.abilities ?? []).map((a) => ({
		name: a.name,
		nameLoc: a.name_loc,
		desc: a.desc_loc,
		img: a.img,
	}));

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
		imgTop: h.top_img,
		bio: h.bio_loc,
		hype: h.hype_loc,
		npe: h.npe_desc_loc,
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
		abilities,
	};
}

async function main() {
	const listRes = await getJson(`${BASE}/heroList?task=herolist`);
	const list = listRes.result.heroes;
	console.log(`获取英雄列表：${list.length} 位`);

	const detailById = new Map();
	let cursor = 0;
	const pool = 8;

	async function worker() {
		while (cursor < list.length) {
			const i = cursor++;
			const h = list[i];
			try {
				const d = await getJson(`${BASE}/hero?hero_id=${h.id}`);
				detailById.set(h.id, simplifyDetail(d.result.heroes));
			} catch (e) {
				console.warn(`  [${i + 1}/${list.length}] ${h.name_english_loc} 详情失败，使用列表数据回退：${e.message}`);
				detailById.set(
					h.id,
					simplifyDetail({
						...dummyFromList(h),
						role_levels: [],
						abilities: [],
					}),
				);
			}
			if ((i + 1) % 16 === 0) console.log(`  进度 ${i + 1}/${list.length}`);
		}
	}

	await Promise.all(Array.from({ length: pool }, worker));

	const heroes = list.map((h) => {
		const base = detailById.get(h.id) ?? simplifyDetail(dummyFromList(h));
		return {
			...base,
			id: base.id ?? h.id,
			name: base.name ?? h.name_loc,
			nameEn: base.nameEn ?? h.name_english_loc,
			attr: base.attr ?? ATTR_MAP[h.primary_attr],
			complexity: base.complexity ?? h.complexity,
			img: base.img ?? h.index_img,
			imgCrop: base.imgCrop ?? h.crops_img,
			imgTop: base.imgTop ?? h.top_img,
		};
	});

	heroes.sort((a, b) => {
		const av = ['STR', 'AGI', 'INT', 'UNI'].indexOf(a.attr);
		const bv = ['STR', 'AGI', 'INT', 'UNI'].indexOf(b.attr);
		return av - bv || a.name.localeCompare(b.name, 'zh');
	});

	const payload = {
		updated: Math.floor(Date.now() / 1000),
		count: heroes.length,
		source: `${BASE}/heroList?task=herolist`,
		heroes,
	};
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, JSON.stringify(payload, null, 2));
	console.log(`已写入 ${OUT}（${heroes.length} 位英雄）`);
}

function dummyFromList(h) {
	return {
		name: h.name_loc,
		name_english_loc: h.name_english_loc,
		primary_attr: h.primary_attr,
		complexity: h.complexity,
		attack_capability: -1,
		index_img: h.index_img,
		crops_img: h.crops_img,
		top_img: h.top_img,
	};
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
