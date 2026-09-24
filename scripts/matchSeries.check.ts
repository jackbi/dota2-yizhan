import assert from 'node:assert/strict';
import {
	SERIES_WINDOW_SECONDS,
	byStartTime,
	coversBothTeams,
	seriesNearAnchor,
	toGames,
	winnerSide,
	type Candidate,
	type NormalizedDraft,
} from '../src/lib/matchSeries.ts';
import type { HeroInfo } from '../src/lib/opendota.ts';

/**
 * 对阵页"按小局"拆分逻辑的自检。
 *
 * 日历上的一条是系列（BO3/BO5），Valve 的每个比赛 id 只对应其中一局。这里钉的是四处
 * 错了不会报错、只会安静地展示错数据的地方：
 *
 * 1. 小局顺序——STRATZ 的 `series.matches` 是倒序返回的（实测两局的系列里，后打的那局
 *    排在前面），直接照用会让页面上的"第 1 局"变成决胜局；
 * 2. 局号来源——局号按系列的权威位次给。中间某局取不到明细时要跳过那一局，但后面几局的
 *    局号不能往前顶，否则读者又会分不清自己看的是哪一局；
 * 3. 主客队对齐——天辉/夜魇与主客队无关，日历上的主队完全可能在夜魇，所以"天辉赢了"
 *    要先换算成"主队赢了"，否则每局胜者会和大比分互相矛盾；
 * 4. 系列的边界——拿不到 STRATZ 的系列关系时只能按时间圈，圈太宽会把同一对队伍同一天
 *    的两轮比赛（小组赛 + 淘汰赛）并成一个系列。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/matchSeries.check.ts`）。
 */

// 顺序：连着两局的系列，上游给的是 [第二局, 第一局]。
const series = [
	{ id: 2, startTime: 1_700_003_600 },
	{ id: 1, startTime: 1_700_000_000 },
];
assert.deepEqual(byStartTime(series).map((game) => game.id), [1, 2], '小局要按开始时间正序，不能照搬上游顺序');
assert.deepEqual(series.map((game) => game.id), [2, 1], '排序不应就地改写入参');

// 主客队对齐：主队在夜魇时，天辉赢就是客队赢。
assert.equal(winnerSide(true, true), 'home', '主队在天辉且天辉赢 → 主队胜');
assert.equal(winnerSide(false, true), 'away', '主队在天辉但天辉输 → 客队胜');
assert.equal(winnerSide(true, false), 'away', '主队在夜魇且天辉赢 → 客队胜');
assert.equal(winnerSide(false, false), 'home', '主队在夜魇且天辉输 → 主队胜');
assert.equal(winnerSide(null, true), null, '未解析的局没有胜者，不能默认判给主队');

// 队伍核对：两个 id 都要对上，缺 id 一律不算。
assert.equal(coversBothTeams({ radiantTeamId: 10, direTeamId: 20 }, 10, 20), true, '主客队恰好是天辉与夜魇');
assert.equal(coversBothTeams({ radiantTeamId: 20, direTeamId: 10 }, 10, 20), true, '主客队与天辉/夜魇相反也要认');
assert.equal(coversBothTeams({ radiantTeamId: 10, direTeamId: 30 }, 10, 20), false, '对手对不上就不是这一场');
assert.equal(coversBothTeams({ radiantTeamId: 10, direTeamId: null }, 10, 20), false, '缺一侧 id 不能算命中');
assert.equal(coversBothTeams({ radiantTeamId: 10, direTeamId: 10 }, 10, 20), false, '同一支队伍出现两次不能凑数');

// 系列兜底窗口：只圈锚点前后 6 小时，当天的另一轮不能被卷进来。
const anchor: Candidate = { id: 100, startTime: 1_700_000_000, delta: 0 };
const candidates: Candidate[] = [
	{ id: 101, startTime: anchor.startTime + 3900, delta: 3900 },
	{ id: 102, startTime: anchor.startTime + 2 * 3600, delta: 2 * 3600 },
	{ id: 200, startTime: anchor.startTime - 11 * 3600, delta: 11 * 3600 },
	{ id: 300, startTime: anchor.startTime + 7 * 3600, delta: 7 * 3600 },
];
const nearIds = seriesNearAnchor(candidates, anchor)
	.map((candidate) => candidate.id)
	.sort((a, b) => a - b);
assert.deepEqual(nearIds, [100, 101, 102], '只圈兜底窗口内的小局，锚点自己始终在内');
assert.deepEqual(
	seriesNearAnchor(candidates, anchor, 0).map((candidate) => candidate.id),
	[100],
	'窗口收到 0 时只剩锚点自己',
);
assert.equal(SERIES_WINDOW_SECONDS, 6 * 3600, '兜底窗口是 6 小时，再宽就会把当天的两轮并成一个系列');

// 逐局投影：这一局主队在夜魇（radiantTeamId 是客队），BP 与选手都得按队伍而不是按阵营归类。
const heroes = new Map<number, HeroInfo>([
	[1, { name: '莉娜', img: '/lina.png' }],
	[2, { name: '影魔', img: '/sf.png' }],
]);
const homeTeamId = 10;
const homeIsDire: NormalizedDraft = {
	matchId: 900,
	startTime: 1_700_000_000,
	duration: 1879,
	// 天辉赢了，而主队在夜魇 → 这局算客队胜。
	radiantWin: true,
	radiantTeamId: 20,
	direTeamId: 10,
	source: 'stratz',
	picksBans: [
		// 莉娜是天辉（客队）的，影魔是夜魇（主队）的
		{ heroId: 1, isPick: true, order: 3, isRadiant: true },
		{ heroId: 2, isPick: true, order: 1, isRadiant: false },
	],
	players: [
		{ heroId: 2, name: '主队选手', isRadiant: false, kills: 9, deaths: 4, assists: 2 },
		{ heroId: 1, name: '客队选手', isRadiant: true, kills: 3, deaths: 6, assists: 5 },
	],
};

const [homeIsDireGame] = toGames([{ id: 900 }], new Map([[900, homeIsDire]]), homeTeamId, heroes);
assert.ok(homeIsDireGame, '有 BP 与选手的局应当产出数据');
assert.equal(homeIsDireGame.ordinal, 1, '系列的第一局编号是 1');
assert.equal(homeIsDireGame.winner, 'away', '主队在夜魇而天辉赢 → 客队胜');
assert.equal(homeIsDireGame.duration, 1879, '时长按秒透传，页面自己换算');
assert.deepEqual(homeIsDireGame.picks.map((hero) => [hero.name, hero.team]), [['影魔', 0], ['莉娜', 1]], 'BP 先按手号排序，再按主客队标 0 / 1');
assert.deepEqual(homeIsDireGame.players.map((player) => [player.name, player.home]), [['主队选手', true], ['客队选手', false]], '选手的 home 只看是不是主队，不看天辉夜魇');

// 同一份 BP 换成主队在天辉：归属整体翻到另一侧。
const [homeIsRadiantGame] = toGames(
	[{ id: 900 }],
	new Map([[900, { ...homeIsDire, radiantTeamId: homeTeamId, direTeamId: 20 }]]),
	homeTeamId,
	heroes,
);
assert.equal(homeIsRadiantGame?.winner, 'home', '主队在天辉且天辉赢 → 主队胜');
assert.deepEqual(homeIsRadiantGame?.picks.map((hero) => [hero.name, hero.team]), [['影魔', 1], ['莉娜', 0]], '主队在天辉时莉娜才是主队的');

// 没有 BP 也没有选手的局不占页面位置（例如 STRATZ 只回了个空壳）。
assert.deepEqual(
	toGames([{ id: 900 }], new Map([[900, { ...homeIsDire, picksBans: [], players: [] }]]), homeTeamId, heroes),
	[],
	'空局应当直接丢掉',
);

// 英雄 id 不在站内映射里时用占位名，不能漏出 undefined。
const unknownHero = toGames(
	[{ id: 900 }],
	new Map([[900, { ...homeIsDire, picksBans: [{ heroId: 999, isPick: true, order: 1, isRadiant: false }], players: [] }]]),
	homeTeamId,
	heroes,
);
assert.deepEqual(unknownHero[0]?.picks.map((hero) => hero.name), ['英雄 #999'], '未知英雄要给可读的占位名');

// 局号按系列的位次给：中间那局取不到明细时跳过它，但第 3 局仍然叫「第 3 局」。
const middleMissing = new Map<number, NormalizedDraft>([
	[900, homeIsDire],
	[902, { ...homeIsDire, matchId: 902, startTime: homeIsDire.startTime + 7200 }],
]);
const numbered = toGames([{ id: 900 }, { id: 901 }, { id: 902 }], middleMissing, homeTeamId, heroes);
assert.deepEqual(numbered.map((game) => game.ordinal), [1, 3], '缺第 2 局时，后面那局的编号要留在原位');
assert.deepEqual(numbered.map((game) => game.matchId), [900, 902], '缺明细的局不占页面位置');

console.log('matchSeries 全部断言通过');
