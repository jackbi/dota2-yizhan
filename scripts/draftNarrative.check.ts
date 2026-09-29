import assert from 'node:assert/strict';
import type { Advice } from '../src/lib/draftScore.ts';
import { adviceNarrative, opponentMoveReason } from '../src/lib/draftNarrative.ts';

/**
 * 没接模型时那两段模板文案的自检。
 *
 * 这两段是**替模型顶班**的，所以它最容易出的问题跟模型一模一样：说出一个数据里没有的东西。
 * 差别在于它没有立场去编——它只会重排已有的字符串。这里盯三件事：
 *
 * 1. 只重排、不新增：句子里的数字必须能在入参里找到出处；
 * 2. 缺字段时不留半截句子（空的理由会拼出「优先拿 影魔，打 2 号位。。」这种）；
 * 3. **禁用与挑选的号位含义不同**，措辞不能混。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftNarrative.check.ts`）。
 */

function candidate(overrides: Partial<Advice['candidates'][number]> = {}): Advice['candidates'][number] {
	return {
		heroId: 11,
		position: 2,
		rate: 0.543,
		hasSample: true,
		ranking: 1,
		reasons: ['2 号位近 30 天胜率 54.3%（8,120 场）', '现在拿：五号位估值 50.1% → 50.5%'],
		risk: '样本偏少',
		...overrides,
	};
}

function advice(overrides: Partial<Advice> = {}): Advice {
	return {
		action: 'pick',
		owner: 'first',
		ours: true,
		step: 12,
		remaining: { ours: { bans: 2, picks: 3 }, theirs: { bans: 3, picks: 2 } },
		tail: { ban: 'theirs', pick: 'theirs' },
		lineup: [
			{ position: 1, hero: null, rate: 0.5, settled: false },
			{ position: 2, hero: null, rate: 0.5, settled: false },
			{ position: 3, hero: null, rate: 0.5, settled: false },
			{ position: 4, hero: null, rate: 0.5, settled: false },
			{ position: 5, hero: null, rate: 0.5, settled: false },
		],
		candidates: [candidate()],
		foeCandidates: [],
		summary: '第 12 手：我方挑选。',
		composition: { text: '阵容结构：控制 1/2', enemySummon: false },
		...overrides,
	};
}

const heroName = (id: number): string => (id === 11 ? '影魔' : `英雄 #${id}`);

// ---------------------------------------------------------------- 建议那段

const pick = adviceNarrative(advice(), heroName);
assert.match(pick, /优先拿 影魔，打 2 号位/, '挑选要给出动作、英雄与号位');
assert.ok(pick.includes('8,120 场'), '理由里的数字要原样带出来，说明它只做重排');
assert.ok(pick.includes('要留意：样本偏少'), '风险要接上，且带引导词而不是硬贴');
assert.ok(!pick.includes('。。'), '不要拼出连续句号');

const ban = adviceNarrative(advice({ action: 'ban' }), heroName);
assert.match(ban, /优先禁 影魔/, '禁用要用"禁"这个动词');

// 没有候选（比如 24 手走完）时给空串，调用方据此隐藏这一行，而不是显示半句话。
assert.equal(adviceNarrative(advice({ candidates: [] }), heroName), '', '没有候选时不该拼出句子');

// 缺理由与风险时句子仍然完整。
const bare = adviceNarrative(
	advice({ candidates: [candidate({ reasons: [], risk: '' })] }),
	heroName,
);
assert.equal(bare, '优先拿 影魔，打 2 号位。', '没有理由与风险时只留主干，不留空壳');

// ---------------------------------------------------------------- 对手那一手

const banReason = opponentMoveReason({ action: 'ban', position: 5, rate: 0.551, hasSample: true, foePicks: null, windowDays: 30 });
assert.ok(banReason.includes('5 号位'), '要说清是哪个号位');
assert.ok(banReason.includes('55.1%'), '要带出胜率');
// 禁用那一手的号位属于**被禁的一方**，写成"它的几号位"会把归属说反。
assert.ok(!banReason.includes('它的'), `禁用的措辞不能写成出招方自己的号位：${banReason}`);
assert.ok(!banReason.includes('拿过'), '没有熟手数据时不该出现熟手那句');

const familiar = opponentMoveReason({ action: 'ban', position: 5, rate: 0.551, hasSample: true, foePicks: 4, windowDays: 30 });
assert.ok(familiar.includes('近 30 天拿过 4 场'), '有熟手数据时要带上次数与窗口');

const pickReason = opponentMoveReason({ action: 'pick', position: 2, rate: 0.5, hasSample: true, foePicks: null, windowDays: 30 });
assert.match(pickReason, /^打 2 号位/, '挑选是出招方自己的号位，可以直接说"打几号位"');

/*
 * 还剩几禁几选：数字在 BP 顺序表里白拿着，日志行原先一个字都不说。
 *
 * 入参是**落子前**的快照（含当前这一手），句子说的是"落完这手还剩"——所以这一手对应的那项
 * 要减 1。上一版忘了减：第 24 手（全局最后一选）会印出"还剩 0 禁 1 选"，而 BP 已经结束。
 */
const banLeft = opponentMoveReason({ action: 'ban', position: 5, rate: 0.551, hasSample: true, foePicks: null, windowDays: 30, remainingBefore: { bans: 3, picks: 5 } });
assert.ok(banLeft.includes('落完这手还剩 2 禁 5 选'), `禁用这一手之后禁数要减 1：${banLeft}`);
const pickLeft = opponentMoveReason({ action: 'pick', position: 5, rate: 0.551, hasSample: true, foePicks: null, windowDays: 30, remainingBefore: { bans: 0, picks: 1 } });
assert.ok(pickLeft.includes('落完这手还剩 0 禁 0 选'), `最后一手落完不该还剩 1 选：${pickLeft}`);
const floorAtZero = opponentMoveReason({ action: 'pick', position: 5, rate: 0.551, hasSample: true, foePicks: null, windowDays: 30, remainingBefore: { bans: 0, picks: 0 } });
assert.ok(floorAtZero.includes('还剩 0 禁 0 选'), '数字不该变成负数');
const withoutLeft = opponentMoveReason({ action: 'ban', position: 5, rate: 0.551, hasSample: true, foePicks: null, windowDays: 30 });
assert.ok(!withoutLeft.includes('还剩'), '没有这个信息就别提，别留半截句子');

// 没有样本时不能把中性估值说成实测胜率。
const noSample = opponentMoveReason({ action: 'pick', position: 3, rate: 0.5, hasSample: false, foePicks: null, windowDays: 30 });
assert.ok(noSample.includes('样本不足'), '没有样本要直说，不能报一个中性值当胜率');
assert.ok(!noSample.includes('50.0%'), `中性估值不该以胜率的口吻出现：${noSample}`);

console.log('draftNarrative.check 通过');
