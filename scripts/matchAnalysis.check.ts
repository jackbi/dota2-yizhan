import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { HeroRef, ItemRef } from '../src/lib/gameRefs.ts';
import { buildAnalysisInput, type MatchAnalysisInput } from '../src/lib/matchAnalysis.ts';
import { ANALYSIS_MAX_TOKENS, buildAnalysisMessages, parseAnalysisReply } from '../src/lib/matchAnalysisPrompt.ts';
import type { MatchReview, ReviewPlayer } from '../src/lib/matchReview.ts';
import type { WardSummary } from '../src/lib/wardStats.ts';

/**
 * 赛后分析的自检。
 *
 * 这里不联网、也不判断"分析得好不好"（那要靠人看比赛）。它盯的是三类**会静默出错**的地方：
 *
 * 1. 摘要里的数字口径：峰谷选错、曲线被重复塞点、建筑分类认错 npcId——页面照常渲染，
 *    只是模型读到的是错的；
 * 2. 提示词漏约束：少一句"只能引用给定数字"，模型就会开始回忆版本强弱，而输出从外表看完全正常；
 * 3. 页面对账：复盘页有没有真的挂上面板、脚本找的 id 面板上有没有、别处的入口有没有指到 `#ai`。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/matchAnalysis.check.ts`）。
 */

const heroes = new Map<number, HeroRef>([
	[1, { id: 1, name: '敌法师', img: '', attr: 'AGI' }],
	[2, { id: 2, name: '帕克', img: '', attr: 'INT' }],
]);
const items = new Map<number, ItemRef>([[1, { id: 1, name: '狂战斧', img: '', cost: 0 }]]);

const heroName = (heroId: number): string => heroes.get(heroId)?.name ?? `英雄 #${heroId}`;

function player(over: Partial<ReviewPlayer> & { heroId: number; isRadiant: boolean; networth: number }): ReviewPlayer {
	return {
		accountId: null,
		name: `${heroName(over.heroId)}本人`,
		slot: null,
		kills: 5,
		deaths: 3,
		assists: 7,
		level: 20,
		gpm: 500,
		xpm: 600,
		lastHits: 200,
		denies: 10,
		heroDamage: 20000,
		towerDamage: 4000,
		heroHealing: 0,
		imp: 1.5,
		items: [1, null, null, null, null, null],
		backpack: [null, null, null],
		neutral: null,
		...over,
	};
}

const wards: WardSummary = {
	sides: [
		{ placed: 20, observer: 15, sentry: 5, taken: 4, lost: 2, expired: 9 },
		{ placed: 18, observer: 12, sentry: 6, taken: 2, lost: 4, expired: 8 },
	],
	rows: [],
	unknown: 0,
};

/** 一份 12 分钟的合成对局：曲线前段天辉领先、第 8 分钟被反超，最后又赢回来。 */
const review: MatchReview = {
	matchId: 9012488967,
	startTime: 1_700_000_000,
	durationSeconds: 2130,
	radiantWin: true,
	radiantName: 'Team XG',
	direName: 'Team Spirit',
	firstBloodTime: 65,
	lanes: { top: 'RADIANT_STOMP', mid: 'TIE', bottom: 'DIRE_STOMP' },
	towersAlive: { radiant: 9, dire: 3 },
	barracksAlive: { radiant: 6, dire: 0 },
	minutes: Array.from({ length: 13 }, (_, minute) => ({
		minute,
		// 第 8 分钟被反超，第 10 分钟一波打回来。
		networthLead: minute < 8 ? 2000 : minute < 10 ? -1000 * (minute - 7) : 6000 * (minute - 9),
		experienceLead: (minute < 8 ? 2000 : 5000) * 1,
		winRate: minute === 0 ? null : 0.5,
	})),
	falls: [
		{ time: 600, npcId: 26, label: '夜魇上路一塔', side: 1, attackerHeroId: 1 },
		{ time: 900, npcId: 38, label: '天辉上路兵营', side: 0, attackerHeroId: 2 },
		{ time: 1200, npcId: 50, label: '天辉王座', side: 0, attackerHeroId: null },
	],
	players: [
		player({ heroId: 1, isRadiant: true, networth: 21300 }),
		player({ heroId: 2, isRadiant: false, networth: 12000, imp: null }),
	],
	wards,
	didRequestDownload: true,
};

// ---------------------------------------------------------------- 摘要

const input = buildAnalysisInput(review, heroes, items);
assert.equal(input.radiantName, 'Team XG');
assert.equal(input.winner, '天辉');
assert.equal(input.lanes[0]?.outcome, '天辉碾压', '三路结果要翻成中文');
assert.equal(input.lanes[1]?.outcome, '均势');

// 建筑要按 npcId 分回塔与兵营：基地塔（这里是王座 50）既不算塔也不算兵营。
const radiant = input.buildings.find((side) => side.side === '天辉')!;
const dire = input.buildings.find((side) => side.side === '夜魇')!;
assert.equal(radiant.towersFallen, 0, '王座不算塔');
assert.equal(radiant.barracksFallen, 1, '38 是天辉上路兵营');
assert.equal(dire.towersFallen, 1, '26 是夜魇上路一塔');
assert.equal(dire.towersTotal, 11, '总数口径与复盘面板一致');
assert.equal(dire.barracksTotal, 6);

// 曲线：每 5 分钟一点 + 末点；峰谷与最大单分钟变化要指对分钟。
const curve = input.curve!;
assert.deepEqual(
	curve.timeline.map((point) => point.minute),
	[0, 5, 10, 12],
	'曲线按 5 分钟采样并补上末点',
);
assert.equal(curve.peak.minute, 12, '天辉最大领先在最后一分钟');
assert.equal(curve.trough.minute, 9, '天辉最落后在第 9 分钟');
assert.equal(curve.swing?.minute, 10, '单分钟最大变化是第 10 分钟那一跳');
assert.ok((curve.swing?.delta ?? 0) > 0, '正数表示天辉这一分钟拉开');

// 装备要换成名字，空格丢掉。
assert.deepEqual(input.players[0]?.items, ['狂战斧']);
assert.equal(input.players[1]?.imp, null, 'IMP 缺值保持 null，不要填 0');

// 这一份要能内联进 <script>：不能出现 undefined / NaN，parse 回来要一模一样。
const json = JSON.stringify(input);
assert.ok(!/undefined|NaN/.test(json), `摘要里不许出现 undefined/NaN：${json.slice(0, 120)}`);
assert.deepEqual(JSON.parse(json), input, '内联 JSON 必须能原样解析回来');

// 空曲线的对局（未解析）：curve 为 null，但不该抛。
const bare = buildAnalysisInput({ ...review, minutes: [], wards: null, falls: [] }, heroes, items);
assert.equal(bare.curve, null, '没有逐分钟数据时曲线为空');
assert.equal(bare.wards, null);
assert.equal(bare.falls.length, 0);

// ---------------------------------------------------------------- 提示词

const messages = buildAnalysisMessages(input);
assert.equal(messages.length, 2, '一条 system、一条 user');
const [system, user] = messages;
assert.match(system!.content, /已经打完/, '要说明这是赛后复盘，不是预测');
assert.match(system!.content, /绝对不要编造数字/, '禁止编数字这条是硬约束');
assert.match(system!.content, /胜方靠什么赢/, '要分别回答胜因、败因与翻盘路径');
assert.match(system!.content, /负方要怎么打才有机会赢/);
assert.match(system!.content, /JSON/, '输出必须是 JSON');
assert.match(system!.content, /视野/, '视野是要求覆盖的角度之一');

assert.match(user!.content, /Team XG/, '要带上两队队名，人称才不会翻');
assert.match(user!.content, /Team Spirit/);
assert.match(user!.content, /天辉获胜/, '结果要写清谁赢');
assert.match(user!.content, /21,300/, '经济要带千分位，量级才读得出来');
assert.match(user!.content, /狂战斧/, '装备要给名字，模型不认识 id');
assert.match(user!.content, /第|分钟/, '曲线要带分钟数');
assert.match(user!.content, /插眼/, '有眼位数据时要给出这一段');
assert.ok(!/undefined|NaN/.test(user!.content), '提示词里不许出现 undefined/NaN');

// 没有曲线 / 眼位时，那两块整段不出现，且要有说清限制的句子——不给模型留空位。
const bareMessages = buildAnalysisMessages(bare);
const bareUser = bareMessages[1]!.content;
assert.doesNotMatch(bareUser, /插眼/, '没有眼位数据时不许出现视野那一块');
assert.doesNotMatch(bareUser, /天辉最大领先/, '没有曲线时不许出现峰谷那两行');
assert.match(bareUser, /没有逐分钟曲线|没有眼位数据/, '缺哪一块要明说，别让模型自己补');
assert.ok(ANALYSIS_MAX_TOKENS >= 1400, '整局分析要写三大段，上限不能比阵容复盘还小');

// ---------------------------------------------------------------- 回复解析

const good = parseAnalysisReply(
	'{"headline":"XG 靠前中期","winnerWhy":["三路对线占优"],"loserWhy":["视野被压"],"pathToWin":["拖到后期"],"dimensions":[{"dimension":"对线","text":"上路碾压"}]}',
);
assert.equal(good?.headline, 'XG 靠前中期');
assert.equal(good?.winnerWhy.length, 1);
assert.equal(good?.dimensions[0]?.dimension, '对线');

// 带代码块围栏要能读出来；只有一段正文也要保留。
assert.equal(parseAnalysisReply('```json\n{"headline":"x","winnerWhy":["a"]}\n```')?.winnerWhy[0], 'a');
// 坏 JSON、不是 JSON、全空，都当这次没结果。
assert.equal(parseAnalysisReply('```json\n{"headline":\n```'), null, '坏 JSON 要当没结果');
assert.equal(parseAnalysisReply('抱歉，我想不出来'), null, '不是 JSON 就丢掉');
assert.equal(parseAnalysisReply('{}'), null, '全空当没结果');
assert.equal(parseAnalysisReply('{"headline":"","winnerWhy":[],"loserWhy":[],"pathToWin":[],"dimensions":[]}'), null, '四段全空当没结果');

// ---------------------------------------------------------------- 页面对账

const replayPage = readFileSync(new URL('../src/pages/replay/[id].astro', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/components/player/MatchAnalysis.astro', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/scripts/matchAnalysis.ts', import.meta.url), 'utf8');

assert.match(replayPage, /import MatchAnalysis from/, '复盘页要引入 AI 分析面板');
assert.match(replayPage, /<MatchAnalysis review=\{[^}]+\} heroes=\{[^}]+\} items=\{[^}]+\} \/>/, '复盘页要渲染面板');
assert.match(panel, /id="ai"/, '面板要带 #ai 锚点，别处的入口才能跳过来');
assert.match(panel, /inlineJson\(data\)/, '摘要要内联进页面，别让浏览器再取一份');
assert.match(panel, /href="\/settings\/"/, '没配模型时要能给出去设置页的路');

const panelIds = new Set([...panel.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const queriedIds = new Set([...script.matchAll(/element<[^>]*>\('([^']+)'\)/g)].map((match) => match[1]));
assert.ok(queriedIds.size >= 3, `只从脚本里解析出 ${queriedIds.size} 个 id，解析多半坏了`);
for (const id of queriedIds) {
	assert.ok(panelIds.has(id), `脚本在找 #${id}，但 MatchAnalysis.astro 里没有这个 id`);
}

// 两个入口都要指到复盘页的 #ai，而不是各自的第二份渲染。
for (const [file, label] of [
	['../src/pages/me/matches/[id].astro', '个人对局页'],
	['../src/pages/matches/[id].astro', '赛事对局页'],
] as const) {
	const page = readFileSync(new URL(file, import.meta.url), 'utf8');
	assert.match(page, /\/replay\/\$\{[^}]+\}#ai/, `${label}要有指向 #ai 的入口`);
	assert.ok(page.includes('AI 赛后分析'), `${label}的入口文案要写「AI 赛后分析」`);
}

console.log('matchAnalysis 全部断言通过');
