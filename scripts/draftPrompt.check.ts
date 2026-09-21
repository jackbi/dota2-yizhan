import assert from 'node:assert/strict';
import type { DraftData, DraftHero } from '../src/lib/draftData.ts';
import { advise } from '../src/lib/draftScore.ts';
import {
	ADVICE_TARGET_COUNT,
	buildAdviceMessages,
	buildChatRequest,
	buildSystemPrompt,
	buildVerdictMessages,
	parseAdviceReply,
	parseVerdictReply,
} from '../src/lib/draftPrompt.ts';
import { buildVerdict } from '../src/lib/draftVerdict.ts';

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
	matchupMinGames: 200,
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

/**
 * 对面近期的英雄偏好：这是**唯一**来自「这支队」而不是「全服」的依据，
 * 所以三件事都要盯住——有数据时必须出现、没有数据时整段不出现（不给模型留空位去编）、
 * 以及英雄列表本身要带上场次与胜率。
 */
{
	const foeForm = {
		name: 'Team Spirit',
		windowDays: 30,
		matches: 12,
		decided: 10,
		wins: 6,
		heroes: [{ heroId: 3, picks: 8, decided: 6, wins: 5, bansAgainst: 4 }],
	};
	const shared = { data, advice: started, selfTeam: 'Team XG', foeTeam: 'Team Spirit', recorded: [], ourSide: 'radiant' as const, firstPicker: 'radiant' as const };

	const [foeSystem, foeUser] = buildAdviceMessages({ ...shared, foeForm }, 'ours');
	assert.match(foeSystem.content, /对面近期比赛记录/, '系统提示词要说清对面有近期记录时怎么用');
	assert.match(foeUser.content, /对面（Team Spirit）近期爱用（近 30 天 12 场，6 胜 4 负）/, '要带上对面的场次与胜负');
	assert.match(foeUser.content, /英雄 #?3|马格纳斯/, '要把英雄名列出来');
	assert.match(foeUser.content, /8 场（5 胜 1 负，胜率 83\.3%）/, '要给场次与胜率');
	assert.match(foeUser.content, /对手禁过它 4 次/, '被禁次数也要给');

	const [, plainUser] = buildAdviceMessages({ ...shared, foeForm: null }, 'ours');
	assert.ok(!plainUser.content.includes('近期爱用'), '没有对面数据时不该出现这一段');

	const [themSystem, themUser] = buildAdviceMessages({ ...shared, foeForm }, 'theirs');
	assert.match(themUser.content, /你自己近期爱用/, '替对面落子时同一份数据要说成"你自己"');
	assert.match(themSystem.content, /你自己近期爱用/, '对手模式也要交代这条规则');
	console.log('  ✓ 对面近期偏好：有数据才出现，人称随视角翻，数字齐全');
}

/**
 * 「对面擅长」那一栏单独给候补席位，而不是并进号位胜率的排序里：
 * 对面拿手的英雄常常排不进前几名，但它恰恰是这一手最该禁的对象。
 */
{
	const foeForm = {
		name: 'Team Spirit',
		windowDays: 30,
		matches: 12,
		decided: 10,
		wins: 6,
		heroes: [{ heroId: 3, picks: 8, decided: 6, wins: 5, bansAgainst: 4 }],
	};
	const narrowed = advise({ data, recorded: [], ourSide: 'radiant', firstPicker: 'radiant', limit: 2, foeForm });
	assert.ok(narrowed, '需要一份可用的建议');
	const seat = [...narrowed.candidates, ...narrowed.foeCandidates].find((candidate) => candidate.heroId === 3);
	assert.ok(seat, '对面常拿的英雄必须能在候选里被挑到，否则模型没机会禁它');
	assert.match(seat.reasons.join(' '), /对面（Team Spirit）近 30 天拿了 8 场/, '依据里要写清是这支队的场次');
	assert.ok(
		narrowed.foeCandidates.every((foe) => !narrowed.candidates.some((candidate) => candidate.heroId === foe.heroId)),
		'两栏不能出现同一个英雄',
	);
	console.log('  ✓ 对面擅长单列一栏：能进候选，且不与前排重复');
}

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

/**
 * 阵容复盘的提示词与解析。这里不判断"分析得好不好"，只钉住两件会静默出错的事：
 * 模型有没有被允许自己给胜率（不行——那会与本站算好的数字打架），以及回复解析的容错边界。
 */
{
	const verdict = buildVerdict({
		data,
		// 两边都用同一套英雄：这份自检只关心提示词怎么拼，不关心阵容本身强不强。
		ourIds: [1, 2, 3, 4, 5],
		theirIds: [1, 2, 3, 4, 5],
		ourSide: 'radiant',
		selfTeam: 'Team XG',
		foeTeam: 'Team Spirit',
	});
	assert.ok(verdict, '需要一份可用的复盘的输入');
	const [system, user] = buildVerdictMessages({ verdict: verdict!, data, selfTeam: 'Team XG', foeTeam: 'Team Spirit' });
	assert.match(system.content, /不要自己给一个胜率/, '必须明确禁止模型自己造胜率');
	assert.match(system.content, /对线/, '要求覆盖的角度里要有对线期');
	assert.match(system.content, /JSON/, '要求 JSON 输出');
	assert.match(user.content, /Team XG/, '要带上我方阵容与队名');
	assert.match(user.content, /Team Spirit/, '要带上对面阵容与队名');
	assert.match(user.content, /胜率（代码算的，原样引用）/, '胜率要标明是代码算的');
	assert.match(user.content, /50\.0%/, '镜像阵容的胜率是 50/50，必须写进提示词');
	assert.match(user.content, /平均号位胜率/, '要把维度对比给模型');
	assert.ok(!/undefined|NaN/.test(user.content), '提示词里出现了 undefined/NaN');

	/*
	 * 线上对位要单独成块，而且**不能**出现在没有这份数据的时候：
	 * 模型看不到的字段它不会瞎编，但把「对位偏差」和「线上净对线」写在同一行里，它一定会当成一件事。
	 */
	const withLanes = buildVerdict({
		// 这份自检的数据只有五个英雄，这里临时补五个当对手：线上对位要两边都有人才谈得上。
		data: {
			...data,
			heroes: [
				...data.heroes,
				hero(6, '斧王', [0.5, null, null, null, null]),
				hero(7, '撼地神牛', [null, 0.5, null, null, null]),
				hero(8, '莉娜', [null, null, 0.5, null, null]),
				hero(9, '巫医', [null, null, null, 0.5, null]),
				hero(10, '巫妖', [null, null, null, null, 0.5]),
			],
		},
		ourIds: [1, 2, 3, 4, 5],
		theirIds: [6, 7, 8, 9, 10],
		ourSide: 'radiant',
		selfTeam: 'Team XG',
		foeTeam: 'Team Spirit',
		// 键是「英雄id|号位|另一个英雄id」：一号位的敌法师在线上对斧王 +20%，和水晶室女同路 +12%。
		lanes: { vs: { '1|1|6': [800, 200] }, with: { '1|1|5': [600, 120] } },
	});
	assert.ok(withLanes, '带线上数据时也要能拼提示词');
	const [, userWithLanes] = buildVerdictMessages({ verdict: withLanes!, data, selfTeam: 'Team XG', foeTeam: 'Team Spirit' });
	assert.match(userWithLanes.content, /分路对位（线上阶段/, '线上对位要单独成块给模型');
	assert.match(userWithLanes.content, /平均净对线 \+20\.0%/, '线上净对线要带数字与场次');
	assert.match(userWithLanes.content, /同路搭档/, '同路搭档也要给模型');
	assert.ok(!/undefined|NaN/.test(userWithLanes.content), '带线上数据时也不许出现 undefined/NaN');
	assert.doesNotMatch(user.content, /分路对位/, '没有线上数据时不许出现这一块');

	const good = parseVerdictReply('{"summary":"双方节奏不同","points":[{"dimension":"对线","text":"一边更强"}]}');
	assert.equal(good?.points.length, 1);
	assert.equal(good?.points[0]?.dimension, '对线');
	// 模型偶尔会把 points 写成字符串数组，或者套一层代码块，这些都要能读出来。
	assert.equal(parseVerdictReply('```json\n{"summary":"x","points":["对线":"y"]}\n```'), null, '坏 JSON 要当没结果');
	assert.equal(parseVerdictReply('{"summary":"x","points":["只有正文"]}')?.points[0]?.text, '只有正文');
	assert.equal(parseVerdictReply('{"summary":"","points":[]}'), null, '全空当没结果');
	assert.equal(parseVerdictReply('抱歉，我想不出来'), null, '不是 JSON 就丢掉');
	console.log('  ✓ 复盘提示词禁止模型自造胜率，解析容错边界清晰');
}

console.log('draftPrompt 全部断言通过');
