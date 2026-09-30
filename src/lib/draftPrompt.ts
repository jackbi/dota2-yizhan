/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/draftPrompt.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。
 */
import type { DraftData, DraftHero } from './draftData.ts';
import type { Advice } from './draftScore.ts';
import type { RecordedHand } from './draftOrder.ts';
import { CM_STEPS, sideOfOwner } from './draftOrder.ts';
import type { DraftSide } from './draftOrder.ts';
import type { FoeForm } from './draftFoe.ts';
import { foeHighlights, foeRecordLine, foeWinRate } from './draftFoe.ts';
import type { RosterProfile } from './teamSignature.ts';
import { signatureScopeLabel } from './teamSignature.ts';
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
	/**
	 * 两边的名单招牌（按版本统计）。按**实际阵营**给，与 `advise` 的入参同一份，
	 * 提示词里的人称由 `role` 与 `ourSide` 一起决定。
	 */
	signatures?: { radiant?: RosterProfile | null; dire?: RosterProfile | null } | null;
	/**
	 * 两边**近期的真实 BP**（`/api/draft/foe` 那份）。这是"别光靠算法"的核心输入：
	 * 它带着"他们自己禁什么""对手禁他们什么""拿这个英雄平均在第几手"。
	 */
	forms?: { radiant?: FoeForm | null; dire?: FoeForm | null } | null;
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
	return `${main}\n\n（以下 ${input.advice.foeCandidates.length} 个是${whose}近期真拿过、或名单里的招牌英雄，没排进上面的顺序，同样可以挑）：\n${list(input.advice.foeCandidates)}`;
}

/**
 * 两边的**名单招牌**：这几个人本来最常拿什么。
 *
 * 与 `renderFoe`（近 30 天实战窗口）刻意分开成两块，理由和打分层一样：一个是"最近在拿什么"，
 * 一个是"这个人本来就是这一手"。合成一段的话，模型会把两批数据当成同一份证据，
 * 写出"他们近期拿了 3 场"这种把招牌算进窗口的话。
 */
/**
 * 一支队的名单画像：**按号位列**，写清这个位置是谁在打、他本版本拿这几个英雄打过多少场。
 *
 * 拆到号位是这一块的关键：BP 里问的不是"这支队爱用什么"，而是"**他们的二号位会拿什么**"。
 * 合成一份的时候，把三号位的招牌算到二号位头上是看不出来的，模型也就没有依据去判断
 * "这一手像不像他们"。
 */
function renderRosterLines(profile: RosterProfile | null | undefined, label: string, data: DraftData): string {
	if (!profile) return '';
	const byId = new Map(data.heroes.map((hero) => [hero.id, hero]));
	const heroText = (hero: { heroId: number; games: number; wins: number }): string => {
		const info = byId.get(hero.heroId);
		const name = info ? `${info.name}（${info.nameEn}）` : `英雄 #${hero.heroId}`;
		return `heroId=${hero.heroId} ${name} ${hero.games} 场 ${hero.wins} 胜`;
	};
	const head = `${label}${profile.name ? `（${profile.name}）` : ''}的名单英雄池：`;
	const rows: string[] = [];
	// `?? []`：手写的调用方可能只给了不分号位的那份（没有 positions），这时退回下面那条。
	for (const pool of profile.positions ?? []) {
		const scope = signatureScopeLabel(pool.scope || profile.scope);
		const who = pool.players.length > 0 ? pool.players.join('、') : '名单里的人';
		rows.push(`- ${pool.position} 号位 ${who}${scope ? `（${scope}）` : ''}：${pool.heroes.map(heroText).join('；')}`);
	}
	if (rows.length === 0) {
		const scope = signatureScopeLabel(profile.scope);
		rows.push(`- 名单里没有号位信息${scope ? `（${scope}）` : ''}：${profile.heroes.map(heroText).join('；')}`);
	}
	return [head, ...rows].join('\n');
}

function renderSignatures(input: PromptInput, role: PromptRole): string {
	const radiant = input.ourSide === 'radiant';
	/*
	 * 人称：给我方出主意时（`ours`）"我方/对面"就是字面意思；替对面落子时
	 * （`theirs`）整段是从它自己的视角读的，所以它那一半写"你自己"。
	 */
	const ourLabel = role === 'theirs' ? '屏幕前的人' : '我方';
	const theirLabel = role === 'theirs' ? '你自己' : '对面';
	const first = renderRosterLines(input.signatures?.[input.ourSide], ourLabel, input.data);
	const second = renderRosterLines(input.signatures?.[radiant ? 'dire' : 'radiant'], theirLabel, input.data);
	return [first, second].filter(Boolean).join('\n');
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
 * 统计窗口是「上一个完整统计周」（上游按纪元对齐的 7 天桶切，见 `metaWindow.ts` 与
 * `docs/data-sources.md`）。如果新版本正好落在那个窗口里，胜率是新旧两个版本混算的，
 * 拿它当"当前版本强度"会看偏。宁可让建议显得保守，也不要让它把混算的数字当成结论。
 */
function renderPatch(data: DraftData): string {
	const { version, date, straddles } = data.patch;
	if (!version) return '';
	const base = `版本 ${version}${date ? `（${date} 发布）` : ''}。`;
	if (!straddles) return base;
	return `${base}注意：${data.windowLabel}的样本里跨了这次版本更新，胜率混着旧版本的场次，别把版本改动本身当成选它的理由。`;
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
			'6. 「你自己名单英雄池」那一块同样是你熟的东西，但它按**号位**分：每个位置是谁在打、他拿过哪些英雄。',
			'   挑人时先在那个号位的池子里找补得上缺口的；禁用时对屏幕前的人**对应号位**的熟手要更警惕。',
			'   池子里确实没有合适的再挑外面的，但理由里要说清那不是他们的熟手。',
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
			'6. 还有一块是两边**按号位分的名单英雄池**：每个号位是谁在打、他本统计窗口拿哪几个英雄打过多少场。',
			'   它说的是"这个位置上的这个人本来就是这一手"，和上一条按队伍的近期窗口是两种证据，别混成一句话：',
			'   挑选时它说明我方拿这一手是顺手而不是临时练；禁用时它提高对面的威胁权重。',
			'   **必须对号位**：候选的依据里会写清是哪个号位上的谁，不要拿别的号位的招牌当成这一位的。',
			'   候选不在该号位池子里时，依据里会直接写出这点，你要在风险里照实说出来，别把它讲成他们的熟手。',
			'   一个人在不同统计窗口里的英雄会变，所以引用时把口径那一栏（版本号，或回退窗口那几个字）照抄出来。',
			'7. 用简体中文，不要客套话，不要标题和列表符号。',
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
	const signatures = renderSignatures(input, role);

	return [
		// 替对面落子时，数据是从对面的角度算的，先把人称交代清楚，免得模型把两方搞反。
		...(role === 'theirs' ? ['（以下数据是从你的角度算的：文中的"我方"指你自己，"对面"指坐在屏幕前的人。）'] : []),
		`对局：${ours} vs ${theirs}`,
		`当前：第 ${advice.step} 手，${turn}`,
		`我方还剩 ${advice.remaining.ours.bans} 禁 ${advice.remaining.ours.picks} 选；对方还剩 ${advice.remaining.theirs.bans} 禁 ${advice.remaining.theirs.picks} 选。`,
		`最后一手禁用归${advice.tail.ban === 'ours' ? '我方' : '对面'}，最后一手挑选归${advice.tail.pick === 'ours' ? '我方' : '对面'}。`,
		`版本与口径：${renderPatch(input.data)}${input.data.bracketLabel}，统计窗口是${input.data.windowLabel}，少于 ${input.data.minPositionMatches} 场的号位不算数。`,
		'',
		'我方阵容现状：',
		renderLineup(input),
		input.advice.composition.text,
		'',
		'已经录进去的 BP：',
		renderRecorded(input),
		...(foe ? ['', foe] : []),
		...(signatures ? ['', signatures] : []),
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
	/**
	 * 请求形状，按服务商给（见 `aiProviders.shapeFor`）。不传就是下面那套最保守的默认值。
	 *
	 * 「被 400 拒掉」那条退让路径在调用方（`draftBoard` 的 `requestChat`）：它是一步步去掉
	 * `response_format` 与 `temperature`，而不是换一家的形状。
	 */
	shape?: ChatShape;
}

/**
 * 请求形状：各服务商认的字段不一样，把差异收成三个开关。
 *
 * 默认那套是**最保守**的：只发 OpenAI 兼容的基础字段，不发任何一家专有的东西——专有字段
 * 正是最容易被别家当未知参数拒掉的。具体谁用哪套见 `aiProviders` 的表（那里的值有实测依据）。
 */
export interface ChatShape {
	/** 要不要发 DeepSeek 那套 `thinking: { type: 'disabled' }`。 */
	thinking: boolean;
	/** 输出上限写在哪个字段上。OpenAI 与 Grok 的新模型已经不认 `max_tokens`。 */
	maxTokensField: 'max_tokens' | 'max_completion_tokens';
	/** 发不发 `temperature`。部分推理模型只接受默认值，传了会被 400 拒掉。 */
	temperature: boolean;
}

export const DEFAULT_CHAT_SHAPE: ChatShape = { thinking: false, maxTokensField: 'max_tokens', temperature: true };

/**
 * 组装 `chat/completions` 请求体。
 *
 * DeepSeek 那一家**必须显式关掉思考**（形状里的 `thinking`）。这不是调优，是不关就没有结果：
 * `deepseek-flash` 默认开着思考，实测同样一条提示词下 900 的 token 上限全被 `reasoning_tokens`
 * 吃光，`content` 是空的（`finish_reason: length`）；把上限提到 4000 也一样空，耗时 21 秒。
 * 关掉之后 1.8 秒返回 288 个 token 的正常 JSON。
 */
export function buildChatRequest(options: ChatRequestOptions): Record<string, unknown> {
	const shape = options.shape ?? DEFAULT_CHAT_SHAPE;
	return {
		model: options.model,
		messages: options.messages,
		...(shape.temperature ? { temperature: 0.3 } : {}),
		[shape.maxTokensField]: options.maxTokens ?? ADVICE_MAX_TOKENS,
		...(options.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
		...(shape.thinking ? { thinking: { type: 'disabled' } } : {}),
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

// ---------------------------------------------------------------- 整局 BP 预测

/**
 * 「AI 预测」这条路的提示词。
 *
 * 与出主意那份的根本区别：这里**没有下一手**，也不要求它从候选里挑——预测的是这两支队
 * 大概会怎么禁选。所以约束换成"英雄必须是真实存在的、两边加起来不许重复、每边五手挑选"，
 * 这几条都是可以在解析层核对的（见 `parsePredictionReply`）。
 *
 * **不让模型排 24 手的顺序**：没有真实 BP 记录时那个顺序就是编的，而且一手一问要 24 次请求。
 * 它只给"两边各禁什么、各选什么"和一整段理由，顺序那部分交给本地打分层去推（`draftPredict`）。
 */
export interface PredictionPromptInput {
	data: DraftData;
	/** 两边的队名；空串时界面上写「天辉 / 夜魇」。 */
	radiantTeam: string;
	direTeam: string;
	/** 先选方所在的阵营。 */
	firstPicker: DraftSide;
	signatures?: { radiant?: RosterProfile | null; dire?: RosterProfile | null } | null;
}

/** 每号位在提示词里列几个热门。列多了模型挑花眼，列少了又没有参考价值。 */
const META_TOP_PER_POSITION = 5;

/**
 * 一支队最近的正式比赛 BP，小写成给模型看的几行。
 *
 * 三样东西分开列，因为它们回答的问题不同，混在一起模型就会把"他们怕什么"当成"他们爱用什么"：
 * - **他们拿过**：英雄 + 场次 + 平均第几手拿的。手号是判断"一手抢合不合理"的依据；
 * - **他们自己禁过**：预测他们禁什么用它；
 * - **被对手禁得多**：这个英雄轮不轮得到他们手上，用它判断（禁得比拿得多说明很难拿到）。
 *
 * 不写"他们爱打团"这类判断：这份数据是一支队的几十场比赛，不是战术报告。
 */
function renderRealDraft(form: FoeForm | null | undefined, label: string, data: DraftData): string {
	if (!form || form.matches === 0) return '';
	const byId = new Map(data.heroes.map((hero) => [hero.id, hero]));
	const name = (heroId: number): string => {
		const info = byId.get(heroId);
		return info ? `${info.name}（heroId=${heroId}）` : `heroId=${heroId}`;
	};
	const picked = form.heroes.filter((hero) => hero.picks > 0).slice(0, 8);
	const banned = form.heroes.filter((hero) => hero.bansBy > 0).sort((a, b) => b.bansBy - a.bansBy).slice(0, 6);
	const contested = form.heroes.filter((hero) => hero.bansAgainst > 0).sort((a, b) => b.bansAgainst - a.bansAgainst).slice(0, 6);
	// 窗口天数交给 `foeRecordLine` 拼（那是滚动窗口，写「近 N 天」是对的；这个文件里不许出现这种写法）。
	const lines: string[] = [`${label} ${form.name || ''} 的真实 BP（${foeRecordLine(form)}）：`];
	if (picked.length > 0) {
		lines.push(
			`- 他们拿过：${picked
				.map((hero) => `${name(hero.heroId)} ${hero.picks} 场${hero.decided > 0 ? ` ${hero.wins} 胜` : ''}${hero.averagePickOrder > 0 ? `（平均第 ${hero.averagePickOrder.toFixed(1)} 手拿）` : ''}`)
				.join('；')}`,
		);
	}
	if (banned.length > 0) lines.push(`- 他们自己禁过：${banned.map((hero) => `${name(hero.heroId)} ${hero.bansBy} 次`).join('；')}`);
	if (contested.length > 0) lines.push(`- 对手禁他们最多：${contested.map((hero) => `${name(hero.heroId)} ${hero.bansAgainst} 次`).join('；')}`);
	return lines.join('\n');
}

/**
 * 版本热门：**按号位**列胜率前几名。
 *
 * 只给结构化数字（胜率、场次），不给"这个版本强"的判断——那正是提示词里反复要模型别编的东西。
 * 职业样本单独一行：它样本小，只能当"最近职业队爱拿什么"的旁证。
 */
function renderMeta(data: DraftData): string {
	const lines: string[] = [];
	for (let position = 1; position <= 5; position += 1) {
		const rows = data.heroes
			.map((hero) => ({ hero, cell: hero.positions[position - 1] }))
			.filter((row): row is { hero: DraftHero; cell: [number, number] } => row.cell !== null)
			.map((row) => ({ ...row, rate: row.cell[1] / row.cell[0] }))
			.sort((a, b) => b.rate - a.rate || b.cell[0] - a.cell[0])
			.slice(0, META_TOP_PER_POSITION);
		if (rows.length === 0) continue;
		lines.push(
			`${position} 号位：${rows
				.map((row) => `${row.hero.name}(id=${row.hero.id}) ${(row.rate * 100).toFixed(1)}%/${row.cell[0]} 场`)
				.join('，')}`,
		);
	}
	const hot = [...data.heroes]
		.filter((hero) => hero.pro[0] + hero.pro[2] > 0)
		.sort((a, b) => b.pro[0] + b.pro[2] - (a.pro[0] + a.pro[2]))
		.slice(0, 8);
	if (hot.length > 0) {
		lines.push(
			`职业样本热门：${hot.map((hero) => `${hero.name}(id=${hero.id}) 出场 ${hero.pro[0]} 被禁 ${hero.pro[2]}`).join('，')}`,
		);
	}
	return lines.join('\n');
}

export function buildPredictionSystemPrompt(): string {
	return [
		'你是 DOTA2 职业赛事的 BP 分析师。用户给你两支队伍、先选方与站内的英雄数据，',
		'你要预测这两支队在这局里大概会怎么禁选。',
		'',
		'规则背景：7.40 起一共 24 手，每队 7 禁 5 选，先选方与后选方交替；后选方握着最后一手禁用和最后一手挑选。',
		'',
		'你必须遵守：',
		'1. 每一边给 5 个挑选、不超过 7 个禁用；heroId 必须是用户给出的数据里出现过的数字。',
		'2. **每一个挑选都要给 position（1 到 5）**，也就是它被拿在几号位；每边的五个挑选要刚好占满 1 到 5。',
		'3. **顺序是"先定禁用、再从剩下的人里定挑选"**，因为一个英雄一局只能出现一次：',
		'   ① 先把两边一共 14 条禁用写出来（先选方 7 条、后选方 7 条），把对面还没拿到的熟手掐掉；',
		'   ② 然后两边的挑选**只能从没有被任何一方禁掉的英雄里挑**。',
		'   最常见的错法是把"对面禁掉 X"和"对面拿着 X"同时写进答案（实测反复出现）：',
		'   X 被禁了就轮不到任何人拿它。**交答案之前自查**：把两边的 bans 与 picks 列成一张表，',
		'   10 个挑选 + 14 条禁用 = 24 个 heroId，必须互不相同，有重复就换掉那一条。',
		'4. 用户会给两支队**每个号位是谁、他本版本拿哪几个英雄打过多少场**。这是预测的主依据：',
		'   **挑选先在那个号位的池子里挑，而且只能挑没有被禁掉的那个**（被禁掉的英雄谁也拿不到）；',
		'   池子里剩下的挑最强的就行；只有池子里的英雄都已经被禁/被选，',
		'   或者那个号位本来就没有记录时，才到池子外挑，并在理由里说清"他本窗口没打过它"。',
		'   不要在池子里一个都没试过的情况下直接跳到版本强势——那样预测出来的是全服阵容，不是这两支队。',
		'5. 禁用同样按人：**优先掐对面该号位选手的熟手**（依据写得出场次的那几个），其次是版本高胜率点。',
		'   被你这么掐掉的英雄，对面挑选时就用不上了——所以对面那 5 个挑选要从"没被禁掉"的池子里出。',
		'   先选的队伍优先拿自己最缺的号位。',
		'   他们**自己最近真的禁过**的那几个英雄（见"他们自己禁过"那一行）优先当作他们要禁的对象。',
		'6. **尊重出手时机与可及性**（这一条最容易被算法忽略，也是真人一眼就能看出错的地方）：',
		'   - 每个"他们拿过"的英雄后面写着**平均第几手拿**。拿着平均第 18 手才拿的英雄当第一手（第 8 手）',
		'     是错的——那种英雄（例如幻影长矛手这类被抓就死的核）一亮出来就被针对。前几手要拿那些',
		'     平均手号就靠前的英雄。反过来，平均在很后面拿的英雄，留到最后的挑选才对。',
		'   - "对手禁他们最多"那一行说明这个英雄**很难轮到他手上**：被禁的次数接近甚至超过他拿的次数时，',
		'     不要安排他早早拿，要按"这一手很可能已经被对面禁掉"来写。',
		'   - 每一条挑选的理由里，除了位置与熟手，尽量带上手号或"被禁次数"这类能核对的依据。',
		'7. 理由里的数字只能来自用户给出的字段（号位胜率与场次、职业出场与被禁、每个号位选手的场次与胜率、',
		'   真实 BP 里的场次/手号/被禁次数）。',
		'   这些数据之外的版本强弱、选手风格、历史战绩你都不知道，绝对不要编造。',
		'8. 每条理由不超过一句，用简体中文，不要客套话。',
		'',
		'只输出一个 JSON 对象，不要代码块标记，不要多余解释，格式如下：',
		'{"radiant":{"bans":[{"heroId":1,"reason":"…"}],"picks":[{"heroId":2,"position":2,"reason":"…"}]},',
		'"dire":{"bans":[{"heroId":3,"reason":"…"}],"picks":[{"heroId":4,"position":3,"reason":"…"}]},"summary":"…"}',
	].join('\n');
}

export function buildPredictionUserPrompt(input: PredictionPromptInput): string {
	const radiant = input.radiantTeam.trim() || '天辉';
	const dire = input.direTeam.trim() || '夜魇';
	const first = input.firstPicker === 'radiant' ? `${radiant}（天辉）` : `${dire}（夜魇）`;
	const meta = renderMeta(input.data);
	const signatures = [
		renderRosterLines(input.signatures?.radiant, '天辉', input.data),
		renderRosterLines(input.signatures?.dire, '夜魇', input.data),
	].filter(Boolean);
	const forms = [
		renderRealDraft(input.forms?.radiant, '天辉', input.data),
		renderRealDraft(input.forms?.dire, '夜魇', input.data),
	].filter(Boolean);

	return [
		`对局：天辉 ${radiant} vs 夜魇 ${dire}，先选方是 ${first}。`,
		`版本与口径：${renderPatch(input.data)}${input.data.bracketLabel}，统计窗口是${input.data.windowLabel}，少于 ${input.data.minPositionMatches} 场的号位不算数。`,
		'',
		'各号位胜率前几名（胜率/场次）：',
		meta,
		...(signatures.length > 0 ? ['', '两边的名单英雄池（按号位分，写清是谁在打；都是真实对局统计）：', ...signatures] : []),
		...(forms.length > 0 ? ['', '两边**最近的正式比赛真实 BP**（这一节比上面的胜率更重要，挑人要贴合它）：', ...forms] : []),
		'',
		'请给出天辉与夜魇各自的 ban 与 pick（每个挑选都带 position），以及一段整体预测说明。',
	].join('\n');
}

export function buildPredictionMessages(input: PredictionPromptInput): PromptMessage[] {
	return [
		{ role: 'system', content: buildPredictionSystemPrompt() },
		{ role: 'user', content: buildPredictionUserPrompt(input) },
	];
}

/**
 * 预测要写两边共 20 来个英雄加上理由，比"给一手建议"长得多。上限给 2200：
 * 实测每条理由一两句话时整份约 800–1200 个 token，留一倍余量免得输出被截断。
 */
export const PREDICTION_MAX_TOKENS = 2200;

export interface ParsedPredictedSide {
	bans: { heroId: number; reason: string }[];
	picks: { heroId: number; position: number; reason: string }[];
}

export interface ParsedPrediction {
	radiant: ParsedPredictedSide;
	dire: ParsedPredictedSide;
	summary: string;
	/**
	 * 因为"与挑选冲突"被丢掉的禁用条数。
	 *
	 * 模型偶尔会写出"一边禁掉它、另一边又选它"这种不合法的组合（实测过一次：米拉娜同时进了
	 * 天辉的禁用与挑选）。这种时候丢掉的是**禁用**（见 `parsePredictionReply` 的顺序说明），
	 * 并把丢掉的条数带出来，界面照实说明——不能让读者以为模型的禁用就只有这么几条。
	 */
	droppedBans: number;
}

/**
 * 解析结果。**失败也要说清是哪一条不过**，因为调用方（页面）现在只写一句"模型的回复解析不了"，
 * 用户看到的是一句没有信息量的提示——他没法判断该改配置、重试，还是等我们改提示词。
 *
 * 实测这件事是**间歇**的：同一条提示词、同一个模型，这一把通过、下一把被拒，
 * 而"被拒"的原因有好几种（缺号位、两边撞了同一个英雄、挑选不足五个……）。
 */
export type PredictionParseResult =
	| { ok: true; prediction: ParsedPrediction }
	| { ok: false; reason: string };

/** 一边最多能禁几个（7 手），解析时按它设上限。 */
const MAX_PREDICTED_BANS = 7;
const PREDICTED_PICKS = 5;

/** 把一边的原始对象与其中的数组收成好读的形状。 */
function sideOf(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function rowsOf(value: unknown): Record<string, unknown>[] {
	return (Array.isArray(value) ? value : []).filter(
		(item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
	);
}

/**
 * 读一边的**挑选**。每个挑选都要带号位，且五个号位恰好占满 1–5。
 *
 * `taken` 是两边共用的集合，先读到的先占位——所以"两边选中同一个英雄"这种回复会在读第二边时
 * 被丢掉，凑不满五个挑选就整份作废（一个英雄不可能同时在两边）。
 */
function readPicks(
	raw: Record<string, unknown>,
	allowed: ReadonlySet<number>,
	taken: Set<number>,
	who: string,
): { picks: ParsedPredictedSide['picks'] } | { reason: string } {
	const picks: ParsedPredictedSide['picks'] = [];
	let droppedPosition = 0;
	let droppedUnknown = 0;
	let droppedTaken = 0;
	for (const row of rowsOf(raw.picks)) {
		if (picks.length >= PREDICTED_PICKS) break;
		const position = Number(row.position);
		/*
		 * 号位是硬要求：界面上要写"这个人在这个位置上会不会它"，没有号位就写不出来
		 * ——那正是上一版被一眼看出来的问题（"二号位的天穹守望者"）。
		 */
		if (!Number.isInteger(position) || position < 1 || position > 5) {
			droppedPosition += 1;
			continue;
		}
		const heroId = Number(row.heroId);
		if (!Number.isInteger(heroId) || !allowed.has(heroId)) {
			droppedUnknown += 1;
			continue;
		}
		if (taken.has(heroId)) {
			droppedTaken += 1;
			continue;
		}
		taken.add(heroId);
		picks.push({ heroId, position, reason: typeof row.reason === 'string' ? row.reason.trim().slice(0, 200) : '' });
	}
	// 每边五个挑选是规则，少一个就不是一局 BP 了。
	if (picks.length < PREDICTED_PICKS) {
		const why = [
			droppedPosition > 0 ? `${droppedPosition} 条号位缺失或不在 1–5` : '',
			droppedUnknown > 0 ? `${droppedUnknown} 条英雄不在我们的数据里` : '',
			droppedTaken > 0 ? `${droppedTaken} 条与另一边的挑选撞了同一个英雄` : '',
		].filter(Boolean);
		return {
			reason: `${who}的挑选凑不满五个（只认出 ${picks.length} 个）${why.length > 0 ? `：${why.join('、')}` : '：它给的 picks 本来就不够'}`,
		};
	}
	// 五个挑选要**刚好占满 1 到 5**：两个人都算二号位、一号位没人，那不是一局阵容。
	if (new Set(picks.map((pick) => pick.position)).size !== PREDICTED_PICKS) {
		return { reason: `${who}五个挑选的号位没有占满 1 到 5（给的是 ${picks.map((pick) => pick.position).join('、')}）` };
	}
	return { picks };
}

/**
 * 读一边的**禁用**：与已经占位的英雄冲突（对面或自己选走了、对面禁过了）就丢掉那一条。
 *
 * 丢的是禁用而不是挑选，这是实测逼出来的顺序：真实的一次 DeepSeek 回复把"每边禁对面熟手、
 * 每边拿自己熟手"写成了两份独立清单，同一个英雄既被禁又被选。挑选是这份预测的主体、
 * 禁用只是背景，而禁用本来就允许少于 7 条，所以这里保住挑选、丢掉冲突的禁用，并把条数带出去。
 */
function readBans(raw: Record<string, unknown>, allowed: ReadonlySet<number>, taken: Set<number>): { bans: ParsedPredictedSide['bans']; dropped: number } {
	const bans: ParsedPredictedSide['bans'] = [];
	let dropped = 0;
	for (const row of rowsOf(raw.bans)) {
		if (bans.length >= MAX_PREDICTED_BANS) break;
		const heroId = Number(row.heroId);
		if (!Number.isInteger(heroId) || !allowed.has(heroId) || taken.has(heroId)) {
			// 编出来的英雄不算"因冲突被丢"，那种本来就该消失，数到对账里只会误导。
			if (Number.isInteger(heroId) && allowed.has(heroId)) dropped += 1;
			continue;
		}
		taken.add(heroId);
		bans.push({ heroId, reason: typeof row.reason === 'string' ? row.reason.trim().slice(0, 200) : '' });
	}
	return { bans, dropped };
}

/**
 * 解析预测回复。任何一步不对都返回 null：调用方退回本地推演，
 * 而不是把半截结果摆到界面上（预测这一块最容易让读者当成事实）。
 */
export function parsePredictionReplyDetailed(raw: string, allowedHeroIds: readonly number[]): PredictionParseResult {
	if (!raw || !raw.trim()) return { ok: false, reason: '模型返回了空内容' };
	const withoutFence = raw.replace(/```(?:json)?/gi, '');
	const start = withoutFence.indexOf('{');
	const end = withoutFence.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return { ok: false, reason: `回复里找不到 JSON 对象（前 80 个字：${raw.trim().slice(0, 80)}）` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutFence.slice(start, end + 1));
	} catch (error) {
		return { ok: false, reason: `JSON 没解析成功（${error instanceof Error ? error.message.slice(0, 80) : '格式错误'}）` };
	}
	if (!parsed || typeof parsed !== 'object') return { ok: false, reason: '回复不是一个 JSON 对象' };

	const allowed = new Set(allowedHeroIds);
	const taken = new Set<number>();
	const body = parsed as { radiant?: unknown; dire?: unknown; summary?: unknown };
	const radiantRaw = sideOf(body.radiant);
	const direRaw = sideOf(body.dire);
	/*
	 * **先把两边的挑选都读完，再读禁用。**
	 *
	 * `taken` 是先到先得，所以顺序决定了冲突时保住谁。挑选是这份预测的主体（界面上一张卡
	 * 一个号位、一条理由），禁用只是背景，所以挑选必须先占位：一边禁掉、另一边选中的英雄，
	 * 结果应该是"禁用那条被丢掉"，而不是"挑选消失、整份预测作废"。
	 */
	const radiantPicks = readPicks(radiantRaw, allowed, taken, '天辉');
	const direPicks = readPicks(direRaw, allowed, taken, '夜魇');
	// 哪一边先不合格就报哪一边：两边都报会让人以为是两个问题。
	if ('reason' in radiantPicks) return { ok: false, reason: radiantPicks.reason };
	if ('reason' in direPicks) return { ok: false, reason: direPicks.reason };
	const radiantBans = readBans(radiantRaw, allowed, taken);
	const direBans = readBans(direRaw, allowed, taken);
	// 两边一条禁用都没有，说明模型没按格式来（或全被冲突吃掉）——这种不算预测。
	if (radiantBans.bans.length + direBans.bans.length === 0) {
		return { ok: false, reason: '两边一条禁用都没给（或者给的禁用全与挑选撞了同一个英雄）' };
	}
	const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 600) : '';
	return {
		ok: true,
		prediction: {
			radiant: { bans: radiantBans.bans, picks: radiantPicks.picks },
			dire: { bans: direBans.bans, picks: direPicks.picks },
			summary,
			droppedBans: radiantBans.dropped + direBans.dropped,
		},
	};
}

/** 只关心"能不能用"的调用方用这个；要说明为什么不能用就用 `parsePredictionReplyDetailed`。 */
export function parsePredictionReply(raw: string, allowedHeroIds: readonly number[]): ParsedPrediction | null {
	const result = parsePredictionReplyDetailed(raw, allowedHeroIds);
	return result.ok ? result.prediction : null;
}
