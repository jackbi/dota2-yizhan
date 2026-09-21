import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import type { LaneData } from '../src/lib/draftLanes.ts';
import { buildVerdict } from '../src/lib/draftVerdict.ts';

/**
 * 「双方阵容锁定后的对比」自检。
 *
 * 这一段最危险的不是算错，而是**把猜测说成结论**：胜率是个具体的小数，多一项启发式折进去
 * 看起来只是"更全面"，其实是在给一个没有换算系数的东西编概率。所以这里钉住的是口径本身：
 * 胜率只能由号位偏差与对位偏差加出来、两边互补、镜像阵容必须五五开，以及
 * 「结构不进胜率」这句话必须留给用户看。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftVerdict.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

function hero(id: number, name: string, rate: number | null, roles: number[] = []): DraftHero {
	return {
		id,
		name,
		nameEn: `Hero${id}`,
		attr: 'UNI',
		img: '',
		// 每个英雄只给一个号位样本：`positions` 的索引就是号位。
		positions: Array.from({ length: 5 }, (_, index) => (index === (id - 1) % 5 && rate !== null ? [1000, Math.round(rate * 1000)] : null)) as DraftHero['positions'],
		pro: [0, 0, 0],
		roles: Array.from({ length: 9 }, (_, index) => roles[index] ?? 0),
		summon: false,
		aoe: false,
		teamfight: false,
		attack: 'melee',
		timeline: [0, 0],
	};
}

const data: DraftData = {
	updatedAt: '2026-09-18T00:00:00.000Z',
	bracketLabel: '超凡入圣及以上',
	windowDays: 7,
	patch: { version: '7.41f', date: '2026-09-15', straddles: false },
	minPositionMatches: 200,
	matchupMinGames: 200,
	heroes: [
		hero(1, '甲', 0.54),
		hero(2, '乙', 0.52),
		hero(3, '丙', 0.53),
		hero(4, '丁', 0.5),
		hero(5, '戊', 0.51),
		hero(6, '己', 0.48),
		hero(7, '庚', 0.47),
		hero(8, '辛', 0.49),
		hero(9, '壬', 0.5),
		hero(10, '癸', 0.46),
	],
	proSample: { picks: 0, bans: 0 },
	matchups: {},
	matchupPairs: 0,
	hasPositionData: true,
	hasProData: false,
};

const strong = [1, 2, 3, 4, 5];
const weak = [6, 7, 8, 9, 10];
const base = { data, ourSide: 'radiant' as const, selfTeam: '我方队', foeTeam: '对面队' };

// 阵容没锁就没有「双方的阵容」可比。
{
	assert.equal(buildVerdict({ ...base, ourIds: [1, 2, 3, 4], theirIds: weak }), null, '我方只有 4 个人时不比');
	assert.equal(buildVerdict({ ...base, ourIds: strong, theirIds: [6, 7] }), null, '对面只有 2 个人时不比');
	ok('阵容没锁完时直接返回 null');
}

// 胜率的来源必须说得清：两项相加、两边互补。
{
	const verdict = buildVerdict({ ...base, ourIds: strong, theirIds: weak });
	assert.ok(verdict, '需要一份对比结果');
	const v = verdict!;
	assert.equal(v.rows.length, 16, `维度行数不对（${v.rows.length}）：2 项胜率来源 + 11 个能力维度 + 3 项结构`);
	assert.ok(Math.abs(v.winRate.ours + v.winRate.theirs - 1) < 1e-9, '两边胜率必须互补');
	assert.ok(v.winRate.ours > 0.5, '号位胜率明显更高的一边应该赢面更大');
	assert.ok(
		Math.abs(v.winRate.ours - (0.5 + v.edge.total)) < 1e-9,
		'胜率必须就是 0.5 + 两项偏差之和（没有被别的项偷偷改过）',
	);
	assert.ok(
		Math.abs(v.edge.total - (v.edge.position + v.edge.counter)) < 1e-9,
		'总偏差必须由号位偏差与对位偏差组成',
	);
	// 号位偏差的符号：我方五个号位胜率都更高，这一项必须是正的。
	assert.ok(v.edge.position > 0, '号位偏差方向反了');
	assert.equal(v.edge.counter, 0, '这局没有任何对位数据，对位偏差必须是 0');
	assert.ok(
		v.notes.some((note) => note.includes('不进胜率')),
		'必须明确告诉用户：能力维度与结构是启发式，不参与胜率',
	);
	assert.ok(
		v.rows.filter((row) => row.percent).length === 2,
		'只有「平均号位胜率」「对位偏差」两行是百分比口径',
	);
	ok('胜率 = 0.5 + 号位偏差 + 对位偏差，两边互补，口径写在提示里');
}

// 镜像阵容必须五五开：这是"没有偷偷加料"的最好证据。
{
	const same = buildVerdict({ ...base, ourIds: strong, theirIds: strong });
	assert.ok(same, '镜像阵容也要能比');
	assert.equal(same!.winRate.ours, 0.5, '两边阵容一样时不该有偏向');
	assert.equal(same!.edge.position, 0);
	assert.ok(
		same!.rows.every((row) => row.better === 'even'),
		'镜像阵容的每一行都该是持平',
	);
	ok('镜像阵容五五开，每一行都判持平');
}

// 对位：取一边的平均、另一边镜像，绝不做两边求和。
//
// 这一条是被实测抓出来的：一开始两边各求一次和，跑出来是「对位偏差 -47.8 个百分点」，
// 胜率被顶到 15% : 85%。原因是留存的对位只包含偏差 ≥4% 的那一千对，
// 五个人的极端值加起来根本不是胜率该有的量级，而且两边算的是同一份记录（两个方向）。
{
	// 英雄 1 打英雄 6 是 60%，其余对偶没有留存（真实数据也是这样稀疏）。
	const matchupData: DraftData = { ...data, matchups: { '1-6': [2000, 0.6] }, matchupPairs: 1 };
	const v = buildVerdict({ ...base, data: matchupData, ourIds: strong, theirIds: weak });
	assert.ok(v, '有对位数据时也要能算');
	// +10 个百分点摊到五个号位是 +2，再乘 COUNTER_WEIGHT 是 +3。
	assert.ok(Math.abs(v!.ours.counter - 0.02) < 1e-9, `对位要取平均（+2.0%），实际 ${(v!.ours.counter * 100).toFixed(1)}%`);
	assert.equal(v!.theirs.counter, -v!.ours.counter, '两个方向必须是同一份记录的镜像');
	assert.ok(Math.abs(v!.edge.counter - 0.03) < 1e-9, `对位偏差要乘 COUNTER_WEIGHT，实际 ${(v!.edge.counter * 100).toFixed(1)}%`);
	assert.ok(Math.abs(v!.edge.total - (v!.edge.position + v!.edge.counter)) < 1e-9, '总偏差只能由这两项组成');
	assert.ok(Math.abs(v!.winRate.ours - (0.5 + v!.edge.total)) < 1e-9, '胜率仍然只是 0.5 + 两项偏差');
	assert.equal(v!.rows.find((row) => row.key === 'counter')?.better, 'ours', '对位占优的一边要标出来');
	assert.ok(v!.winRate.ours > 0.5 && v!.winRate.ours < 0.75, `对位优势不该把胜率顶到极端值，实际 ${(v!.winRate.ours * 100).toFixed(1)}%`);
	ok('对位取平均、另一边镜像，量级与号位偏差可比');
}

// 对位表稀疏时，同一场对局从两边算出来的胜率必须互补。
//
// 这不是理论问题：真实数据里 5v5 的 25 对常常只留 22–24 对，而我方算的是「每个我方英雄对它
// 对面五人的平均」、对面算的是按他们的人分组——同一批缺失在两种分组下分母不同，
// 于是两边的平均不是精确的相反数（实测能差 3 个百分点）。所以两边都有数据时取中间值。
{
	// 我方 1 号位对 6 / 7 都有记录，2 号位只和 8 有记录；对面那侧的分组完全不同。
	const sparse: DraftData = { ...data, matchups: { '1-6': [2000, 0.6], '1-7': [2000, 0.8], '2-8': [2000, 0.5] }, matchupPairs: 3 };
	const forward = buildVerdict({ ...base, data: sparse, ourIds: strong, theirIds: weak });
	const backward = buildVerdict({ ...base, data: sparse, ourIds: weak, theirIds: strong, ourSide: 'dire' });
	assert.ok(forward && backward, '两边都要能算');
	const sum = forward!.winRate.ours + backward!.winRate.ours;
	assert.ok(Math.abs(sum - 1) < 1e-9, `同一场对局从两边算必须互补，实际加起来是 ${(sum * 100).toFixed(2)}%`);
	assert.equal(forward!.theirs.counter, -forward!.ours.counter, '两列仍然要镜像展示');
	ok('对位表稀疏时胜率与视角无关');
}

// 分路对位：单独一行、独立口径、**不进胜率**。
//
// 线上净胜是「线上阶段的胜 − 负」，与整局对位不是一回事。写进同一行会让人以为胜率里含了它，
// 所以这里钉三件事：一行单独出现、两边各自独立取样、胜率一分不变。
{
	/*
	 * 专用夹具：每个人都补齐五个号位的样本、主号位明显更高。
	 * 通用夹具里每人只有一个号位有样本，五个人的总分与排列无关——号位分配会是任意的，
	 * 而线上对位的键里带着号位，断言就会跟着乱序飘。
	 */
	const laners: DraftHero[] = Array.from({ length: 10 }, (_, index) => {
		const main = (index % 5) + 1;
		return {
			...hero(101 + index, `L${101 + index}`, null),
			positions: Array.from({ length: 5 }, (_, slot) => [1000, slot === main - 1 ? 600 : 500]) as DraftHero['positions'],
		};
	});
	const laneData: DraftData = { ...data, heroes: laners, matchups: {}, matchupPairs: 0 };
	const lanes: LaneData = {
		// 键是 `英雄id|号位|另一个英雄id`，值是 [场次, 净对线千分比]
		vs: {
			'101|1|106': [1200, 240],
			'102|2|107': [800, -160],
			// 108 这一格只有反方向：我方 103 打三号位时线上对 108，要靠反方向取反号拿到 −10%
			'108|3|103': [600, 100],
		},
		with: { '101|1|105': [900, 130] },
	};
	const v = buildVerdict({ ...base, data: laneData, ourIds: [101, 102, 103, 104, 105], theirIds: [106, 107, 108, 109, 110], lanes })!;
	const laneRow = v.rows.find((row) => row.key === 'lane');
	assert.ok(laneRow, '有线上数据时要出一行「分路对位」');
	assert.equal(laneRow!.percent, true, '分路对位是百分比口径');
	assert.deepEqual(
		v.laneEdges.map((edge) => `${edge.side}:${edge.position}:${edge.hero.id}`),
		['ours:1:101', 'ours:2:102', 'ours:3:103', 'theirs:1:106', 'theirs:2:107', 'theirs:3:108'],
		'每条线上对位都要带上是哪一边、几号位、谁；反方向那一格也算数',
	);
	assert.deepEqual(
		v.laneEdges[0].opponents.map((entry) => entry.hero.id),
		[106],
		'线上真的遇到过的对手要列出来，名字靠它填',
	);
	assert.ok(
		Math.abs(laneRow!.ours - (0.24 - 0.16 - 0.1) / 3) < 1e-9,
		`我方视角是三个人的平均 (+24 −16 −10)/3 = −0.7%，实际 ${(laneRow!.ours * 100).toFixed(1)}%`,
	);
	// 对面那一列是各自独立测的：106 靠反方向拿 −24%、107 靠反方向拿 +16%、108 正方向 +10%。
	assert.ok(Math.abs(laneRow!.theirs - (-0.24 + 0.16 + 0.1) / 3) < 1e-9, `对面那一列要用他们自己的三个数，实际 ${(laneRow!.theirs * 100).toFixed(1)}%`);
	// 这份夹具是对称的（每边各三格、正好互为反面），所以两列数值上互为相反数；
	// 真实数据里两边采样的格子不一样，就不会刚好对称——口径说明里写清了这一点。
	assert.equal(v.lanePartners.length, 1, '同路搭档只取常规分路：一号位 ↔ 五号位、三号位 ↔ 四号位；这里只有一号位与五号位有数据');
	assert.deepEqual(
		v.lanePartners.map((pair) => `${pair.side}:${pair.position}-${pair.hero.id}/${pair.partner.id}`),
		['ours:1-101/105'],
		'同路搭档要对上号位，而不是随便配对',
	);
	assert.ok(
		Math.abs(v.winRate.ours - (0.5 + v.edge.position + v.edge.counter)) < 1e-9,
		'分路对位一行再好看也不能进胜率',
	);
	assert.ok(
		v.notes.some((note) => note.includes('线上阶段') && note.includes('不进胜率')),
		'提示词与界面上要写清：分路对位是线上口径、不进胜率',
	);

	// 一格都没有时不该出现这一行：写两个 0 会被读成「线上打平」。
	const none = buildVerdict({ ...base, ourIds: strong, theirIds: weak, lanes: { vs: {}, with: {} } })!;
	assert.equal(none.rows.some((row) => row.key === 'lane'), false, '没有线上数据时不出这一行');
	assert.equal(none.laneEdges.length, 0, '也没有对位边');
	const absent = buildVerdict({ ...base, ourIds: strong, theirIds: weak })!;
	assert.equal(absent.rows.some((row) => row.key === 'lane'), false, '不传 lanes 时与传空表一致');
	ok('分路对位：独立一行、独立取样、不进胜率');
}

// 对面拿到熟手只列出来，不折算进胜率——没有换算系数就不该编一个。
{
	const foeForm = {
		name: '对面队',
		windowDays: 30,
		matches: 10,
		decided: 8,
		wins: 5,
		heroes: [
			{ heroId: 6, picks: 6, decided: 5, wins: 4, bansAgainst: 3 },
			{ heroId: 7, picks: 1, decided: 1, wins: 1, bansAgainst: 0 },
		],
	};
	const withFoe = buildVerdict({ ...base, ourIds: strong, theirIds: weak, foeForm });
	const withoutFoe = buildVerdict({ ...base, ourIds: strong, theirIds: weak });
	assert.equal(withFoe!.winRate.ours, withoutFoe!.winRate.ours, '熟手不参与胜率计算');
	assert.deepEqual(withFoe!.foePicks.map((pick) => pick.hero.id), [6], '只列窗口里拿过 2 场以上的（1 场的不算熟手）');
	assert.equal(withFoe!.foePicks[0]!.rate, 0.8, '要带上胜率');
	assert.ok(
		withFoe!.notes.some((note) => note.includes('没有可信的换算系数')),
		'要说明为什么熟手不进胜率',
	);
	ok('对面熟手只列出来不折算，且样本不足的不算熟手');
}

console.log(`draftVerdict 全部断言通过（${cases} 组）`);
