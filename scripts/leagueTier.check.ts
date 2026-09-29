import assert from 'node:assert/strict';
import { FIRST_TIER_MAX, LEAGUE_TIER_META, SHOWMATCH_META, bestTierOf, isFirstTier } from '../src/lib/leagueTier.ts';

/**
 * 「这支队算不算一线队」这条判据的自检。
 *
 * 判据本身是近似的（Dota 2 没有官方的一线队名单，理由见 `src/lib/leagueTier.ts`），
 * 所以更要钉住几点容易悄悄错的地方——错了页面上只表现为"名单看着不对"：
 *
 * 1. **取最好档位**：一支队打过 T1 也打过 T3，算 T1，不能被后出现的那次覆盖；
 * 2. **表演赛不算档位**：Liquipedia 里表演赛**也有**正式档位（两个独立字段），
 *    照单全收会把主播队算成"打过 T3 赛事"的职业队；
 * 3. **边界是 ≤ T2**：写在两处（`FIRST_TIER_MAX` 与页面上的说明），这里把它钉成唯一来源。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/leagueTier.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. 取最好的那个档位，与出现顺序无关
{
	assert.equal(bestTierOf([{ tier: 3 }, { tier: 1 }, { tier: 4 }]), 1, '打过 T1 就是 T1');
	assert.equal(bestTierOf([{ tier: 1 }, { tier: 3 }, { tier: 4 }]), 1, '换个顺序结果一样');
	assert.equal(bestTierOf([{ tier: 2 }, {}, { tier: undefined }]), 2, '没档位的那几届跳过');
	assert.equal(bestTierOf([]), undefined, '一场都没打就是没有档位');
	ok('最好档位：取数字最小的那个，与顺序无关');
}

// 2. 表演赛整届不算
{
	assert.equal(bestTierOf([{ tier: 3, showmatch: true }]), undefined, '只打过表演赛 = 没有档位');
	assert.equal(
		bestTierOf([{ tier: 3, showmatch: true }, { tier: 2 }]),
		2,
		'表演赛那一届要被跳过，不能被它把档位带到 T3 以下',
	);
	assert.equal(SHOWMATCH_META.label, '表演赛');
	ok('表演赛：整届跳过，不参与档位比较');
}

// 3. 一线队的边界
{
	assert.equal(FIRST_TIER_MAX, 2, '一线队的边界是 T2');
	assert.equal(isFirstTier(1), true);
	assert.equal(isFirstTier(2), true);
	assert.equal(isFirstTier(3), false, 'T3 不算一线队');
	assert.equal(isFirstTier(4), false);
	assert.equal(isFirstTier(undefined), false, '没有档位的不算一线队');
	ok('一线队 = 打过 T1 或 T2');
}

// 4. 徽章文案：四个档位都要有，漏一个页面上就是空白
{
	for (const tier of [1, 2, 3, 4] as const) {
		const meta = LEAGUE_TIER_META[tier];
		assert.ok(meta?.label && meta.cls, `T${tier} 要有文案与配色`);
	}
	assert.equal(LEAGUE_TIER_META[1].label, 'T1');
	ok('档位徽章：1–4 都有文案与配色');
}

console.log(`leagueTier 全部断言通过（${cases} 组）`);
