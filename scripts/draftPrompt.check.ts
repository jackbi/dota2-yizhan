import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { advise } from '../src/lib/draftScore.ts';
import {
	ADVICE_TARGET_COUNT,
	buildAdviceMessages,
	buildChatRequest,
	buildSystemPrompt,
	parseAdviceReply,
} from '../src/lib/draftPrompt.ts';

/**
 * 提示词与回复解析的自检。
 *
 * 这里不联网、也不判断"建议好不好"（那要靠人看比赛回放）。它盯的是两类会静默出错的点：
 *
 * 1. **提示词漏了约束**：少一条"只能引用给定数据"，模型就会开始回忆版本强弱，而输出从外表看
 *    完全正常。所以系统提示词里那几条硬约束必须被断言盯住。
 * 2. **解析太宽松**：模型偶尔会吐出一个候选之外的英雄，或者只给半截 JSON。放进来一条
 *    编出来的英雄，比什么都不显示还糟。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftPrompt.check.ts`）。
 */

function hero(id: number, name: string, rates: (number | null)[]): DraftHero {
	return {
		id,
		name,
		nameEn: `Hero${id}`,
		attr: 'UNI',
		img: '',
		positions: rates.map((rate) => (rate === null ? null : [1000, Math.round(rate * 1000)])),
		pro: [10, 5, 8],
		roles: [0, 0, 0, 0, 0, 0, 0, 0, 0],
		summon: false,
		aoe: false,
		teamfight: false,
		attack: 'melee',
		timeline: [0, 0],
	};
}

const data: DraftData = {
	updatedAt: '2026-09-17T00:00:00.000Z',
	bracketLabel: '超凡入圣及以上',
	windowDays: 7,
	patch: { version: '7.41f', date: '2026-09-15', straddles: false },
	minPositionMatches: 200,
	heroes: [
		hero(1, '敌法师', [0.52, null, null, null, null]),
		hero(2, '帕克', [null, 0.51, null, null, null]),
		hero(3, '马格纳斯', [null, null, 0.55, null, null]),
		hero(4, '大地之灵', [null, null, null, 0.54, null]),
		hero(5, '水晶室女', [null, null, null, null, 0.53]),
	],
	proSample: { picks: 620, bans: 532 },
	matchups: {},
	matchupPairs: 0,
	hasPositionData: true,
	hasProData: true,
};

const started = advise({ data, recorded: [], ourSide: 'radiant', firstPicker: 'radiant' });
assert.ok(started, '需要一份可用的建议作为输入');

const messages = buildAdviceMessages({
	advice: started,
	data,
	selfTeam: 'Team XG',
	foeTeam: 'Team Spirit',
	recorded: [],
	ourSide: 'radiant',
	firstPicker: 'radiant',
});

// ---------------------------------------------------------------- 系统提示词

const system = buildSystemPrompt();
assert.match(system, /只能从/, '系统提示词必须限制候选范围');
assert.match(system, /绝对不要编造/, '系统提示词必须禁止编数字');
assert.match(system, /对位胜率/, '允许引用的字段里要包含对位胜率，否则模型不敢用它');
assert.match(system, /JSON/, '系统提示词必须要求 JSON 输出');
assert.match(system, /heroId/, '系统提示词要给出输出的字段名');
assert.equal(messages[0]?.role, 'system');
assert.equal(messages[1]?.role, 'user');
assert.ok(!/api[-_ ]?key|Bearer|sk-/i.test(system + messages[1]?.content), '提示词里不该出现任何密钥痕迹');

// ---------------------------------------------------------------- 用户提示词

const user = messages[1]?.content ?? '';
assert.match(user, /Team XG vs Team Spirit/, '用户提示词要带双方队名');
assert.match(user, /第 1 手/, '要说清现在第几手');
assert.match(user, /最后一手/, '要说清最后一手归谁');
assert.match(user, /超凡入圣及以上/, '要带上号位胜率的口径');
assert.match(user, /版本 7\.41f（2026-09-15 发布）/, '要带上这批数据对应的游戏版本');
assert.ok(!user.includes('跨了这次版本更新'), '没跨版本时不要吓唬模型');
for (const candidate of started.candidates) {
	assert.ok(user.includes(`heroId=${candidate.heroId}`), `候选 ${candidate.heroId} 必须出现在提示词里`);
}
for (const candidate of started.candidates) {
	assert.ok(user.includes(candidate.risk), `候选 ${candidate.heroId} 的风险要一起给模型`);
}
assert.ok(!user.includes('undefined'), '提示词里出现了 undefined，说明有字段没取到');
assert.ok(!user.includes('NaN'), '提示词里出现了 NaN');

// 样本跨版本时必须说明白：否则模型会把新旧混算的胜率当成"当前版本共识"。
const straddling = buildAdviceMessages({
	advice: started,
	data: { ...data, patch: { version: '7.41f', date: '2026-09-15', straddles: true } },
	selfTeam: 'Team XG',
	foeTeam: 'Team Spirit',
	recorded: [],
	ourSide: 'radiant',
	firstPicker: 'radiant',
});
assert.match(straddling[1]?.content ?? '', /跨了这次版本更新/, '跨版本时提示词里要有这条提醒');

// 替对面落子：提示词要交代人称（数据是从它的角度算的），并且只要一个决定。
const asOpponent = buildAdviceMessages(
	{
		advice: started,
		data,
		selfTeam: 'Team Spirit',
		foeTeam: 'Team XG',
		recorded: [],
		ourSide: 'dire',
		firstPicker: 'radiant',
	},
	'theirs',
);
const opponentSystem = asOpponent[0]?.content ?? '';
const opponentUser = asOpponent[1]?.content ?? '';
assert.match(opponentSystem, /代表对面/, '对手模式下要说明它代表对面');
assert.match(opponentSystem, /只从用户给出的候选里挑 1 个/, '对手模式只要一个决定');
assert.ok(!opponentSystem.includes('挑 3 个'), '对手模式不该要三个候选');
assert.match(opponentSystem, /第二人称/, '理由要用第二人称写，界面上才读得通');
assert.match(opponentUser, /文中的"我方"指你自己/, '对手模式要交代人称，免得它把两方搞反');
assert.match(opponentUser, /Team Spirit/, '对手模式下队名按它的视角写');

// ---------------------------------------------------------------- 请求体

/**
 * 关掉思考这条是实测出来的，不是可选项：默认开着的时候模型把 token 上限全用在
 * `reasoning_tokens` 上，`content` 是空的（900 与 4000 都试过），页面上表现为"点了没结果"。
 */
const request = buildChatRequest({ model: 'deepseek-flash', messages });
assert.deepEqual(request.thinking, { type: 'disabled' }, '必须显式关掉思考，否则回复只有思考没有正文');
assert.deepEqual(request.response_format, { type: 'json_object' }, '默认要求 JSON 输出');
assert.equal(request.model, 'deepseek-flash');
assert.equal(request.max_tokens, 900);
assert.ok(Array.isArray(request.messages) && request.messages.length === 2, '请求里要带上两条消息');

// 被 400 拒掉时可以退一步：去掉 response_format，其它参数不变。
const withoutJson = buildChatRequest({ model: 'deepseek-flash', messages, jsonMode: false });
assert.equal('response_format' in withoutJson, false, 'jsonMode 为假时不应带 response_format');
assert.deepEqual(withoutJson.thinking, { type: 'disabled' }, '去掉 JSON 模式也要保持关闭思考');

// ---------------------------------------------------------------- 回复解析

const allowed = started.candidates.map((candidate) => candidate.heroId);
const good = parseAdviceReply(
	`\`\`\`json\n{"picks":[{"heroId":${allowed[0]},"position":1,"reason":"一号位胜率 52.0%","risk":"样本偏少"}],"summary":"先拿一号位"}\n\`\`\``,
	allowed,
);
assert.ok(good, '带代码块围栏的正常回复要能解析');
assert.equal(good.picks.length, 1);
assert.equal(good.picks[0]?.heroId, allowed[0]);
assert.equal(good.summary, '先拿一号位');

// 候选之外的英雄必须被丢掉：模型偶尔会"想起"一个我们没给的英雄。
const foreign = parseAdviceReply(`{"picks":[{"heroId":9999,"position":1,"reason":"很强","risk":""}],"summary":"x"}`, allowed);
assert.equal(foreign, null, '候选之外的 heroId 不应被接受');

// 混着来的情况：只保留合法的那条。
const mixed = parseAdviceReply(
	`{"picks":[{"heroId":9999,"position":1,"reason":"编的","risk":""},{"heroId":${allowed[0]},"position":2,"reason":"二号位","risk":""}],"summary":"x"}`,
	allowed,
);
assert.ok(mixed);
assert.deepEqual(mixed.picks.map((pick) => pick.heroId), [allowed[0]], '非法的候选要被丢掉，合法的留下');

// 坏输入一律返回 null，不给上层留半截结果。
for (const bad of ['', '抱歉，我需要更多信息', '{"picks":[]}', '{"picks":[{"heroId":1}]}', '{"picks":"不是数组"}', '{坏 JSON}']) {
	assert.equal(parseAdviceReply(bad, allowed), null, `这类回复应判为无效：${bad.slice(0, 20)}`);
}

// 号位越界也要丢。
assert.equal(parseAdviceReply(`{"picks":[{"heroId":${allowed[0]},"position":9,"reason":"x","risk":""}]}`, allowed), null);

// 条数封顶。
const many = parseAdviceReply(
	`{"picks":${JSON.stringify(
		Array.from({ length: 6 }, (_, index) => ({ heroId: allowed[index % allowed.length], position: 1, reason: `理由${index}`, risk: '' })),
	)}}`,
	allowed,
);
assert.ok(many);
assert.equal(many.picks.length, ADVICE_TARGET_COUNT, `最多保留 ${ADVICE_TARGET_COUNT} 条`);

console.log('draftPrompt 全部断言通过');
