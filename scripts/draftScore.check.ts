import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { advise } from '../src/lib/draftScore.ts';
import type { RecordedHand } from '../src/lib/draftOrder.ts';

/**
 * 阵容分析打分层的自检。
 *
 * 这一层最容易犯的不是崩溃，而是**给出看起来很像样、其实没有信息的建议**。写的时候真踩到过：
 * 起初挑选手只按"补进去涨多少"排，可"以后能补到的最强人选"里本来就包含这个英雄，
 * 于是最强的英雄算出来收益是 0，候选顺序基本等于乱序。所以这里用一份手写的小英雄池，
 * 把几条必须成立的性质钉住：
 *
 * 1. 稀缺号位上的最强英雄，现在拿必须比自己以后补更值钱；
 * 2. 候选里不许出现已经被 ban/pick 的英雄；
 * 3. 禁用建议给的是"对面拿走最赚"的英雄，而不是我们自己想要的；
 * 4. 先选权换了阵营之后，第 1 手的归属要跟着换（先选权与天辉夜魇是两件事）；
 * 5. 一条号位数据都没有时仍然给建议，但要标成没有样本。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftScore.check.ts`）。
 */

/** 造一个英雄：`rates` 按一号位到五号位给胜率，null 表示这个位置没有样本。 */
function hero(id: number, rates: (number | null)[], pro: [number, number, number] = [0, 0, 0]): DraftHero {
	return {
		id,
		name: `英雄${id}`,
		nameEn: `Hero${id}`,
		attr: 'UNI',
		img: '',
		positions: rates.map((rate) => (rate === null ? null : [1000, Math.round(rate * 1000)])),
		pro,
	};
}

/**
 * 小池子的设计意图：
 * - 7 号是池子里最强的（三号位 0.66），8 号次之（四号位 0.64），用来测"该抢谁"；
 * - 1、6、9 都能打一号位，样本多，用来测被打劫的折价；
 * - 10 号完全没有号位样本，用来测降级路径。
 */
const HEROES: DraftHero[] = [
	hero(1, [0.52, null, null, null, null], [20, 10, 15]),
	hero(2, [null, 0.51, null, null, null]),
	hero(3, [null, null, 0.5, null, null]),
	hero(4, [null, null, null, 0.43, null]),
	hero(5, [null, null, null, null, 0.5]),
	hero(6, [0.49, null, null, null, null]),
	hero(7, [null, null, 0.66, null, null], [18, 7, 21]),
	hero(8, [null, null, null, 0.64, null]),
	hero(9, [0.48, null, null, null, 0.47]),
	hero(10, [null, null, null, null, null]),
];

const data: DraftData = {
	updatedAt: '2026-09-17T00:00:00.000Z',
	bracketLabel: '超凡入圣及以上',
	windowDays: 7,
	patch: { version: '7.41f', date: '2026-09-15', straddles: false },
	minPositionMatches: 200,
	heroes: HEROES,
	proSample: { picks: 620, bans: 532 },
	hasPositionData: true,
	hasProData: true,
};

const OUR = 'radiant' as const;

// ---------------------------------------------------------------- 第一手与先选权

const first = advise({ data, recorded: [], ourSide: OUR, firstPicker: OUR });
assert.ok(first, '第一手就该有建议');
assert.equal(first.step, 1);
assert.equal(first.action, 'ban', '第一手是先选方禁用');
assert.equal(first.ours, true, '先选方是天辉且我方是天辉时，第一手归我方');
assert.deepEqual(first.remaining.ours, { bans: 7, picks: 5 }, '第一手前我方还剩 7 禁 5 选');
assert.deepEqual(first.remaining.theirs, { bans: 7, picks: 5 }, '第一手前对方还剩 7 禁 5 选');
assert.deepEqual(first.tail, { ban: 'theirs', pick: 'theirs' }, '最后两手都归后选方');
assert.match(first.summary, /第 1 手/, '总体判断里要带手号');
assert.match(first.summary, /最后一手/, '总体判断里要提最后一手的归属');

// 先选权与阵营是两件事：换成我方是夜魇，第一手就不是我们的。
const firstAsDire = advise({ data, recorded: [], ourSide: 'dire', firstPicker: OUR });
assert.ok(firstAsDire);
assert.equal(firstAsDire.ours, false, '先选方是天辉时，夜魇的第一手不属于我方');

// ---------------------------------------------------------------- 候选的通用性质

const bannedSoFar: RecordedHand[] = [1, 2, 3, 4, 5, 6, 9]; // 前七手全是禁用
const afterBans = advise({ data, recorded: bannedSoFar, ourSide: OUR, firstPicker: OUR });
assert.ok(afterBans);
assert.equal(afterBans.step, 8, '前七手禁用之后轮到我方挑选');
assert.equal(afterBans.action, 'pick');
assert.equal(afterBans.ours, true);
// 被禁掉的英雄不属于任何一方的阵容。这一条曾经写错过：把禁掉的英雄也算进了己方名单，
// 结果第 10 手时对面"已经有五个人"，禁用建议全部退化成 0 分。
assert.equal(afterBans.lineup.filter((slot) => slot.settled).length, 0, '只禁不选时不该有人进阵容');

/** 稀缺号位上的最强英雄（7 号打三号位 0.66），现在拿必须比"以后补"更值。 */
assert.equal(afterBans.candidates[0]?.heroId, 7, `轮到我方挑选时首选应是池子里最强的 7 号，实际是 ${afterBans.candidates[0]?.heroId}`);
assert.equal(afterBans.candidates[0]?.position, 3, '7 号应落在三号位');
assert.ok((afterBans.candidates[0]?.ranking ?? 0) > 0, '首选的收益必须为正，否则等于没建议');
assert.match(afterBans.candidates[0]?.reasons[0] ?? '', /3 号位/, '依据要说清是哪个号位');
assert.match(afterBans.candidates[0]?.reasons[0] ?? '', /\d+\.\d%/, '依据要带具体数字');

// 候选排序、去重，且不能出现已经用掉的英雄。
const rankings = afterBans.candidates.map((candidate) => candidate.ranking);
assert.deepEqual(rankings, [...rankings].sort((a, b) => b - a), '候选必须按分值降序');
assert.equal(new Set(afterBans.candidates.map((c) => c.heroId)).size, afterBans.candidates.length, '候选之间有重复');
for (const candidate of afterBans.candidates) {
	assert.ok(!bannedSoFar.includes(candidate.heroId), `候选里出现了已经被禁的英雄 ${candidate.heroId}`);
	assert.ok(candidate.reasons.length >= 2, '每个候选至少要有两条依据');
	assert.ok(candidate.risk.length > 0, '每个候选都要给风险提示');
}
// 池子里已经被禁掉七个，只剩三个英雄可选，候选数不能超过可选的数目。
assert.equal(afterBans.candidates.length, 3, '候选数不该超过还没被用掉的英雄数');
assert.equal(advise({ data, recorded: bannedSoFar, ourSide: OUR, firstPicker: OUR, limit: 2 })?.candidates.length, 2, 'limit 应生效');

// ---------------------------------------------------------------- 禁用建议

// 我方拿掉 8 号（四号位 0.64），对面拿掉 1 号，第 10 手轮到我方禁用。
const beforeBan: RecordedHand[] = [...bannedSoFar, 8, 1];
const ourBan = advise({ data, recorded: beforeBan, ourSide: OUR, firstPicker: OUR });
assert.ok(ourBan);
assert.equal(ourBan.step, 10);
assert.equal(ourBan.action, 'ban');
assert.equal(ourBan.ours, true, '第 10 手是先选方禁用，我方是先选方');
assert.equal(ourBan.candidates[0]?.heroId, 7, `禁用首选应是剩下的最强点 7 号，实际是 ${ourBan.candidates[0]?.heroId}`);
assert.ok(!ourBan.candidates.some((candidate) => candidate.heroId === 8), '我方已经拿掉的英雄不该出现在禁用候选里');
assert.ok(!ourBan.candidates.some((candidate) => candidate.heroId === 1), '对面已经拿掉的英雄不该出现在禁用候选里');
assert.match(ourBan.summary, /第 10 手/);

// 我方阵容里已经到手的人，要出现在 lineup 的对应号位上。
const settled = ourBan.lineup.filter((slot) => slot.settled);
assert.equal(settled.length, 1, '我方目前只拿了 8 号一个人');
assert.equal(settled[0]?.hero?.id, 8);
assert.equal(settled[0]?.position, 4, '8 号只有四号位样本，应落在四号位');
assert.match(ourBan.summary, /还缺/, '阵容有缺口时要在总体判断里说出来');

// ---------------------------------------------------------------- 边界

// 走满 24 手之后没有"下一手"。
const full: RecordedHand[] = HEROES.map((item) => item.id).concat(Array.from({ length: 14 }, (_, index) => 100 + index));
assert.equal(full.length, 24);
assert.equal(advise({ data, recorded: full, ourSide: OUR, firstPicker: OUR }), null, '24 手走完后不该再给建议');

// 一条号位样本都没有时仍要给建议，但必须标明没有样本。
const noSampleData: DraftData = { ...data, heroes: [hero(11, [null, null, null, null, null]), hero(12, [null, null, null, null, null])], hasPositionData: false };
const degraded = advise({ data: noSampleData, recorded: [], ourSide: OUR, firstPicker: OUR });
assert.ok(degraded, '没有号位样本时也要给建议，靠其他信号撑着');
assert.equal(degraded.candidates[0]?.hasSample, false, '没有样本时要标出来');
assert.ok(degraded.candidates.every((candidate) => candidate.reasons.length >= 1));

console.log('draftScore 全部断言通过');
