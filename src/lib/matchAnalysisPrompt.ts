/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { PromptMessage } from './aiChat.ts';
import { formatElapsed } from './format.ts';
import type { AnalysisLead, AnalysisMoment, MatchAnalysisInput } from './matchAnalysis.ts';
import type { PlaybackSummary } from './playbackSummary.ts';

/**
 * 赛后分析的提示词与回复解析。**这一层不联网**，只管把 `matchAnalysis` 收好的那份摘要
 * 摆成模型好用的样子，再把它的话收成结构化结果。发请求由浏览器那一层做（`aiChat.requestChat`）。
 *
 * 四条硬约束，前三条与 `draftPrompt` 同源（别让模型自己编数据），第四条是这份独有的：
 * 1. 数字只能来自给定的字段，不许回忆版本强弱；
 * 2. 这一局**没有胜率预测**——只有数据里出现过胜率模型的值才能引用；
 * 3. 输出必须是一个 JSON 对象，解析不过就当这次没结果，界面退回纯数据面板；
 * 4. **不许复述数据**。上面那份复盘面板已经把数字都摆出来了，模型再把「15 分钟经济 +1,620」
 *    念一遍是零信息量。所以提示词强制每条先给机制、数字只当证据，并要求指认一次转折；
 *    数据不足以归因时必须明说，不许用"一般来说"补一个原因。
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
		'4. **不要复述数据。** 用户已经看到了经济曲线、建筑时间轴和十个人的账单。你的每一条都要回答「为什么」：',
		'   数字只能当证据挂在机制后面，不许单独成句。写「18 分钟经济转正，是因为中路一波团赢了又顺势拆塔」，',
		'   不写「18 分钟经济 +3,604」。只把表格念一遍等于什么也没说。',
		'5. 先给转折点：找出本局最关键的一次转折，说清发生在第几分钟、曲线在那一刻怎么变、最可能的原因是什么。',
		'   能用的机制只有这些：对线结果、经济与经验差的分岔、建筑倒塌的时间与顺序、核心/辅助的死亡数、',
		'   视野与反眼、输出与治疗的分布、号位与分路、关键装备的成型时间，以及回放轨迹里能看出的集结与推进',
		'   （有轨迹数据时才有）。**数据不足以判断原因时，直说「看不出具体是哪一波」**，',
		'   不要用"一般来说""通常"补一个原因。',
		'6. 负方怎么才能赢：给**可执行的动作**，每条绑定本局的具体弱点——该控哪片视野、什么时候该开雾或打盾、',
		'   该拖到什么时间点、该保谁、该断谁的刷钱。不要写「加强视野」「减少失误」这种放到哪一局都成立的话。',
		'7. 覆盖这几个角度，每个角度一到两句：对线期、节奏与转折、团战与输出、推进与建筑、视野（有数据时才写）。',
		'8. 判不出高低就说持平，数据不够就直说数据不足，不要为了有观点而硬分强弱。',
		'9. 用简体中文，不要客套话，不要标题符号，不要 Markdown。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"headline":"一两句话的整体结论","turningPoint":"本局最关键的一次转折：第几分钟、怎么变的、最可能的原因","winnerWhy":["…"],"loserWhy":["…"],"pathToWin":["…"],"dimensions":[{"dimension":"对线","text":"…"}]}',
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

/** 某一刻的读数（建筑倒塌时挂在那一行上）。 */
function leadText(lead: AnalysisLead): string {
	return `当时天辉经济 ${signed(lead.networthLead)} / 经验 ${signed(lead.experienceLead)} / 胜率 ${pct(lead.winRate)}`;
}

// ---------------------------------------------------------------- 用户提示词

function renderTeam(rows: MatchAnalysisInput['players']): string {
	return rows
		.map((row) => {
			const imp = row.imp === null ? '' : ` / IMP ${row.imp.toFixed(1)}`;
			const items = row.items.length > 0 ? `\n  装备：${row.items.join('、')}` : '';
			// 成型件的**时间**单独一行：出装顺序说明打法窗口（先 BKB 还是先跳刀、几十分钟才敢接团）。
			const keyItems = row.keyItems.length > 0 ? `\n  关键道具：${row.keyItems.map((item) => `${item.name} ${formatElapsed(item.time)}`).join('、')}` : '';
			// 号位与分路是复盘的关键背景：谁该做视野、谁该带线、谁对线被压在哪儿，都要靠它定位。
			return `- ${row.position} · ${row.lane} · ${row.hero}（${row.name}）：${row.kills}/${row.deaths}/${row.assists}，经济 ${num(row.networth)}（GPM ${row.gpm} / XPM ${row.xpm}），等级 ${row.level}，正补 ${row.lastHits} / 反补 ${row.denies}，对英雄伤害 ${num(row.heroDamage)} / 对建筑伤害 ${num(row.towerDamage)} / 治疗 ${num(row.heroHealing)}${imp}${items}${keyItems}`;
		})
		.join('\n');
}

/** 打法那一段：把回放里聚合出来的事件摆成几行，时间用 `mm:ss`。 */
function renderPlayback(playback: PlaybackSummary): string {
	const lines: string[] = [
		`打法（来自逐秒位置的回放数据，每 ${playback.stepSeconds} 秒采样一次，共 ${num(playback.heroSamples)} 个位置点）：`,
	];
	if (playback.events.length === 0) {
		lines.push('- 这一段里没有出现明显的集结或交战（十个人始终比较分散）。');
	} else {
		lines.push(
			...playback.events.map((event) => {
				const range = `${formatElapsed(event.from)}–${formatElapsed(event.to)}`;
				if (event.kind === 'fight') return `- ${range} 双方在「${event.region}」撞上（天辉 ${event.heroes} 人 / 夜魇 ${event.foeHeroes} 人）`;
				return `- ${range} ${event.side} ${event.heroes} 人聚在「${event.region}」（对面这一带只有 ${event.foeHeroes} 人）`;
			}),
		);
	}
	if (playback.roshan.length > 0) {
		lines.push(
			`肉山位置采样（**不是击杀时间**，只能当「他这段时间还在这个坑」看）：${playback.roshan
				.map((window) => `${window.pit} ${formatElapsed(window.from)}–${formatElapsed(window.to)}`)
				.join('；')}`,
		);
	}
	if (playback.wards.length > 0) {
		lines.push(
			'插眼落点（按区域；进攻视野还是自家野区，看这一行）：',
			...['天辉', '夜魇'].map((side) => {
				const rows = playback.wards.filter((ward) => ward.side === side);
				return `- ${side}：${rows.length > 0 ? rows.map((row) => `${row.region} ${row.count} 只`).join('、') : '无记录'}`;
			}),
		);
	}
	return lines.join('\n');
}

/**
 * 一局的账单。分块摆：结果 → 三路 → 建筑 → 曲线 → 十个人 → 视野 → 口径。
 *
 * 每一块只在有数据时出现（眼位、曲线都是「有录像才有」），**不给模型留空位**——
 * 空着的字段它会拿"据说这局打了 60 分钟"这类印象来填。
 */
export function buildAnalysisUserPrompt(input: MatchAnalysisInput, playback?: PlaybackSummary | null): string {
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
			'建筑倒塌时间轴（`被拆方` 是倒了的那一边；后面那半句是那一刻的曲线读数）：',
			...input.falls.map(
				(fall) =>
					`- ${formatElapsed(fall.time)} 被拆方 ${fall.by} · ${fall.label} · 补刀 ${fall.attacker}${fall.lead ? ` · ${leadText(fall.lead)}` : ''}`,
			),
		);
	}

	if (input.curve) {
		const { timeline, peak, trough, swing, segments } = input.curve;
		lines.push('', '经济与经验（天辉视角：正数 = 天辉领先）：', ...timeline.map((point) => `- ${moment(point)}`));
		lines.push(
			`- 天辉最大领先：${moment(peak)}`,
			`- 天辉最大落后：${moment(trough)}`,
			swing ? `- 单分钟最大变化：${swing.minute} 分钟 经济 ${signed(swing.delta)}（正数 = 天辉这一分钟拉开，负数 = 被追回）` : '',
		);
		if (segments.length > 0) {
			lines.push(
				'',
				'每 10 分钟的净变化（天辉视角；哪一段被拉爆，看的就是这一段）：',
				...segments.map(
					(segment) => `- ${segment.from}–${segment.to} 分钟：经济 ${signed(segment.networthDelta)} / 经验 ${signed(segment.experienceDelta)}`,
				),
			);
		}
	}

	lines.push(
		'',
		'两队合计（横向对照用）：',
		...input.totals.map(
			(total) =>
				`- ${total.side}（${names[total.side]}）：击杀 ${total.kills} / 死亡 ${total.deaths} / 助攻 ${total.assists}，总经济 ${num(total.networth)}，对英雄伤害 ${num(total.heroDamage)}，对建筑伤害 ${num(total.towerDamage)}，治疗 ${num(total.heroHealing)}，平均等级 ${total.avgLevel.toFixed(1)}`,
		),
		'',
		'十名选手（天辉在前、同队按经济从高到低；行首是号位与分路）：',
		'天辉：',
		renderTeam(radiantRows),
		'夜魇：',
		renderTeam(direRows),
	);

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

	// 打法那一段放在人数的后面：它回答的正是「这些人是怎么打起来的」，接在地图与账单之后最顺。
	if (playback) lines.push('', renderPlayback(playback));

	lines.push('', '口径与限制：', '- 数据来自 STRATZ 已解析的公开对局，胜负与全部数字都以它为准，不要另行推断。');
	lines.push('- 物品只给了「成型件的购买时间」，没有逐次击杀与施法的时间点；要归因请用曲线拐点、建筑时间轴、出装时间与人员数据，归不了就明说。');
	if (playback) {
		lines.push(
			'- 轨迹能看出「谁在哪一段时间聚到了哪一带」，但**没有击杀与施法事件**：谁先手、谁被秒、交了什么技能，这份数据都答不了，不要编。',
		);
	} else {
		lines.push('- 这一局没有回放轨迹数据（STRATZ 只对下载过录像的近期对局提供），打法只能从建筑时间轴与人员数据反推，不要编出具体的位置与时间点。');
	}
	if (!input.curve) lines.push('- 这一局没有逐分钟曲线，节奏与转折只能从建筑时间轴和选手数据判断，不要编造时间点。');
	if (!input.wards) lines.push('- 这一局没有眼位数据（未下载录像），视野这一角直接跳过，不要编。');

	return lines.filter((line) => line !== '').join('\n');
}

export function buildAnalysisMessages(input: MatchAnalysisInput, playback?: PlaybackSummary | null): PromptMessage[] {
	return [
		{ role: 'system', content: buildAnalysisSystemPrompt() },
		{ role: 'user', content: buildAnalysisUserPrompt(input, playback) },
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
	/** 本局最关键的一次转折：第几分钟、怎么变的、最可能的原因。数据不足时模型会说明。 */
	turningPoint: string;
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
	const turningPoint = typeof body.turningPoint === 'string' ? body.turningPoint.trim().slice(0, 600) : '';
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
	return { headline, turningPoint, winnerWhy, loserWhy, pathToWin, dimensions };
}
