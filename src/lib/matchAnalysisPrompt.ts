/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { PromptMessage } from './aiChat.ts';
import { formatElapsed } from './format.ts';
import type { AnalysisMoment, MatchAnalysisInput } from './matchAnalysis.ts';

/**
 * 赛后分析的提示词与回复解析。**这一层不联网**，只管把 `matchAnalysis` 收好的那份摘要
 * 摆成模型好用的样子，再把它的话收成结构化结果。发请求由浏览器那一层做（`aiChat.requestChat`）。
 *
 * 三条硬约束，与 `draftPrompt` 同源，都是为了"别让模型自己编数据"：
 * 1. 数字只能来自给定的字段，不许回忆版本强弱；
 * 2. 这一局**没有胜率预测**——只有数据里出现过胜率模型的值才能引用；
 * 3. 输出必须是一个 JSON 对象，解析不过就当这次没结果，界面退回纯数据面板。
 */

export function buildAnalysisSystemPrompt(): string {
	return [
		'你是 DOTA2 职业战队的教练。这一局**已经打完**，你要做的是赛后复盘，不是预测、也不是再给 BP 建议。',
		'',
		'你必须遵守：',
		'1. 只引用用户给出的数字（经济与经验差、胜率模型、伤害、建筑、眼位、装备）。',
		'   你不知道这些之外的任何统计，不要去回忆版本强弱，绝对不要编造数字。',
		'2. 这一局没有胜率预测：只有数据里出现过胜率模型的值才可以引用，并要说明它是哪一分钟的。',
		'3. 胜负已经定了，不要写成谁"会"赢。要分别回答三件事：胜方靠什么赢、负方输在哪、负方要怎么打才有机会赢。',
		'4. 覆盖这几个角度，每个角度一到两句：对线期、节奏与转折、团战与输出、推进与建筑、视野（有数据时才写）。',
		'5. 判不出高低就说持平，数据不够就直说数据不足，不要为了有观点而硬分强弱。',
		'6. 用简体中文，不要客套话，不要标题符号，不要 Markdown。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"headline":"一两句话的整体结论","winnerWhy":["…"],"loserWhy":["…"],"pathToWin":["…"],"dimensions":[{"dimension":"对线","text":"…"}]}',
		'winnerWhy / loserWhy / pathToWin 各 2 到 4 条，dimensions 给 4 到 6 条。',
	].join('\n');
}

// ---------------------------------------------------------------- 数字口径

/** 千分位。提示词里的数字要能一眼读出量级，`21300` 得写成 `21,300`。 */
function num(value: number): string {
	return Math.round(value).toLocaleString('en-US');
}

/** 带正负号的差值。经济与经验差是天辉视角，正负本身就是结论。 */
function signed(value: number): string {
	return `${value > 0 ? '+' : ''}${num(value)}`;
}

/** 胜率模型给的是 0–1；提示词里统一写成整数百分比。 */
function pct(rate: number | null): string {
	return rate === null ? '未记录' : `${Math.round(rate * 100)}%`;
}

/** 曲线上的一点写成 `18 分钟 经济 +12,340 / 经验 +8,900 / 胜率 82%`。 */
function moment(point: AnalysisMoment): string {
	return `${point.minute} 分钟 经济 ${signed(point.networthLead)} / 经验 ${signed(point.experienceLead)} / 胜率 ${pct(point.winRate)}`;
}

// ---------------------------------------------------------------- 用户提示词

function renderTeam(rows: MatchAnalysisInput['players']): string {
	return rows
		.map((row) => {
			const imp = row.imp === null ? '' : ` / IMP ${row.imp.toFixed(1)}`;
			const items = row.items.length > 0 ? `\n  装备：${row.items.join('、')}` : '';
			return `- ${row.hero}（${row.name}）：${row.kills}/${row.deaths}/${row.assists}，经济 ${num(row.networth)}（GPM ${row.gpm} / XPM ${row.xpm}），等级 ${row.level}，正补 ${row.lastHits} / 反补 ${row.denies}，对英雄伤害 ${num(row.heroDamage)} / 对建筑伤害 ${num(row.towerDamage)} / 治疗 ${num(row.heroHealing)}${imp}${items}`;
		})
		.join('\n');
}

/**
 * 一局的账单。分块摆：结果 → 三路 → 建筑 → 曲线 → 十个人 → 视野 → 口径。
 *
 * 每一块只在有数据时出现（眼位、曲线都是「有录像才有」），**不给模型留空位**——
 * 空着的字段它会拿"据说这局打了 60 分钟"这类印象来填。
 */
export function buildAnalysisUserPrompt(input: MatchAnalysisInput): string {
	const winner = input.winner ? `${input.winner}获胜（${input.winner === '天辉' ? input.radiantName : input.direName}）` : '上游还没给结果';
	const radiantRows = input.players.filter((row) => row.side === '天辉');
	const direRows = input.players.filter((row) => row.side === '夜魇');
	const names: Record<'天辉' | '夜魇', string> = { 天辉: input.radiantName, 夜魇: input.direName };

	const lines: string[] = [
		`对局：${input.radiantName}（天辉） vs ${input.direName}（夜魇）。`,
		`时长 ${formatElapsed(input.durationSeconds)}，结果：${winner}，一血：${input.firstBloodTime === null ? '未记录' : formatElapsed(input.firstBloodTime)}。`,
		'',
		'三路结果（对线期）：',
		...input.lanes.map((lane) => `- ${lane.lane}：${lane.outcome}`),
		'',
		'建筑（结束时还剩多少）：',
		...input.buildings.map((side) => {
			const name = names[side.side];
			return `- ${side.side}（${name}）：塔 ${side.towersAlive}/${side.towersTotal}，兵营 ${side.barracksAlive}/${side.barracksTotal}（被推掉 ${side.towersFallen} 塔 / ${side.barracksFallen} 兵营）`;
		}),
	];

	if (input.falls.length > 0) {
		lines.push(
			'',
			'建筑倒塌时间轴（`被拆方` 是倒了的那一边）：',
			...input.falls.map((fall) => `- ${formatElapsed(fall.time)} 被拆方 ${fall.by} · ${fall.label} · 补刀 ${fall.attacker}`),
		);
	}

	if (input.curve) {
		const { timeline, peak, trough, swing } = input.curve;
		lines.push('', '经济与经验（天辉视角：正数 = 天辉领先）：', ...timeline.map((point) => `- ${moment(point)}`));
		lines.push(
			`- 天辉最大领先：${moment(peak)}`,
			`- 天辉最大落后：${moment(trough)}`,
			swing ? `- 单分钟最大变化：${swing.minute} 分钟 经济 ${signed(swing.delta)}（正数 = 天辉这一分钟拉开，负数 = 被追回）` : '',
		);
	}

	lines.push('', '十名选手（天辉在前、同队按经济从高到低）：', '天辉：', renderTeam(radiantRows), '夜魇：', renderTeam(direRows));

	if (input.wards) {
		lines.push(
			'',
			'视野：',
			...input.wards.map(
				(ward) =>
					`- ${ward.side}（${names[ward.side]}）：插眼 ${ward.placed}（假眼 ${ward.observer} / 真眼 ${ward.sentry}），反眼 ${ward.taken}，被反 ${ward.lost}，自然到期 ${ward.expired}`,
			),
		);
	}

	lines.push('', '口径与限制：', '- 数据来自 STRATZ 已解析的公开对局，胜负与全部数字都以它为准，不要另行推断。');
	if (!input.curve) lines.push('- 这一局没有逐分钟曲线，节奏与转折只能从建筑时间轴和选手数据判断，不要编造时间点。');
	if (!input.wards) lines.push('- 这一局没有眼位数据（未下载录像），视野这一角直接跳过，不要编。');

	return lines.filter((line) => line !== '').join('\n');
}

export function buildAnalysisMessages(input: MatchAnalysisInput): PromptMessage[] {
	return [
		{ role: 'system', content: buildAnalysisSystemPrompt() },
		{ role: 'user', content: buildAnalysisUserPrompt(input) },
	];
}

/**
 * 赛后分析要把三件事各写 2–4 条，再加 4–6 个角度，比「给一手建议」长得多。
 * 上限给 2000（建议那边是 900，阵容复盘是 1400）：思考同样是关掉的，留足余量免得截成半句。
 */
export const ANALYSIS_MAX_TOKENS = 2000;

// ---------------------------------------------------------------- 回复解析

export interface ParsedAnalysis {
	headline: string;
	winnerWhy: string[];
	loserWhy: string[];
	pathToWin: string[];
	dimensions: { dimension: string; text: string }[];
}

/** 一段文字数组：丢掉空串与不是字符串的项，并裁到上限。 */
function textList(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = typeof item === 'string' ? item.trim() : '';
		if (!text) continue;
		out.push(text.slice(0, 400));
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 解析赛后分析回复。
 *
 * 容错口径与 `parseVerdictReply` 一致（剥围栏、截最外层花括号），但要求**三段文字里
 * 至少有一段非空**：全空就当这次没有结果，界面退回纯数据面板，而不是显示一个空壳。
 * dimension 不限定取值——模型按场上情况挑角度是合理的，只要正文非空。
 */
export function parseAnalysisReply(raw: string): ParsedAnalysis | null {
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

	const body = parsed as Record<string, unknown>;
	const headline = typeof body.headline === 'string' ? body.headline.trim().slice(0, 400) : '';
	const winnerWhy = textList(body.winnerWhy, 6);
	const loserWhy = textList(body.loserWhy, 6);
	const pathToWin = textList(body.pathToWin, 6);

	const dimensions: { dimension: string; text: string }[] = [];
	if (Array.isArray(body.dimensions)) {
		for (const item of body.dimensions) {
			if (!item || typeof item !== 'object') continue;
			const row = item as { dimension?: unknown; text?: unknown };
			const text = typeof row.text === 'string' ? row.text.trim() : '';
			if (!text) continue;
			dimensions.push({ dimension: typeof row.dimension === 'string' ? row.dimension.trim().slice(0, 20) : '', text: text.slice(0, 400) });
			if (dimensions.length >= 8) break;
		}
	}

	// 一整段都没读到，就当这次没结果——不要显示一个只有标题的空壳。
	if (!headline && winnerWhy.length === 0 && loserWhy.length === 0 && pathToWin.length === 0 && dimensions.length === 0) return null;
	return { headline, winnerWhy, loserWhy, pathToWin, dimensions };
}
