import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { predictDraftLocal } from '../src/lib/draftPredict.ts';
import { buildPredictionMessages, parsePredictionReply } from '../src/lib/draftPrompt.ts';
import { FAMILIARITY_WEIGHT, buildRosterProfile } from '../src/lib/teamSignature.ts';

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
}

// ---------------------------------------------------------------- 提示词

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
	});
	const system = messages[0]?.content ?? '';
	const user = messages[1]?.content ?? '';
	assert.match(system, /heroId/, '系统提示词要给字段名');
	assert.match(system, /不能重复/, '系统提示词必须禁止两边选同一个英雄');
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

	// 一手禁用都没写：那等于没预测 BP。
	const noBans = structuredClone(base);
	noBans.radiant.bans = [];
	assert.equal(parsePredictionReply(JSON.stringify(noBans), allowed), null, '一手禁用都不写的不算预测');

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

	assert.equal(parsePredictionReply('模型今天不想说话', allowed), null, '不是 JSON 的回复要判成没结果');
	assert.equal(parsePredictionReply('', allowed), null, '空回复要判成没结果');
	ok('重复、编造、缺挑选、没禁用、号位缺失或重复的回复一律判成"这次没结果"');
}

console.log(`draftPredict 全部断言通过（${cases} 组）`);
