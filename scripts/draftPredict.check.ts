import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { predictDraftLocal } from '../src/lib/draftPredict.ts';
import { buildPredictionMessages, parsePredictionReply, parsePredictionReplyDetailed } from '../src/lib/draftPrompt.ts';
import { FAMILIARITY_WEIGHT, buildRosterProfile } from '../src/lib/teamSignature.ts';
import { mergeBans, predictionHands } from '../src/lib/draftPredict.ts';

/**
 * 「AI 预测整局 BP」这一层的自检。
 *
 * 这里最容易出的是**看起来对、其实两边分错或英雄重复**：预测结果是 24 张头像，
 * 只要数量对、页面上就看不出问题，但一个英雄被两边同时选中是 DOTA 里不可能发生的事。
 * 所以三条性质必须钉住：
 *
 * 1. 24 手走满、每边 7 禁 5 选，且**没有任何英雄被用两次**；
 * 2. 先选权换边之后，第 1 手（以及整条归属）跟着换；
 * 3. 模型那份回复的解析：重复英雄、编出来的英雄、少一个挑选都要判成"这次没结果"，
 *    由调用方退回本地推演——绝不能把半截结果当成预测摆到界面上。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftPredict.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 造一个英雄：每个号位都有样本，胜率按 id 排开，保证打分层的排序是确定的。 */
function hero(id: number, rate: number): DraftHero {
	return {
		id,
		name: `英雄${id}`,
		nameEn: `Hero${id}`,
		attr: 'UNI',
		img: '',
		positions: [1, 2, 3, 4, 5].map(() => [1000, Math.round(rate * 1000)] as [number, number]),
		pro: [0, 0, 0],
		roles: [0, 0, 0, 0, 0, 0, 0, 0, 0],
		summon: false,
		aoe: false,
		teamfight: false,
		attack: 'melee',
		timeline: [0, 0],
	};
}

/** 40 个英雄：24 手之后还剩得下候选，这样才能真的走满整局。 */
const HEROES: DraftHero[] = Array.from({ length: 40 }, (_, index) => hero(index + 1, 0.45 + index * 0.001));

const data: DraftData = {
	updatedAt: '2026-09-17T00:00:00.000Z',
	bracketLabel: '超凡入圣及以上',
	windowDays: 7,
	windowLabel: '上一个完整统计周',
	patch: { version: '7.41f', date: '2026-09-15', straddles: false },
	minPositionMatches: 200,
	matchupMinGames: 200,
	heroes: HEROES,
	proSample: { picks: 0, bans: 0 },
	matchups: {},
	matchupPairs: 0,
	laneMinGames: 50,
	hasPositionData: true,
	hasProData: false,
} as unknown as DraftData;

// ---------------------------------------------------------------- 本地推演

const fromRadiant = predictDraftLocal({ data, firstPicker: 'radiant' });
const fromDire = predictDraftLocal({ data, firstPicker: 'dire' });

{
	assert.ok(fromRadiant && fromDire, '有足够的英雄时应当能推出整局');
	for (const [label, prediction] of [
		['先选天辉', fromRadiant!],
		['先选夜魇', fromDire!],
	] as const) {
		const { radiant, dire } = prediction;
		assert.equal(radiant.bans.length, 7, `${label}：天辉要有 7 手禁用`);
		assert.equal(dire.bans.length, 7, `${label}：夜魇要有 7 手禁用`);
		assert.equal(radiant.picks.length, 5, `${label}：天辉要有 5 手挑选`);
		assert.equal(dire.picks.length, 5, `${label}：夜魇要有 5 手挑选`);

		const used = [...radiant.bans, ...radiant.picks, ...dire.bans, ...dire.picks].map((row) => row.heroId);
		assert.equal(used.length, 24, `${label}：一局就是 24 手`);
		assert.equal(new Set(used).size, 24, `${label}：同一个英雄不能被禁/选了两次`);
		assert.ok(used.every((id) => Number.isInteger(id) && id > 0), `${label}：英雄 id 必须是正整数`);
		for (const row of [...radiant.picks, ...dire.picks]) {
			assert.ok(row.reason.length > 0, `${label}：每一个挑选都要带一句依据`);
		}
		/*
		 * 每边五个挑选的号位必须**刚好占满 1 到 5**：号位是这一版新加的，
		 * 界面要靠它写"这个位置上的这个人会不会它"，两个人都算二号位就等于没写。
		 */
		for (const [who, side] of [['天辉', radiant], ['夜魇', dire]] as const) {
			assert.deepEqual(
				side.picks.map((row) => row.position).sort((a, b) => a - b),
				[1, 2, 3, 4, 5],
				`${label}：${who}的五个挑选要各占一个号位`,
			);
		}
	}
	ok('24 手走满：每边 7 禁 5 选，英雄不重复、每条都带依据，挑选带号位');
}

{
	/*
	 * 先选权换边之后，第 1 手要跟着换。做法是比对"空盘面下的第一手"：
	 * 两次的候选排序是镜像的，所以应当是同一个英雄，但一个记在天辉、一个记在夜魇。
	 */
	assert.equal(
		fromRadiant!.radiant.bans[0]?.heroId,
		fromDire!.dire.bans[0]?.heroId,
		'先选权换边之后，第 1 手（禁用）要落到另一边头上，英雄本身不变',
	);
	assert.notDeepEqual(
		fromRadiant!.radiant.bans.map((row) => row.heroId),
		fromDire!.radiant.bans.map((row) => row.heroId),
		'整条归属会随先选权镜像，不能两边算出一模一样的名单',
	);
	ok('先选权决定每一手归谁，换边之后归属整体镜像');
}

{
	const empty = predictDraftLocal({ data: { ...data, heroes: [] }, firstPicker: 'radiant' });
	assert.equal(empty, null, '一个英雄都没有时返回 null，界面按"推不出来"处理');
	ok('没有英雄数据时不硬编一份预测');
}

/*
 * 熟手优先：**池子里的英雄胜率明显更差时也要先挑它**。
 *
 * 这一条是这一版的核心。先是试过给熟手加权重（0.04/0.12/0.2），结果挑选几乎不动——
 * 熟手的胜率本来就常常低于版本强势点（实测 Xm 的灰烬之灵中单 49.3%），要压过那个分差
 * 就得说"愿意让掉十个百分点以上的胜率"，站不住。所以规则改成"先挑该号位池子里最强的那个"。
 * 这里用一个胜率被刻意压到 40% 的熟手来钉住它：按胜率永远轮不到它，按规则必须选中。
 */
{
	// 胜率从 60% 一路排到 45%：池子里那几个是**最差的**，纯按胜率永远轮不到。
	const spare: DraftHero[] = Array.from({ length: 39 }, (_, index) => hero(index + 1, 0.6 - index * 0.004));
	// 这个英雄只有二号位样本，而且胜率被压到 40%：纯按胜率排，它在最后。
	const comfort: DraftHero = { ...hero(900, 0.4), positions: [null, [1000, 400], null, null, null] };
	const comfortData: DraftData = { ...data, heroes: [...spare, comfort] } as DraftData;
	/*
	 * 二号位给他放五个熟手：对面第一阶段的四手禁用会先掐掉胜率高的那四个
	 * （禁用的规则同样是"先掐对面该号位的熟手"），最差的那个才留得到挑选。
	 * 这也是真 BP 的样子——熟手是被禁掉的，不是自己不要。
	 */
	const POOL = [36, 37, 38, 39, 900];
	const profile = buildRosterProfile('Xtreme Gaming', [
		{
			nick: 'Xm',
			position: 2,
			scope: '7.41f 版本',
			heroes: [
				{ heroId: 36, games: 8, wins: 5 },
				{ heroId: 37, games: 7, wins: 4 },
				{ heroId: 38, games: 6, wins: 3 },
				{ heroId: 39, games: 6, wins: 3 },
				{ heroId: 900, games: 8, wins: 3 },
			],
		},
	]);

	const without = predictDraftLocal({ data: comfortData, firstPicker: 'radiant' });
	const with_ = predictDraftLocal({ data: comfortData, firstPicker: 'radiant', signatures: { radiant: profile, dire: null } });
	assert.ok(without && with_, '两份都要能推出来');
	const radiantPicks = (prediction: typeof without) => (prediction?.radiant.picks ?? []).map((pick) => pick.heroId);
	assert.deepEqual(radiantPicks(without).filter((id) => POOL.includes(id)), [], `没有名单时不该挑池子里那几个最差的英雄，实际：${radiantPicks(without)}`);
	const fromPool = radiantPicks(with_).filter((id) => POOL.includes(id));
	assert.ok(fromPool.length >= 1, `有天辉二号位的名单时，必须挑他池子里的熟手，实际：${radiantPicks(with_)}`);
	assert.ok(
		with_!.radiant.picks.filter((pick) => POOL.includes(pick.heroId)).every((pick) => pick.position === 2),
		'熟手要落在它的号位上',
	);
	// 夜魇没有名单，仍然按号位胜率走；这条用来确认"熟手优先"没有污染另一边。
	assert.ok(!(with_!.dire.picks ?? []).some((pick) => POOL.includes(pick.heroId)), '对面没有这份名单时不受影响');
	ok('熟手优先：池子里那几个胜率最差的英雄照样会入选，且只作用于有名单的那一边');

	/*
	 * **出手时机**：同样一份名单，如果真实 BP 说这个英雄**平均第二十手才拿**，
	 * 第一手（第 8 手）就不能是他——这正是"一选幻影长矛手"那个问题的正面回答。
	 * 数据来自 `/api/draft/foe` 那份真实 BP（`averagePickOrder`），不是估的。
	 */
	const lateForm = {
		name: 'Xtreme Gaming',
		windowDays: 30,
		matches: 18,
		decided: 16,
		wins: 9,
		heroes: [{ heroId: 900, picks: 5, decided: 5, wins: 3, bansAgainst: 1, bansBy: 0, averagePickOrder: 20 }],
	};
	const withTiming = predictDraftLocal({
		data: comfortData,
		firstPicker: 'radiant',
		signatures: { radiant: profile, dire: null },
		forms: { radiant: lateForm, dire: null },
	});
	assert.ok(withTiming, '带真实 BP 也要能推出来');
	assert.notEqual(
		withTiming!.radiant.picks[0]?.heroId,
		900,
		`平均第 20 手才拿的英雄不能放在第一手，实际第一手是 ${withTiming!.radiant.picks[0]?.heroId}`,
	);
	ok('出手时机：平均手号太靠后的英雄不会被放到第一手');
}

// ---------------------------------------------------------------- 提示词

/**
 * 禁用表的合成：**挑选用模型的、禁用用"模型的 + 站内补齐"**，永远给出每边 7 条、
 * 且与十手挑选都不冲突的合法禁用。
 *
 * 这条是拿真实 DeepSeek 回复逼出来的：它十次里十次都会写出"各队禁对面熟手、又各拿自己熟手"，
 * 于是六成左右的禁用与它自己的挑选撞车。丢弃之后一边只剩一两条，页面上的"禁用（1）"就是这么来的。
 */
{
	const bansFrom = (ids: number[], reason: string) => ids.map((heroId) => ({ heroId, reason }));
	const taken = new Set<number>([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
	// 模型给的禁用里前三条与挑选撞车，只有 1、2 能用；站内那份用来补齐。
	const result = mergeBans(
		bansFrom([6, 7, 8, 1, 2], '模型给的'),
		bansFrom([1, 2, 3, 4, 5, 16, 17, 18], '站内推的'),
		taken,
	);
	assert.equal(result.bans.length, 7, '不足 7 条要补齐');
	assert.deepEqual(result.bans.slice(0, 2).map((ban) => ban.heroId), [1, 2], '模型给的不冲突的那几条要排在前面');
	assert.equal(result.bans[2]?.reason, '站内推的', '后面的才是站内补齐的');
	assert.equal(result.filled, 5, '补了几条要数得出来');
	const ids = result.bans.map((ban) => ban.heroId);
	assert.equal(new Set(ids).size, ids.length, '禁用之间不能重复');
	assert.ok(!ids.some((id) => [6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(id)), '禁用不能与任何一方的挑选撞车');
	/*
	 * 第二次调用共用同一个 `taken`：两边的禁用也不能互相重复。
	 * 传进来的站内清单里 1、2、3 已经被占用了，要跳过去接着往下取。
	 */
	const second = mergeBans([], bansFrom([1, 2, 3, 19, 20, 21, 22, 23, 24, 25], '站内推的'), taken);
	assert.ok(!second.bans.some((ban) => ids.includes(ban.heroId)), '夜魇的禁用不能与天辉的重复');
	assert.equal(second.filled, 7, '这一边全靠补齐');
	ok('禁用合成：模型在前、站内补齐，结果合法且两边不重复');

	/*
	 * 备用禁用池要够厚：模型丢掉大半禁用之后，两边都得能补满 7 条——否则板子上会空出几格
	 * （实测截图里缺了 5 格），而真 BP 的禁用格不该有空位。
	 */
	const local = predictDraftLocal({ data, firstPicker: 'radiant' });
	assert.ok(local?.spareBans, '本地推演要攒一份备用禁用池');
	/*
	 * 这一份只有 40 个英雄，而两边共用去重集合，所以备料会比真实对局（127 个英雄）薄得多。
	 * 下限只取"够补满一边 7 条"；真正在意的是下面那条功能断言：重撞之后两边都要补得满。
	 */
	assert.ok(local!.spareBans!.radiant.length >= 7, `天辉的备料太薄（${local!.spareBans!.radiant.length} 条）`);
	assert.ok(local!.spareBans!.dire.length >= 7, `夜魇的备料太薄（${local!.spareBans!.dire.length} 条）`);

	// 模拟"模型给的禁用有一半撞车、剩下很少"：两边都要能补满 7 条。
	const taken2 = new Set<number>([...local!.radiant.picks.map((p) => p.heroId), ...local!.dire.picks.map((p) => p.heroId)]);
	const modelBans = { radiant: [{ heroId: local!.radiant.picks[0]!.heroId, reason: '撞车' }], dire: [{ heroId: local!.dire.picks[0]!.heroId, reason: '撞车' }] };
	const filledR = mergeBans(modelBans.radiant, [...local!.radiant.bans, ...local!.spareBans!.radiant], taken2);
	const filledD = mergeBans(modelBans.dire, [...local!.dire.bans, ...local!.spareBans!.dire], taken2);
	assert.equal(filledR.bans.length, 7, '天辉要能补满 7 条禁用');
	assert.equal(filledD.bans.length, 7, '夜魇要能补满 7 条禁用');
	assert.equal(new Set([...filledR.bans, ...filledD.bans].map((ban) => ban.heroId)).size, 14, '两边的禁用不能互相重复');
	ok('备用禁用池够厚：模型撞掉大半之后两边仍能补满 7 条，板子上不会空');

	/*
	 * **摆位置的两种规则不能混用。**
	 *
	 * 板子上凭空少 3 格的那次就是这么来的：模型那条路的禁用里混进了"带原手号"的站内补齐条目，
	 * 于是同一份清单里既按手号摆、又按顺序摆，前者被后者盖掉。
	 * 下面这份预测专门造出"混着手号"的形状（就是真实数据的样子），钉住 24 手一格不少。
	 */
	const radiantBans = Array.from({ length: 7 }, (_, index) => ({ heroId: 200 + index, reason: 'r' }));
	// 站内补齐的那几条带着自己的原手号（step），模型给的没有——这正是出问题的形状。
	radiantBans[3] = { ...radiantBans[3]!, step: 19 };
	radiantBans[4] = { ...radiantBans[4]!, step: 21 };
	const direBans = Array.from({ length: 7 }, (_, index) => ({ heroId: 300 + index, reason: 'r' }));
	const picks = (side: number) => Array.from({ length: 5 }, (_, index) => ({ heroId: side * 100 + index, position: index + 1, reason: 'p' }));
	const mixed = {
		radiant: { bans: radiantBans, picks: picks(4) },
		dire: { bans: direBans, picks: picks(5) },
		summary: '',
		source: 'model' as const,
		assignedSteps: true,
	};
	const mixedHands = predictionHands(mixed, 'radiant');
	assert.equal(mixedHands.length, 24, '板子永远是 24 手');
	assert.equal(mixedHands.filter((heroId) => heroId !== null).length, 24, '两边共 24 手都要落人（禁用 14 + 挑选 10）');
	assert.equal(new Set(mixedHands.filter((id): id is number => id !== null)).size, 24, '同一个英雄不能占两格');
	// 纯本地推演那条路仍然逐条信它的真手号。
	const localHands = predictionHands({ radiant: local!.radiant, dire: local!.dire, summary: '', source: 'local' }, 'radiant');
	assert.equal(localHands.filter((heroId) => heroId !== null).length, 24, '本地推演的 24 手也要一格不少');
	ok('板子摆位置：模型的清单按顺序摆、本地推演按真手号摆，两种不混用，24 格都有人');
}

{
	const signature = buildRosterProfile('Team Spirit', [
		{ nick: 'Yatoro', position: 1, scope: '7.41f 版本', heroes: [{ heroId: 41, games: 6, wins: 4 }] },
	]);
	const messages = buildPredictionMessages({
		data,
		radiantTeam: 'Team Falcons',
		direTeam: 'Team Spirit',
		firstPicker: 'dire',
		signatures: { radiant: null, dire: signature },
		forms: {
			radiant: {
				name: 'Team Falcons',
				windowDays: 30,
				matches: 18,
				decided: 18,
				wins: 11,
				heroes: [
					{ heroId: 12, picks: 5, decided: 5, wins: 2, bansAgainst: 14, bansBy: 0, averagePickOrder: 20.4 },
					{ heroId: 9, picks: 4, decided: 4, wins: 3, bansAgainst: 10, bansBy: 1, averagePickOrder: 11 },
				],
			},
			dire: null,
		},
	});
	const system = messages[0]?.content ?? '';
	const user = messages[1]?.content ?? '';
	assert.match(system, /heroId/, '系统提示词要给字段名');
	assert.match(system, /10 个挑选 \+ 14 条禁用 = 24 个 heroId，必须互不相同/, '系统提示词必须禁止同一个英雄出现两次（含禁与选之间）');
	assert.match(system, /先定禁用、再从剩下的人里定挑选/, '要写清"先禁后选"的顺序——实测只说"不能重复"模型会照错不误');
	assert.match(system, /\*\*交答案之前自查\*\*/, '要明确要求模型交卷前自查重复');
	assert.match(system, /JSON/, '系统提示词必须要求 JSON 输出');
	assert.match(system, /绝对不要编造/, '系统提示词必须禁止编数字');
	assert.match(user, /Team Falcons/, '用户提示词要带天辉队名');
	assert.match(user, /Team Spirit/, '用户提示词要带夜魇队名');
	assert.match(user, /先选方是 Team Spirit（夜魇）/, '用户提示词要说清谁先选');
	assert.match(user, /heroId=41/, '两边的名单英雄池要进提示词');
	assert.match(user, /1 号位 Yatoro/, '提示词里要写清这个号位是谁在打——不然模型没法判断"像不像他们"');
	assert.match(system, /position/, '系统提示词要要求模型给出号位');
	assert.match(system, /挑选先在那个号位的池子里挑/, '系统提示词要把"熟手优先"写成规则，否则模型会直接挑版本强势');
	assert.match(system, /他本窗口没打过它/, '池子外挑人时要求模型说清，别把它讲成他们的熟手');
	/*
	 * "别光靠算法"那一半：两队的真实 BP 要进提示词，而且要带上**平均第几手拿**与**被禁次数**
	 * ——这两样正是判断"一手抢幻影长矛手合不合理""米拉娜轮不轮得到"的依据。
	 */
	assert.match(system, /尊重出手时机与可及性/, '系统提示词要有出手时机这条规则');
	assert.match(user, /的真实 BP/, '用户提示词要带两队的真实 BP');
	assert.match(user, /平均第 20\.4 手拿/, '要把"平均第几手拿"写进去，模型才有依据拒绝一选幻影长矛手');
	assert.match(user, /对手禁他们最多/, '要把"被对面禁了多少次"写进去，判断可及性');
	assert.ok(!/api[-_ ]?key|Bearer|sk-/i.test(system + user), '提示词里不该出现任何密钥痕迹');
	ok('预测提示词带双方队名、先选方与按号位的英雄池，约束齐全');
}

// ---------------------------------------------------------------- 解析

{
	const json = {
		radiant: {
			bans: [1, 2, 3, 4, 5].map((heroId) => ({ heroId, reason: '克制我们的一号位' })),
			picks: [6, 7, 8, 9, 10].map((heroId, index) => ({ heroId, position: index + 1, reason: '补我们的前排' })),
		},
		dire: {
			bans: [11, 12, 13].map((heroId) => ({ heroId, reason: '掐你们的招牌' })),
			picks: [14, 15, 16, 17, 18].map((heroId, index) => ({ heroId, position: index + 1, reason: '我们的后手 counter' })),
		},
		summary: '两边都会先立住三号位。',
	};
	const allowed = HEROES.map((item) => item.id);
	const parsed = parsePredictionReply(`\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, allowed);
	assert.ok(parsed, '带代码块围栏的回复也要能解析');
	assert.equal(parsed!.radiant.picks.length, 5, '天辉五个挑选');
	assert.equal(parsed!.dire.picks.length, 5, '夜魇五个挑选');
	assert.deepEqual(parsed!.dire.picks.map((pick) => pick.position), [1, 2, 3, 4, 5], '号位要原样带出来，界面靠它写"这个位置上的这个人"');
	assert.equal(parsed!.dire.bans.length, 3, '禁用可以少于 7——那是模型漏写，不是错误');
	assert.equal(parsed!.summary, '两边都会先立住三号位。', '摘要原样带出来');
	ok('正常回复能解析，禁用少写几个也认，号位原样带出');
}

{
	const allowed = HEROES.map((item) => item.id);
	const picks = (ids: number[]) => ids.map((heroId, index) => ({ heroId, position: index + 1, reason: 'r' }));
	const base = {
		radiant: { bans: [{ heroId: 1, reason: 'r' }], picks: picks([6, 7, 8, 9, 10]) },
		dire: { bans: [{ heroId: 2, reason: 'r' }], picks: picks([11, 12, 13, 14, 15]) },
		summary: '',
	};

	// 两边选中同一个英雄：那条要被丢掉；丢完夜魇只剩四个挑选，整份就不算数。
	const duplicated = structuredClone(base);
	duplicated.dire.picks[0] = { heroId: 6, position: 1, reason: 'r' };
	assert.equal(parsePredictionReply(JSON.stringify(duplicated), allowed), null, '两边共用同一个英雄时必须整份丢掉');

	// 编出来的英雄：解析不过白名单，丢掉之后挑选不足五个。
	const invented = structuredClone(base);
	invented.radiant.picks[0] = { heroId: 987654, position: 1, reason: 'r' };
	assert.equal(parsePredictionReply(JSON.stringify(invented), allowed), null, '数据里没有的英雄要被丢掉，并因此判成没结果');

	// 挑选少一个就不是一局 BP 了。
	const short = structuredClone(base);
	short.dire.picks = short.dire.picks.slice(0, 4);
	assert.equal(parsePredictionReply(JSON.stringify(short), allowed), null, '每边必须给满五个挑选');

	// 两边一手禁用都没写：那等于没预测 BP。（只丢一边是允许的——冲突被丢掉时就会成这样。）
	const noBans = structuredClone(base);
	noBans.radiant.bans = [];
	noBans.dire.bans = [];
	assert.equal(parsePredictionReply(JSON.stringify(noBans), allowed), null, '两边一手禁用都不写的不算预测');

	/*
	 * 号位这一版的硬要求。两条都关系到界面能不能核对"这一手像不像他们"：
	 * 缺号位时写不出"这个位置上的这个人"；五个人挤在同一个号位则不是一局阵容。
	 */
	const noPosition = structuredClone(base);
	noPosition.radiant.picks = noPosition.radiant.picks.map((pick) => ({ heroId: pick.heroId, reason: pick.reason }));
	assert.equal(parsePredictionReply(JSON.stringify(noPosition), allowed), null, '缺号位的挑选不算数');

	const samePosition = structuredClone(base);
	samePosition.radiant.picks = samePosition.radiant.picks.map((pick) => ({ ...pick, position: 2 }));
	assert.equal(parsePredictionReply(JSON.stringify(samePosition), allowed), null, '五个挑选要占满 1 到 5，不能都算在一个号位上');

	const badPosition = structuredClone(base);
	badPosition.dire.picks[0] = { heroId: badPosition.dire.picks[0].heroId, position: 9, reason: 'r' };
	assert.equal(parsePredictionReply(JSON.stringify(badPosition), allowed), null, '号位超出 1-5 的条目不算数');

	/*
	 * 同一个英雄既被禁、又被选（模型真会这么写：一次真实的 DeepSeek 回复把米拉娜同时放进了
	 * 天辉的禁用与挑选）。**保挑选、丢禁用**——挑选是预测的主体，禁用只是背景，
	 * 而禁用本来就允许少于 7 条；反过来丢挑选会让整份预测凑不满五个挑选而作废。
	 */
	const banAndPick = structuredClone(base);
	banAndPick.radiant.bans.push({ heroId: 6, reason: 'r' });
	const salvaged = parsePredictionReply(JSON.stringify(banAndPick), allowed);
	assert.ok(salvaged, '禁选冲突不该让整份预测作废');
	assert.equal(salvaged!.radiant.picks.length, 5, '五个挑选要保住');
	assert.ok(!salvaged!.radiant.bans.some((ban) => ban.heroId === 6), '冲突的那条禁用应当被丢掉');
	assert.equal(salvaged!.droppedBans, 1, '丢掉几条要如实报出来，界面要照实说明');

	/*
	 * 真实 DeepSeek 回复里的那种形状：**两边都把对面的熟手禁了、又都把同一个英雄选走**。
	 * 挑选之间不冲突（十个挑选互不重复）时，整份要能救回来——十个挑选都保住，
	 * 冲突的禁用丢掉。这条钉住的是"不要让模型的格式小毛病毁掉整份预测"。
	 */
	const crossed = structuredClone(base);
	crossed.dire.bans = [6, 7, 8].map((heroId) => ({ heroId, reason: 'r' }));
	const rescued = parsePredictionReply(JSON.stringify(crossed), allowed);
	assert.ok(rescued, '一边禁了另一边的挑选时，要保住挑选、丢掉那条禁用');
	assert.equal(rescued!.dire.bans.length, 0, '三条都与对面的挑选冲突，应当全被丢掉');
	assert.equal(rescued!.droppedBans, 3, '丢掉三条要数得出来');
	assert.deepEqual(
		rescued!.dire.picks.map((pick) => pick.heroId),
		[11, 12, 13, 14, 15],
		'夜魇的五个挑选一个都不能少',
	);

	assert.equal(parsePredictionReply('模型今天不想说话', allowed), null, '不是 JSON 的回复要判成没结果');
	assert.equal(parsePredictionReply('', allowed), null, '空回复要判成没结果');
	ok('重复、编造、缺挑选、没禁用、号位缺失或重复的回复一律判成"这次没结果"');

	/*
	 * **失败要说出原因**：页面以前只写一句"解析不了"，用户没法判断该重试、该换模型，
	 * 还是该等我们改提示词。实测这件事是间歇的——同一提示词上一把通过、这一把被拒。
	 * 所以每种失败都要带一句能读懂的说明，并且指到具体哪一边、哪几条。
	 */
	const named = (raw: unknown) => {
		const result = parsePredictionReplyDetailed(JSON.stringify(raw), allowed);
		return result.ok ? '' : result.reason;
	};
	assert.match(named(noPosition), /天辉的挑选凑不满五个/, '缺号位要指到具体那一边');
	assert.match(named(invented), /英雄不在我们的数据里/, '编出来的英雄要说清是哪一类问题');
	assert.match(named(samePosition), /号位没有占满 1 到 5/, '号位重复要说清是号位的问题');
	assert.match(named(noBans), /一条禁用都没给/, '没禁用要说清');
	assert.equal(named(base), '', '合格的回复不该带原因');
	const prose = parsePredictionReplyDetailed('模型今天不想说话', allowed);
	assert.ok(!prose.ok && /找不到 JSON/.test(prose.reason), '不是 JSON 也要说清');
	ok('解析失败给出可读的原因，并指到具体哪一边、哪一类问题');
}

console.log(`draftPredict 全部断言通过（${cases} 组）`);
