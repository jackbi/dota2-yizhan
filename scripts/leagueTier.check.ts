import assert from 'node:assert/strict';
import { LEAGUE_TIER_META, SHOWMATCH_META, applyEventTiers, tierMapOf } from '../src/lib/leagueTier.ts';

/**
 * 赛事档位的自检。档位只描述**赛事**（给赛事页画徽章、做档位筛选），不再给队伍分层——
 * 战队名录已改为按 Liquipedia 门户的地区分组（理由见 `src/lib/leagueTier.ts`）。
 *
 * 这里钉的是几处"错了页面也不报错"的地方：
 *
 * 1. **徽章文案**：四个档位都要有 label 与配色，漏一个页面上就是一块空白；
 * 2. **表演赛标记**：Liquipedia 的档位与类型是两个独立字段，表演赛也有正式档位，
 *    这个标记只是提醒读者那不是正式比赛，不该被当成"没有档位"；
 * 3. **降级那一轮把档位从缓存还原**（`tierMapOf` / `applyEventTiers`）：档位挂在赛事上、
 *    不在对阵上，走缓存重建时不会自己跟过去——漏了就是"所有赛事都没档位徽章、
 *    档位筛选把每届都归进其他"。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/leagueTier.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. 徽章文案：四个档位都要有，漏一个页面上就是空白
{
	for (const tier of [1, 2, 3, 4] as const) {
		const meta = LEAGUE_TIER_META[tier];
		assert.ok(meta?.label && meta.cls, `T${tier} 要有文案与配色`);
	}
	assert.equal(LEAGUE_TIER_META[1].label, 'T1');
	assert.equal(SHOWMATCH_META.label, '表演赛');
	ok('档位徽章：1–4 都有文案与配色');
}

// 2. 档位从缓存还原：降级那一轮全站都靠这两步，漏了就是「所有赛事都没档位」
{
	const tiers = tierMapOf([
		{ id: 'blast-slam-8', tier: 1 },
		{ id: 'pgl-wallachia-9', tier: 2, showmatch: false },
		{ id: 'betboom-streamers-battle-15', tier: 3, showmatch: true },
		{ id: 'no-tier-event' },
	]);
	assert.equal(tiers.size, 3, '没有档位的那届不进表（页面本来就不挂徽章）');
	assert.deepEqual(tiers.get('blast-slam-8'), { tier: 1 }, '普通赛事不带 showmatch 键');
	assert.deepEqual(tiers.get('betboom-streamers-battle-15'), { tier: 3, showmatch: true }, '表演赛的标记要带上');

	const events = [
		{ id: 'blast-slam-8' },
		{ id: 'betboom-streamers-battle-15' },
		{ id: 'no-tier-event' },
		{ id: 'brand-new-event' },
	];
	applyEventTiers(events, tiers);
	assert.deepEqual(
		events.map((event) => [event.id, event.tier, event.showmatch]),
		[
			['blast-slam-8', 1, undefined],
			['betboom-streamers-battle-15', 3, true],
			['no-tier-event', undefined, undefined],
			['brand-new-event', undefined, undefined],
		],
		'贴档位只动表里有的；表里没有的、以及这一轮新出现的赛事，保持没有档位',
	);
	ok('档位还原：缓存 → 赛事，缺的不猜');
}

console.log(`leagueTier 全部断言通过（${cases} 组）`);
