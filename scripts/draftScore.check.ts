import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { advise } from '../src/lib/draftScore.ts';
import type { RecordedHand } from '../src/lib/draftOrder.ts';
import { AOE_CLEAR_NAMES, SUMMON_ILLUSION_NAMES, TEAMFIGHT_NAMES } from '../src/data/heroTraits.ts';

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

/**
 * 造一个英雄：`rates` 按一号位到五号位给胜率（null 表示没有样本），
 * `roles` 是官方角色等级（核心/辅助/爆发/控制/打野/耐久/逃生/推进/先手），
 * `traits` 是人工标注的体系与清场能力。
 */
function hero(
	id: number,
	rates: (number | null)[],
	pro: [number, number, number] = [0, 0, 0],
	roles: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0],
	traits: { summon?: boolean; aoe?: boolean; teamfight?: boolean; attack?: 'melee' | 'ranged'; timeline?: [number, number] } = {},
): DraftHero {
	return {
		id,
		name: `英雄${id}`,
		nameEn: `Hero${id}`,
		attr: 'UNI',
		img: '',
		positions: rates.map((rate) => (rate === null ? null : [1000, Math.round(rate * 1000)])),
		pro,
		roles,
		summon: Boolean(traits.summon),
		aoe: Boolean(traits.aoe),
		teamfight: Boolean(traits.teamfight),
		attack: traits.attack ?? 'melee',
		timeline: traits.timeline ?? [0, 0],
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
	matchupMinGames: 200,
	heroes: HEROES,
	proSample: { picks: 620, bans: 532 },
	matchups: {},
	matchupPairs: 0,
	hasPositionData: true,
	hasProData: true,
};

const OUR = 'radiant' as const;

// ---------------------------------------------------------------- 人工名单

/**
 * 体系与清场这两类没有官方数据，是人写的名单，所以至少要保证：
 * 不空、不重复、名字看起来是英雄名。名单与英雄表对不对得上，由构建期对账
 * （对不上的名字会写进数据源日志，见 `draftData`）。
 */
for (const [label, names] of [
	['幻象/召唤体系', SUMMON_ILLUSION_NAMES],
	['AoE 清场', AOE_CLEAR_NAMES],
] as const) {
	assert.ok(names.length >= 8, `${label}名单太短了（${names.length} 个），像是被清空过`);
	assert.equal(new Set(names).size, names.length, `${label}名单里有重复的名字`);
	// 单字英雄名是存在的（陈），所以只查"不像名字"的情况：空串、带空格、带标点。
	for (const name of names) assert.ok(name.length >= 1 && name === name.trim() && !/[\s，、]/.test(name), `${label}名单里的「${name}」不像英雄名`);
}

/**
 * 团战名单单列一条断言：它必须是能一眼看懂的强团战英雄。
 * 这份名单是人定的（自动规则试过，把发条技师排在谜团前面，见 heroTraits 的注释），
 * 所以只查最基本的两件事：名单够长、里面没有重复。
 */
// 名单要覆盖整个英雄池里的团战点，不是挑几个例子：低于 25 个就说明被砍过。
assert.ok(TEAMFIGHT_NAMES.length >= 25, `团战名单太短（${TEAMFIGHT_NAMES.length} 个）`);
assert.equal(new Set(TEAMFIGHT_NAMES).size, TEAMFIGHT_NAMES.length, '团战名单里有重复');
for (const name of ['谜团', '术士', '寒冬飞龙', '凤凰', '黑暗贤者', '杰奇洛']) {
	// 这几个是用户点名的参考：漏掉任何一个都说明名单被改坏了。
	assert.ok(TEAMFIGHT_NAMES.includes(name), `团战名单缺了 ${name}`);
}

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

// ---------------------------------------------------------------- 克制

/**
 * 这一组专门验"克制有没有真的进排序"：两个候选的号位胜率**完全一样**，
 * 只有对位不同（201 好打对面的 203，202 被 203 打），好打的那个必须排在前面。
 *
 * 用同一个号位胜率是刻意的：只要排序出现差别，差别就只可能来自对位。
 */
const counterHeroes = [hero(201, [0.5, null, null, null, null]), hero(202, [0.5, null, null, null, null]), hero(203, [0.5, null, null, null, null]), hero(204, [0.5, null, null, null, null]), hero(205, [0.5, null, null, null, null])];
const counterData: DraftData = {
	...data,
	heroes: counterHeroes,
	// 键是"小 id-大 id"，值是低 id 一方的胜率：201 打 203 赢 60%，202 打 203 只赢 40%。
	matchups: { '201-203': [2000, 0.6], '202-203': [2000, 0.4] },
	matchupPairs: 2,
};
// 前七手跳过，第 8 手我方拿 204，第 9 手对面拿 203，10-12 跳过，第 13 手对面再拿 205，现在第 14 手轮到我方挑选。
const counterRecorded: RecordedHand[] = [null, null, null, null, null, null, null, 204, 203, null, null, null, 205];
const counterAdvice = advise({ data: counterData, recorded: counterRecorded, ourSide: OUR, firstPicker: OUR });
assert.ok(counterAdvice, '这一手应该有建议');
assert.equal(counterAdvice.step, 14);
assert.equal(counterAdvice.action, 'pick');
const good = counterAdvice.candidates.find((candidate) => candidate.heroId === 201);
const bad = counterAdvice.candidates.find((candidate) => candidate.heroId === 202);
assert.ok(good && bad, '两个候选都要在列表里');
assert.ok(good.ranking > bad.ranking, `好打对面的候选排得更靠前（${good.ranking} 应大于 ${bad.ranking}）`);
assert.equal(counterAdvice.candidates[0]?.heroId, 201, '候选顺序应由克制决定');
assert.ok(
	good.reasons.some((line) => line.includes('对阵对面已选') && line.includes('60.0%')),
	'依据里要写清对位胜率，实际：' + good.reasons.join(' / '),
);
assert.ok(good.reasons.some((line) => line.includes('203')), '依据里要带上对手是哪几个英雄');
assert.ok(
	bad.reasons.some((line) => line.includes('40.0%')),
	'被打的那个也要如实写出来，实际：' + bad.reasons.join(' / '),
);

// 没有对位数据时，同样的局面不该出现克制那条依据（退回只按号位胜率算）。
const noCounter = advise({ data: { ...counterData, matchups: {}, matchupPairs: 0 }, recorded: counterRecorded, ourSide: OUR, firstPicker: OUR });
assert.ok(noCounter);
assert.ok(
	!noCounter.candidates.some((candidate) => candidate.reasons.some((line) => line.includes('对位'))),
	'没数据时不该写出对位依据',
);

// ---------------------------------------------------------------- 能力维度与体系

/**
 * 这一组验三件事：
 * 1. 缺控制的时候，控制高的候选要排前面（号位胜率、对位都一样，差别只可能来自能力维度）；
 * 2. 对面是幻象/召唤体系时，清场的目标值从 1 提到 2，并且要写出来；
 * 3. 体系判断来自哪一个英雄。
 */
const traitHeroes = [
	hero(301, [0.5, null, null, null, null], [0, 0, 0], [0, 0, 0, 3, 0, 0, 0, 0, 0]), // 控制 3
	hero(302, [0.5, null, null, null, null]), // 什么都不给
	hero(303, [0.5, null, null, null, null], [0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], { aoe: true }),
	hero(304, [0.5, null, null, null, null], [0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], { summon: true }), // 对面的体系英雄
	hero(305, [0.5, null, null, null, null]), // 我方已选
	hero(306, [0.5, null, null, null, null]), // 对面第二个
];
const traitData: DraftData = { ...data, heroes: traitHeroes, matchups: {}, matchupPairs: 0 };
const traitRecorded: RecordedHand[] = [null, null, null, null, null, null, null, 305, 304, null, null, null, 306];
const traitAdvice = advise({ data: traitData, recorded: traitRecorded, ourSide: OUR, firstPicker: OUR });
assert.ok(traitAdvice, '体系局面也应该有建议');
assert.equal(traitAdvice.step, 14);

const control = traitAdvice.candidates.find((candidate) => candidate.heroId === 301);
const plain = traitAdvice.candidates.find((candidate) => candidate.heroId === 302);
const aoe = traitAdvice.candidates.find((candidate) => candidate.heroId === 303);
assert.ok(control && plain && aoe, '三个候选都要在');
assert.ok(control.ranking > plain.ranking, '缺控制时，控制高的候选要排前面');
assert.ok(control.ranking > aoe.ranking, '控制缺口比清场缺口更急（目标值更大）');
assert.ok(
	control.reasons.some((line) => line.includes('补上阵容缺的控制') && line.includes('0/4')),
	'依据里要写清补的是哪个维度、当前差多少，实际：' + control.reasons.join(' / '),
);
assert.ok(
	aoe.reasons.some((line) => line.includes('清场')),
	'带 AoE 的候选要写明补清场，实际：' + aoe.reasons.join(' / '),
);
assert.match(traitAdvice.composition.text, /控制 0\/4/, '阵容维度要列出控制现状');
assert.ok(traitAdvice.composition.enemySummon, '要认出对面是幻象/召唤体系');
assert.match(traitAdvice.composition.text, /清场 0\/2/, '对面是体系阵容时清场目标提到 2');
assert.match(traitAdvice.composition.text, /幻象\/召唤体系/, '要在界面上说明为什么提高要求');

// 把对面的体系英雄换成普通英雄，清场要求回到 1。
const calmAdvice = advise({
	data: { ...traitData, heroes: traitHeroes.map((item) => (item.id === 304 ? { ...item, summon: false } : item)) },
	recorded: traitRecorded,
	ourSide: OUR,
	firstPicker: OUR,
});
assert.ok(calmAdvice);
assert.ok(!calmAdvice.composition.enemySummon, '没有体系英雄时不该说是体系阵容');
assert.match(calmAdvice.composition.text, /清场 0\/1/, '没有体系时清场目标只要 1');

// ---------------------------------------------------------------- 结构红线

/**
 * 团战：两个候选的角色等级、号位胜率、对位完全一样，只有一个在团战名单里。
 * 阵容缺团战点时，名单里的那个必须排前面，并且依据里要写明补的是团战。
 */
// 角色等级全 0：这样两个候选唯一的差别就只有"在不在团战名单里"。
const TF_ROLES = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const tfHeroes = [
	hero(501, [0.5, null, null, null, null], [0, 0, 0], TF_ROLES, { teamfight: true }),
	hero(502, [0.5, null, null, null, null], [0, 0, 0], TF_ROLES),
	hero(503, [0.5, null, null, null, null]),
	hero(504, [0.5, null, null, null, null]),
	hero(505, [0.5, null, null, null, null]),
];
const tfData: DraftData = { ...data, heroes: tfHeroes, matchups: {}, matchupPairs: 0 };
const tfRecorded: RecordedHand[] = [null, null, null, null, null, null, null, 503, 504, null, null, null, 505];
const tfAdvice = advise({ data: tfData, recorded: tfRecorded, ourSide: OUR, firstPicker: OUR });
assert.ok(tfAdvice);
assert.equal(tfAdvice.candidates[0]?.heroId, 501, '缺团战时，团战点要排在前面');
assert.ok(
	tfAdvice.candidates[0]?.reasons.some((line) => line.includes('团战')),
	'依据里要写明补的是团战，实际：' + (tfAdvice.candidates[0]?.reasons.join(' / ') ?? ''),
);
assert.match(tfAdvice.composition.text, /团战 0\/2/, '结构现状里要列出团战点');

/**
 * 这一组对应真实翻车：AI 选出过「斯温 + 幻影长矛手 + 龙骑士 + 赏金猎人 + 天涯墨客」，
 * 四个近战、三个吃资源的核心、没有清场。当时的打分只检查"缺口"（控制/爆发够不够），
 * 这种阵容在缺口检查里居然是达标的，所以必须把"过量"单独扣分。
 *
 * 构造：队长已经有两个纯核（核心等级 3）、三个近战，现在两个候选号位胜率与对位完全相同，
 * 只有一个会把阵容推过红线 —— 过线的那个必须排在后面，并且风险里要说清楚。
 */
const CARRY_ROLES = [3, 0, 2, 0, 0, 0, 0, 0, 0]; // 纯核（核心 3、爆发 2）
const SUPPORT_ROLES = [0, 3, 0, 2, 0, 0, 0, 0, 0]; // 辅助
const capHeroes = [
	hero(401, [0.5, null, null, null, null], [0, 0, 0], CARRY_ROLES, { attack: 'melee' }),
	hero(402, [0.5, null, null, null, null], [0, 0, 0], CARRY_ROLES, { attack: 'melee' }),
	hero(403, [0.5, null, null, null, null], [0, 0, 0], CARRY_ROLES, { attack: 'melee' }), // 第三个纯核
	hero(404, [0.5, null, null, null, null], [0, 0, 0], SUPPORT_ROLES, { attack: 'ranged' }), // 辅助+远程
	hero(405, [0.5, null, null, null, null]), // 对面的第一个
	hero(406, [0.5, null, null, null, null]), // 对面的第二个
];
const capData: DraftData = { ...data, heroes: capHeroes, matchups: {}, matchupPairs: 0 };
// 第 8 手我方 401、第 9 手对面 405、第 13 手对面 406、第 14 手我方 402 → 第 15 手轮到我方挑选
const capRecorded: RecordedHand[] = [null, null, null, null, null, null, null, 401, 405, null, null, null, 406, 402];
const capAdvice = advise({ data: capData, recorded: capRecorded, ourSide: OUR, firstPicker: OUR });
assert.ok(capAdvice, '这一手应该有建议');
assert.equal(capAdvice.step, 15);
assert.equal(capAdvice.action, 'pick');

const thirdCarry = capAdvice.candidates.find((candidate) => candidate.heroId === 403);
const supportPick = capAdvice.candidates.find((candidate) => candidate.heroId === 404);
assert.ok(thirdCarry && supportPick, '两个候选都要在');
assert.match(capAdvice.composition.text, /纯核 2\/2/, '结构现状要显示纯核已经到上限');
assert.ok(
	supportPick.ranking > thirdCarry.ranking,
	`补辅助的候选要排在第三个纯核前面（${supportPick.ranking} 应大于 ${thirdCarry.ranking}）`,
);
assert.equal(capAdvice.candidates[0]?.heroId, 404, '首选应该是补辅助+远程的那个');
assert.match(thirdCarry.risk, /3 个纯核/, '过红线的候选要在风险里写清后果，实际：' + thirdCarry.risk);

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
