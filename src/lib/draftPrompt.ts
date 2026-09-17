/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/draftPrompt.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。
 */
import type { DraftData } from './draftData.ts';
import type { Advice } from './draftScore.ts';
import type { RecordedHand } from './draftOrder.ts';
import { CM_STEPS, sideOfOwner } from './draftOrder.ts';

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
	/** 我方队名，没填就传空串。 */
	ourTeam: string;
	theirTeam: string;
	/** 已经录进去的 BP，用来告诉模型场上都发生过什么。 */
	recorded: readonly RecordedHand[];
	/** 我方阵营与先选方阵营，用来把每一手翻成"我方/对面"。 */
	ourSide: 'radiant' | 'dire';
	firstPicker: 'radiant' | 'dire';
}

const sideLabel = (ours: boolean, ourTeam: string, theirTeam: string): string =>
	ours ? ourTeam.trim() || '我方' : theirTeam.trim() || '对面';

/** 把候选摆成表格样式的纯文本，模型对不齐的 JSON 反而更容易漏读字段。 */
function renderCandidates(input: PromptInput): string {
	const byId = new Map(input.data.heroes.map((hero) => [hero.id, hero]));
	return input.advice.candidates
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
 * 系统提示词。写死在这里而不是让页面拼，是为了让它可被自检脚本检查：
 * 提示词改坏了不会报错，只会让建议悄悄变差，所以关键约束必须在测试里盯住。
 */
export function buildSystemPrompt(): string {
	return [
		'你是 DOTA2 职业战队的教练，在队长模式（Captain\'s Mode）的 BP 阶段给我方出主意。',
		'',
		'规则背景：7.40 起一共 24 手，每队 7 禁 5 选，顺序是先选方与后选方交替；后选方握着最后一手禁用和最后一手挑选。',
		'',
		'你必须遵守：',
		`1. 只能从用户给出的候选里挑 ${ADVICE_TARGET_COUNT} 个，输出里的 heroId 必须是候选列表里出现过的数字。`,
		'2. 理由里出现的数字只能来自用户给出的字段（号位胜率、样本场次、职业出场与被禁次数、估值）。',
		'   你不知道这些数据之外的任何统计，也不要去回忆版本强弱，绝对不要编造数字。',
		'3. 每条理由不超过两句，直接说这一手为什么拿它、为什么是现在。',
		'4. 如果这一手是禁用，理由要说明对面拿走它会造成什么；如果是挑选，说明它补上了哪个号位。',
		'5. 用简体中文，不要客套话，不要标题和列表符号。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"picks":[{"heroId":1,"position":2,"reason":"…","risk":"…"}],"summary":"…"}',
		`picks 按推荐程度从高到低，最多 ${ADVICE_TARGET_COUNT} 条；summary 是一两句话的整体判断。`,
	].join('\n');
}

export function buildUserPrompt(input: PromptInput): string {
	const { advice } = input;
	const ours = sideLabel(true, input.ourTeam, input.theirTeam);
	const theirs = sideLabel(false, input.ourTeam, input.theirTeam);
	const action = advice.action === 'ban' ? '禁用' : '挑选';
	const turn = advice.ours ? `轮到${ours}${action}` : `轮到${theirs}${action}（我方要预判对面会怎么动）`;

	return [
		`对局：${ours} vs ${theirs}`,
		`当前：第 ${advice.step} 手，${turn}`,
		`我方还剩 ${advice.remaining.ours.bans} 禁 ${advice.remaining.ours.picks} 选；对方还剩 ${advice.remaining.theirs.bans} 禁 ${advice.remaining.theirs.picks} 选。`,
		`最后一手禁用归${advice.tail.ban === 'ours' ? '我方' : '对面'}，最后一手挑选归${advice.tail.pick === 'ours' ? '我方' : '对面'}。`,
		`号位胜率口径：${input.data.bracketLabel}，近 ${input.data.windowDays} 天，少于 ${input.data.minPositionMatches} 场的号位不算数。`,
		'',
		'我方阵容现状：',
		renderLineup(input),
		'',
		'已经录进去的 BP：',
		renderRecorded(input),
		'',
		`候选（只能从这些里挑 ${ADVICE_TARGET_COUNT} 个，按推荐程度排序）：`,
		renderCandidates(input),
	].join('\n');
}

export function buildAdviceMessages(input: PromptInput): PromptMessage[] {
	return [
		{ role: 'system', content: buildSystemPrompt() },
		{ role: 'user', content: buildUserPrompt(input) },
	];
}

/** 单次回复的 token 上限。关掉思考之后实测一次约 290 个 token，900 留了足够余量。 */
export const ADVICE_MAX_TOKENS = 900;

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
