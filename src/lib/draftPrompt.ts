/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/draftPrompt.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。
 */
import type { DraftData, DraftHero } from './draftData.ts';
import type { Advice } from './draftScore.ts';
import type { RecordedHand } from './draftOrder.ts';
import { CM_STEPS, sideOfOwner } from './draftOrder.ts';
import type { FoeForm } from './draftFoe.ts';
import { foeHighlights, foeRecordLine, foeWinRate } from './draftFoe.ts';
import { formatNet } from './draftLanes.ts';
import type { DraftVerdict, VerdictRow } from './draftVerdict.ts';

/**
 * 提示词与回复解析。**这一层不联网**，只管把打分层算出来的东西摆成模型好用的样子，
 * 再把它的回复收紧成结构化结果。调用方（浏览器）负责带 key 发请求，服务端不碰 key。
 *
 * 三条硬约束，都是为了"别让模型自己编数据"：
 * 1. 候选名单由代码给定，模型只能从里面挑；
 * 2. 理由里出现的数字只能来自给定的数据字段；
 * 3. 输出必须是一个 JSON 对象，解析不过就当这次没结果，退回纯数据面板。
 */

/** 让模型给几个候选。三个够用了：多了反而是噪声，观赛时也不会去读第五条。 */
export const ADVICE_TARGET_COUNT = 3;

/**
 * 这次是给谁出主意。
 *
 * `ours` 是给屏幕前的人当教练，给 3 个候选让他挑；`theirs` 是让模型**替对面落子**，
 * 只要一个决定。同一份数据两边都能算：把 `ourSide` 换成对面，打分层给出的就是
 * "对面该怎么走"（挑自己缺的位置、禁我们最想要的人）。
 */
export type PromptRole = 'ours' | 'theirs';

/** DeepSeek 的模型名。两个都走 OpenAI 兼容的 chat/completions。 */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepseekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEFAULT_DEEPSEEK_MODEL: DeepseekModel = 'deepseek-flash';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export interface PromptMessage {
	role: 'system' | 'user';
	content: string;
}

export interface PromptInput {
	advice: Advice;
	data: DraftData;
	/**
	 * 队名。这里的「自己 / 对面」指的是**这份建议的视角**：
	 * 给我方出主意时自己就是屏幕前的人，替对面落子时自己就是对面。
	 * 调用方按视角传，提示词里的人称才不会翻。
	 */
	selfTeam: string;
	foeTeam: string;
	/** 已经录进去的 BP，用来告诉模型场上都发生过什么。 */
	recorded: readonly RecordedHand[];
	/** 我方阵营与先选方阵营，用来把每一手翻成"我方/对面"。 */
	ourSide: 'radiant' | 'dire';
	firstPicker: 'radiant' | 'dire';
	/**
	 * 对面近期的英雄偏好。有它就多一段依据，没有就整段不出——**不给模型留空位**，
	 * 免得它拿「据说这支队爱打团」这种印象来填空。
	 */
	foeForm?: FoeForm | null;
}

/**
 * 把候选摆成表格样式的纯文本，模型对不齐的 JSON 反而更容易漏读字段。
 *
 * 两段：上面是打分层算出来的排序，下面是**对面近期真拿过、但没排进前列**的那些。
 * 分成两段而不是合成一段，是因为它们依据不同——混着排等于让「谁更熟」悄悄参与排序。
 */
function renderCandidates(input: PromptInput, role: PromptRole): string {
	const list = (rows: readonly Advice['candidates'][number][]): string => {
		const byId = new Map(input.data.heroes.map((hero) => [hero.id, hero]));
		return rows
			.map((candidate) => {
				const hero = byId.get(candidate.heroId);
				const name = hero ? `${hero.name}（${hero.nameEn}）` : `英雄 #${candidate.heroId}`;
				const rate = candidate.hasSample ? `${(candidate.rate * 100).toFixed(1)}%` : '无样本';
				const lines = [
					`- heroId=${candidate.heroId} ${name}：建议 ${candidate.position} 号位，该号位胜率 ${rate}`,
					...candidate.reasons.map((reason) => `  依据：${reason}`),
					`  风险：${candidate.risk}`,
				];
				return lines.join('\n');
			})
			.join('\n');
	};

	const main = list(input.advice.candidates);
	if (input.advice.foeCandidates.length === 0) return main;
	const whose = role === 'theirs' ? '你自己' : '对面';
	return `${main}\n\n（以下 ${input.advice.foeCandidates.length} 个是${whose}近期真拿过的，没排进上面的顺序，同样可以挑）：\n${list(input.advice.foeCandidates)}`;
}

/** 已录的 BP，按手号列出来，被跳过的注明跳过。 */
function renderRecorded(input: PromptInput): string {
	if (input.recorded.length === 0) return '（还没有录任何一手）';
	const byId = new Map(input.data.heroes.map((hero) => [hero.id, hero]));
	return input.recorded
		.map((heroId, index) => {
			const step = CM_STEPS[index];
			const owner = sideOfOwner(step.owner, input.firstPicker) === input.ourSide ? '我方' : '对面';
			const action = step.action === 'ban' ? '禁用' : '挑选';
			if (typeof heroId !== 'number') return `第 ${index + 1} 手 ${owner}${action}：跳过`;
			const hero = byId.get(heroId);
			return `第 ${index + 1} 手 ${owner}${action}：${hero ? hero.name : `英雄 #${heroId}`}`;
		})
		.join('\n');
}

function renderLineup(input: PromptInput): string {
	return input.advice.lineup
		.map((slot) => {
			const name = slot.hero?.name ?? '还没人';
			const mark = slot.settled ? '已到手' : '预计能补到';
			return `${slot.position} 号位：${name}（${mark}，胜率 ${(slot.rate * 100).toFixed(1)}%）`;
		})
		.join('\n');
}

/**
 * 对面近期的使用习惯。**只给场次、胜负、被禁次数**，不给任何「招牌英雄」式的判断：
 * 按队伍统计分不出位置，说成招牌就是替数据下结论。
 *
 * 这段数据来自对面**最近的真实比赛**，模型引用它时说的话是可以核对的，
 * 和白名单外的「我记得这支队伍爱用某某」有本质区别，所以这一段在提示词里单独成块。
 */
function renderFoe(input: PromptInput, role: PromptRole): string {
	const form = input.foeForm;
	if (!form || form.matches === 0) return '';
	const byId = new Map(input.data.heroes.map((hero) => [hero.id, hero]));
	const lines = foeHighlights(form, 8).map((hero) => {
		const info = byId.get(hero.heroId);
		const name = info ? `${info.name}（${info.nameEn}）` : `英雄 #${hero.heroId}`;
		const rate = foeWinRate(hero);
		const record = rate === null ? '胜负未记录' : `${hero.wins} 胜 ${hero.decided - hero.wins} 负，胜率 ${(rate * 100).toFixed(1)}%`;
		return `- heroId=${hero.heroId} ${name}：${hero.picks} 场（${record}），对手禁过它 ${hero.bansAgainst} 次`;
	});
	if (lines.length === 0) return '';
	// 替对面落子时，这份数据是「你自己」的，人称要跟着翻，否则模型会把两方读反。
	const whose = role === 'theirs' ? '你自己近期爱用' : `对面（${form.name.trim() || '对方'}）近期爱用`;
	return [`${whose}（${foeRecordLine(form)}）：`, ...lines].join('\n');
}

/**
 * 版本这一句要怎么写。
 *
 * 带上版本号，是为了让"这批胜率属于什么时候"没有歧义；更关键的是**跨版本要说明白**：
 * 统计窗口是近 7 天，如果新版本就在这几天里发的，胜率是新旧两个版本混算的，
 * 拿它当"当前版本强度"会看偏。宁可让建议显得保守，也不要让它把混算的数字当成结论。
 */
function renderPatch(data: DraftData): string {
	const { version, date, straddles } = data.patch;
	if (!version) return '';
	const base = `版本 ${version}${date ? `（${date} 发布）` : ''}。`;
	if (!straddles) return base;
	return `${base}注意：近 ${data.windowDays} 天的样本里跨了这次版本更新，胜率混着旧版本的场次，别把版本改动本身当成选它的理由。`;
}

/**
 * 系统提示词。写死在这里而不是让页面拼，是为了让它可被自检脚本检查：
 * 提示词改坏了不会报错，只会让建议悄悄变差，所以关键约束必须在测试里盯住。
 */
export function buildSystemPrompt(role: PromptRole = 'ours'): string {
	if (role === 'theirs') {
		return [
			'你是 DOTA2 职业战队的教练，这一局你代表对面，正在和坐在屏幕前的人对抗。',
			'',
			'规则背景：7.40 起一共 24 手，每队 7 禁 5 选，先选方与后选方交替；后选方握着最后一手禁用和最后一手挑选。',
			'',
			'你必须遵守：',
			'1. 只从用户给出的候选里挑 1 个，输出里的 heroId 必须是候选列表里出现过的数字。',
		'2. 理由里的数字只能来自用户给出的字段（号位胜率、对位胜率、线上净对线、样本场次、职业出场与被禁次数、估值）。',
			'   你不知道这些数据之外的任何统计，也不要去回忆版本强弱，绝对不要编造数字。',
			'3. 你要选的是对自己最有利的那一手：挑选补自己的阵容缺口，禁用掐掉对面最想要的人。',
			'   候选的依据里有对位数据（谁好打谁），用它判断这一手值不值，别只盯号位胜率。',
			'   依据里还有阵容结构：控制/爆发/先手/上高/前排/辅助/远程/清场缺不缺，纯核与近战有没有过量，',
			'   前期后期各有几个人不弱。这些都是要一起看的，缺了哪一项就在理由里点出来。',
			'4. 理由是给对手看的，用第二人称写：用"你们"指对手（屏幕前的人），用"我"指你自己。',
			'   例如"禁掉你们的四号位高胜率点，把你们的阵容估值压下来"。就算数据里出现"对面"这个词，',
			'   那也是从你的角度算的，写进理由时要改成人话。',
			'5. 「你自己近期爱用」那几个英雄是你熟的东西：挑选时优先在里面补自己的缺口，禁用时掐对面最想要的。',
			'   熟只代表你敢拿、胜率高，不代表它这一手就比别的强——依据里的场次与胜率要照实引用。',
			'',
			'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
			'{"picks":[{"heroId":1,"position":2,"reason":"…","risk":"…"}],"summary":"…"}',
			'picks 只给 1 条，就是你决定的这一手；summary 一句话说你的打算。',
		].join('\n');
	}
	return [
		'你是 DOTA2 职业战队的教练，在队长模式（Captain\'s Mode）的 BP 阶段给我方出主意。',
		'',
		'规则背景：7.40 起一共 24 手，每队 7 禁 5 选，顺序是先选方与后选方交替；后选方握着最后一手禁用和最后一手挑选。',
		'',
		'你必须遵守：',
		`1. 只能从用户给出的候选里挑 ${ADVICE_TARGET_COUNT} 个，输出里的 heroId 必须是候选列表里出现过的数字。`,
		'2. 理由里出现的数字只能来自用户给出的字段（号位胜率、对位胜率、线上净对线、样本场次、职业出场与被禁次数、估值、阵容结构）。',
		'   线上净对线是**线上阶段**的净胜，与整局对位胜率不是一回事，不要混着说。',
		'   你不知道这些数据之外的任何统计，也不要去回忆版本强弱，绝对不要编造数字。',
		'3. 每条理由不超过两句，直接说这一手为什么拿它、为什么是现在。',
		'4. 如果这一手是禁用，理由要说明对面拿走它会造成什么；如果是挑选，说明它补上了哪个号位。',
		'5. 有对面近期比赛记录时，他们拿得多、胜率高的英雄，禁用优先级要往前提（`禁`掉对面熟手的价值',
		'   不等于它在全局胜率里排第几）；挑选时如果候选里正好有对面的熟手，说明这一手还顺带压住了他们。',
		'   只知道这些场次与胜率，不要凭印象说某支队「爱打团」「习惯四保一」。',
		'6. 用简体中文，不要客套话，不要标题和列表符号。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"picks":[{"heroId":1,"position":2,"reason":"…","risk":"…"}],"summary":"…"}',
		`picks 按推荐程度从高到低，最多 ${ADVICE_TARGET_COUNT} 条；summary 是一两句话的整体判断。`,
	].join('\n');
}

export function buildUserPrompt(input: PromptInput, role: PromptRole = 'ours'): string {
	const { advice } = input;
	const ours = input.selfTeam.trim() || '我方';
	const theirs = input.foeTeam.trim() || '对面';
	const action = advice.action === 'ban' ? '禁用' : '挑选';
	const turn = advice.ours ? `轮到${ours}${action}` : `轮到${theirs}${action}（我方要预判对面会怎么动）`;
	const foe = renderFoe(input, role);

	return [
		// 替对面落子时，数据是从对面的角度算的，先把人称交代清楚，免得模型把两方搞反。
		...(role === 'theirs' ? ['（以下数据是从你的角度算的：文中的"我方"指你自己，"对面"指坐在屏幕前的人。）'] : []),
		`对局：${ours} vs ${theirs}`,
		`当前：第 ${advice.step} 手，${turn}`,
		`我方还剩 ${advice.remaining.ours.bans} 禁 ${advice.remaining.ours.picks} 选；对方还剩 ${advice.remaining.theirs.bans} 禁 ${advice.remaining.theirs.picks} 选。`,
		`最后一手禁用归${advice.tail.ban === 'ours' ? '我方' : '对面'}，最后一手挑选归${advice.tail.pick === 'ours' ? '我方' : '对面'}。`,
		`版本与口径：${renderPatch(input.data)}${input.data.bracketLabel}，近 ${input.data.windowDays} 天，少于 ${input.data.minPositionMatches} 场的号位不算数。`,
		'',
		'我方阵容现状：',
		renderLineup(input),
		input.advice.composition.text,
		'',
		'已经录进去的 BP：',
		renderRecorded(input),
		...(foe ? ['', foe] : []),
		'',
		`候选（只能从这些里挑 ${ADVICE_TARGET_COUNT} 个，按推荐程度排序）：`,
		renderCandidates(input, role),
	].join('\n');
}

export function buildAdviceMessages(input: PromptInput, role: PromptRole = 'ours'): PromptMessage[] {
	return [
		{ role: 'system', content: buildSystemPrompt(role) },
		{ role: 'user', content: buildUserPrompt(input, role) },
	];
}

/** 单次回复的 token 上限。关掉思考之后实测一次约 290 个 token，900 留了足够余量。 */
export const ADVICE_MAX_TOKENS = 900;

// ---------------------------------------------------------------- 双方阵容的复盘

/**
 * 复盘提示词。与出主意那份的关键区别：这里**没有下一手**，所以不要求它在候选里挑，
 * 只要求它把已经算好的对比讲成人话。胜率由代码给定，明令不许自己改——
 * 模型最像样的失败就是「我觉得这阵容七三开」，那与本项目「数字必须可核对」的前提冲突。
 */
export interface VerdictPromptInput {
	verdict: DraftVerdict;
	data: DraftData;
	selfTeam: string;
	foeTeam: string;
	/** 对面近期的英雄偏好，用来解释「他们拿到的熟手」。 */
	foeForm?: FoeForm | null;
}

export function buildVerdictSystemPrompt(): string {
	return [
		'你是 DOTA2 职业战队的教练。这一局双方的阵容**已经选完**，你要做的是复盘这套对局，不是再给 BP 建议。',
		'',
		'你必须遵守：',
		'1. 只引用用户给出的数字（平均号位胜率、对位偏差、各个能力维度、结构分、时间曲线、对面近期英雄）。',
		'   你不知道这些之外的任何统计，也不要去回忆版本强弱，绝对不要编造数字。',
		'2. 胜率是代码算好的，原样引用（写成"我方 53.2% 对 46.8%"），**不要自己给一个胜率**。',
		'3. 覆盖这五个角度，每个角度一到两句：对线期（谁的分路更占优）、团战（先手/控制/范围伤害/清场）、',
		'   前后期曲线（谁该压节奏、谁该拖）、推进与守高、以及双方的核心矛盾（一边靠什么赢、另一边怎么破）。',
		'4. 两边都要给出**赢的路径**（谁先手、谁输出、什么时候打）和**最怕什么**，不要只讲一边。',
		'5. 能力维度只做横向对比；判不出高低就说持平，不要为了有观点而硬分出强弱。',
		'6. 用简体中文，不要客套话，不要标题和列表符号。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"summary":"一两句话的整体判断","points":[{"dimension":"对线","text":"…"}]}',
		'points 给 4 到 6 条，dimension 用中文短语（对线、团战、节奏、推进、破局……）。',
	].join('\n');
}

function renderVerdictLineup(side: { label: string; rows: { position: number; hero: DraftHero | null; rate: number }[] }): string {
	return side.rows
		.map((row) => {
			const name = row.hero ? `${row.hero.name}（${row.hero.nameEn}）` : '（空）';
			return `${row.position} 号位 ${name}：该号位胜率 ${(row.rate * 100).toFixed(1)}%`;
		})
		.join('\n');
}

function renderVerdictRows(rows: readonly VerdictRow[]): string {
	return rows.map((row) => `- ${row.text}`).join('\n');
}

export function buildVerdictUserPrompt(input: VerdictPromptInput): string {
	const { verdict, data } = input;
	const ours = input.selfTeam.trim() || '我方';
	const theirs = input.foeTeam.trim() || '对面';
	const foe = input.foeForm
		? foeHighlights(input.foeForm, 8).map((hero) => {
				const info = data.heroes.find((item) => item.id === hero.heroId);
				const rate = foeWinRate(hero);
				return `- heroId=${hero.heroId} ${info ? info.name : `英雄 #${hero.heroId}`}：${hero.picks} 场${rate === null ? '' : `，胜率 ${(rate * 100).toFixed(1)}%`}`;
			})
		: [];

	return [
		`对局：${ours} vs ${theirs}。双方阵容已锁：`,
		'',
		`${ours}：`,
		renderVerdictLineup(verdict.ours),
		'',
		`${theirs}：`,
		renderVerdictLineup(verdict.theirs),
		'',
		// 胜率给的是「我方视角」，先把人称交代清楚，免得它把两边写反。
		`胜率（代码算的，原样引用）：${ours} ${(verdict.winRate.ours * 100).toFixed(1)}% 对 ${(verdict.winRate.theirs * 100).toFixed(1)}% ${theirs}。`,
		`它由号位偏差 ${(verdict.edge.position * 100).toFixed(1)} 与对位偏差 ${(verdict.edge.counter * 100).toFixed(1)} 相加得到（百分点）。`,
		'',
		`维度对比（${ours} : ${theirs}）：`,
		renderVerdictRows(verdict.rows),
		// 分路对位单独一块：它与「对位偏差」不是一个口径，混在同一行里模型一定会当成同一件事。
		verdict.laneEdges.length > 0
			? [
					'',
					'分路对位（线上阶段；对手取「这个人打这个号位时线上真的遇到过的」，不是同位对位）：',
					...verdict.laneEdges.map((edge) => {
						const foes = edge.opponents
							.slice(0, 3)
							.map((entry) => `${entry.hero.name} ${formatNet(entry.net)}（${entry.matches} 场）`)
							.join('、');
						return `- ${edge.side === 'ours' ? ours : theirs} ${edge.position} 号位 ${edge.hero.name}：平均净对线 ${formatNet(edge.net)}（线上 ${edge.matches} 场）
  对过：${foes}`;
					}),
				].join('\n')
			: '',
		verdict.lanePartners.length > 0
			? [
					'',
					'同路搭档（常规分路，线上阶段）：',
					...verdict.lanePartners.map(
						(pair) =>
							`- ${pair.side === 'ours' ? ours : theirs}：${pair.position} 号位 ${pair.hero.name} 与 ${pair.partner.name} 同路时，线上净对线 ${formatNet(pair.net)}（${pair.matches} 场）`,
					),
				].join('\n')
			: '',
		verdict.foePicks.length > 0
			? ['', `${theirs} 这套里拿到的近期熟手：`, ...verdict.foePicks.map((pick) => `- ${pick.hero.name}：近窗口 ${pick.picks} 场${pick.rate === null ? '' : `，胜率 ${(pick.rate * 100).toFixed(1)}%`}`)].join('\n')
			: '',
		foe.length > 0 ? ['', `${theirs} 近期的英雄偏好（窗口内的前几个）：`, ...foe].join('\n') : '',
		'',
		'口径与限制：',
		...verdict.notes.map((note) => `- ${note}`),
	].filter((line) => line !== '').join('\n');
}

export function buildVerdictMessages(input: VerdictPromptInput): PromptMessage[] {
	return [
		{ role: 'system', content: buildVerdictSystemPrompt() },
		{ role: 'user', content: buildVerdictUserPrompt(input) },
	];
}

/**
 * 复盘要写五个角度、每条一到两句，比"给一手建议"长得多。
 * 上限给 1400（建议那边是 900）：思考同样是关掉的，实测 6 条约 700 个 token，
 * 留一倍余量免得输出被截断成半句。
 */
export const VERDICT_MAX_TOKENS = 1400;

export interface ParsedVerdict {
	summary: string;
	points: { dimension: string; text: string }[];
}

/**
 * 解析复盘回复。容错口径与 `parseAdviceReply` 一致（剥围栏、截最外层花括号），
 * 但**不要求** dimension 是预定义的那几个：模型按场上情况挑角度是合理的，
 * 只要每条的正文非空。全空就当这次没有结果，界面退回纯数字对比。
 */
export function parseVerdictReply(raw: string): ParsedVerdict | null {
	if (!raw) return null;
	const withoutFence = raw.replace(/```(?:json)?/gi, '');
	const start = withoutFence.indexOf('{');
	const end = withoutFence.lastIndexOf('}');
	if (start < 0 || end <= start) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutFence.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;

	const body = parsed as { summary?: unknown; points?: unknown };
	const points: ParsedVerdict['points'] = [];
	for (const item of Array.isArray(body.points) ? body.points : []) {
		if (typeof item === 'string') {
			const text = item.trim();
			if (text) points.push({ dimension: '', text });
			continue;
		}
		if (!item || typeof item !== 'object') continue;
		const row = item as { dimension?: unknown; text?: unknown };
		const text = typeof row.text === 'string' ? row.text.trim() : '';
		if (!text) continue;
		points.push({ dimension: typeof row.dimension === 'string' ? row.dimension.trim() : '', text });
	}

	const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
	if (!summary && points.length === 0) return null;
	return { summary, points: points.slice(0, 8) };
}

export interface ChatRequestOptions {
	model: string;
	messages: PromptMessage[];
	/** 是否要求 JSON 输出。被 400 拒掉时调用方会去掉它重试。 */
	jsonMode?: boolean;
	maxTokens?: number;
}

/**
 * 组装 DeepSeek 的 `chat/completions` 请求体。
 *
 * **必须显式关掉思考**（`thinking: { type: 'disabled' }`）。这不是调优，是不关就没有结果：
 * `deepseek-flash` 默认开着思考，实测同样一条提示词下 900 的 token 上限全被 `reasoning_tokens`
 * 吃光，`content` 是空的（`finish_reason: length`）；把上限提到 4000 也一样空，耗时 21 秒。
 * 关掉之后 1.8 秒返回 288 个 token 的正常 JSON。
 */
export function buildChatRequest(options: ChatRequestOptions): Record<string, unknown> {
	return {
		model: options.model,
		messages: options.messages,
		temperature: 0.3,
		max_tokens: options.maxTokens ?? ADVICE_MAX_TOKENS,
		...(options.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
		thinking: { type: 'disabled' },
	};
}

export interface ParsedPick {
	heroId: number;
	position: number;
	reason: string;
	risk: string;
}

export interface ParsedAdvice {
	picks: ParsedPick[];
	summary: string;
}

/**
 * 解析模型的回复。任何一步不对都返回 null：调用方宁可显示"这次没给出建议"，
 * 也不要把半截 JSON 或编出来的英雄塞进界面。
 *
 * 容错只做两件事：剥掉代码块围栏、截取最外层的花括号。剩下的交给 JSON.parse。
 */
export function parseAdviceReply(raw: string, allowedHeroIds: readonly number[]): ParsedAdvice | null {
	if (!raw) return null;
	const withoutFence = raw.replace(/```(?:json)?/gi, '');
	const start = withoutFence.indexOf('{');
	const end = withoutFence.lastIndexOf('}');
	if (start < 0 || end <= start) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutFence.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;

	const allowed = new Set(allowedHeroIds);
	const rawPicks = (parsed as { picks?: unknown }).picks;
	if (!Array.isArray(rawPicks)) return null;

	const picks: ParsedPick[] = [];
	for (const item of rawPicks) {
		if (!item || typeof item !== 'object') continue;
		const row = item as { heroId?: unknown; position?: unknown; reason?: unknown; risk?: unknown };
		const heroId = Number(row.heroId);
		// 候选之外的英雄一律丢掉：模型偶尔会"想起"一个我们没给的英雄。
		if (!Number.isInteger(heroId) || !allowed.has(heroId)) continue;
		const position = Number(row.position);
		if (!Number.isInteger(position) || position < 1 || position > 5) continue;
		const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
		if (!reason) continue;
		picks.push({
			heroId,
			position,
			reason: reason.slice(0, 200),
			risk: typeof row.risk === 'string' ? row.risk.trim().slice(0, 200) : '',
		});
		if (picks.length >= ADVICE_TARGET_COUNT) break;
	}
	if (picks.length === 0) return null;

	const summary = typeof (parsed as { summary?: unknown }).summary === 'string' ? (parsed as { summary: string }).summary.trim() : '';
	return { picks, summary: summary.slice(0, 400) };
}
