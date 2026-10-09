/*
 * 相对导入带 `.ts` 后缀：这些模块要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { DraftData } from '../lib/draftData.ts';
import { ATTRIBUTE_ICON } from '../lib/heroApi';
import {
	ADVICE_TARGET_COUNT,
	ADVICE_MAX_TOKENS,
	PREDICTION_MAX_TOKENS,
	buildAdviceMessages,
	buildPredictionMessages,
	parsePredictionReplyDetailed,
	buildVerdictMessages,
	parseAdviceReply,
	parseVerdictReply,
	VERDICT_MAX_TOKENS,
} from '../lib/draftPrompt.ts';
import type { AiConfig } from '../lib/aiConfig.ts';
import { AI_STORE_KEY, aiStateLabel, isConfigured, loadAiConfig, sameAiConfig, sameAiTarget } from '../lib/aiConfig.ts';
import { chatErrorMessage, requestChat } from '../lib/aiChat.ts';
import { adviceNarrative, opponentMoveReason } from '../lib/draftNarrative.ts';
import type { Advice, AdviceCandidate } from '../lib/draftScore.ts';
import { advise } from '../lib/draftScore.ts';
import type { DraftVerdict } from '../lib/draftVerdict.ts';
import { buildVerdict } from '../lib/draftVerdict.ts';
import type { DraftSide } from '../lib/draftOrder.ts';
import { CM_PHASE_STARTS, CM_STEPS, canPlay, otherSide, play, sideOfOwner, skip, snapshot, undo } from '../lib/draftOrder.ts';
import type { FoeForm } from '../lib/draftFoe.ts';
import { MIN_PICKS, foeHeadline, foeHeroOf, foeHighlights, foeWinRate } from '../lib/draftFoe.ts';
import type { DraftPrediction, PredictedSide } from '../lib/draftPredict.ts';
import { mergeBans, predictDraftLocal, predictionHands } from '../lib/draftPredict.ts';
import type { RosterProfile } from '../lib/teamSignature.ts';
import { buildRosterProfile, rosterPoolOf, signatureScopeLabel } from '../lib/teamSignature.ts';
import type { LaneData } from '../lib/draftLanes.ts';
import { formatNet } from '../lib/draftLanes.ts';

/**
 * 阵容分析页的客户端：预测、对抗、复盘三块共用一份状态。
 *
 * 有两条边界写在这里而不是服务端：
 * - **模型的 key 只存在这台浏览器**（localStorage），请求由浏览器直接发给用户自己填的地址，
 *   站点不经手。这也是这个功能能开源的前提：别人 clone 之后用自己的 key，作者不承担费用。
 *   配置的形状与读写都在 `lib/aiConfig.ts`，设置页是 `/settings`。
 * - **建议与预测的排序不依赖模型**。候选、号位、胜率、样本量都是本地算的（`draftScore`、
 *   `draftPredict`），模型只能在这些结果上排个序、写段解释。它挂了、没配、key 无效、余额不足，
 *   数据面板照常可用，文字那一段由 `draftNarrative` 用本地依据补上。
 *
 * 队伍这一侧有个刻意的选择：**页面上的选择框是服务端渲染的**，浏览器只从 `/draft-teams.json`
 * 取队标、名单与招牌英雄。所以脚本晚到不会让人选不了队，队名也**不再需要用户手打**——
 * 以前那行文本框要求先知道队名的写法，输错一个字符既不报错、也拿不到对面那半数据。
 *
 * DOM 只建一次：英雄池 127 个格子、两边各 12 个 BP 格子先建好，状态变化时改属性而不是
 * 重建节点。重建会让浏览器反复解码头像，点起来一顿一顿的。
 */

const STORE_KEY = 'd2s-draft-v1';
const ATTR_LABEL: Record<string, string> = { STR: '力量', AGI: '敏捷', INT: '智力', UNI: '全才' };
const ATTR_ORDER = ['STR', 'AGI', 'INT', 'UNI'];

type TeamSide = DraftSide;
/** 三个功能。`workspace` 是它们的共用工作区（英雄池 + 板子），预测模式下整块收起来。 */
type Mode = 'predict' | 'versus' | 'lineup';

/**
 * `/draft-teams.json` 里的一支队。字段与 `lib/draftTeams.ts` 一一对应——
 * 那边是唯一的来源，这里只是声明浏览器看到什么。
 */
interface DraftTeamMember {
	nick: string;
	position?: number;
	scope: string;
	heroes: { heroId: number; games: number; wins: number }[];
}

interface DraftTeamEntry {
	id: string;
	name: string;
	logo?: string;
	odId: number | null;
	region: string;
	regionLabel: string;
	roster: DraftTeamMember[];
}

interface DraftTeamCatalog {
	sections: { key: string; label: string }[];
	teams: DraftTeamEntry[];
}

function element<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

/**
 * 拼 HTML 时的转义。模型的回复与队名要经过这一层再插进 DOM：提示词里带着用户选的队名，
 * 万一模型被带偏、吐出 `<img onerror=...>` 这样的字符串，直接用 innerHTML 就会执行。
 * 英雄名来自我们自己的构建产物，同样一并转义，少一处要记的例外。
 */
function esc(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readData(): DraftData | null {
	const raw = document.getElementById('draft-data')?.textContent ?? '';
	try {
		const parsed = JSON.parse(raw) as DraftData;
		return Array.isArray(parsed?.heroes) && parsed.heroes.length > 0 ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 页面内联的队伍目录。
 *
 * 与英雄数据一样是**构建期写进 HTML 的**，所以选中队伍之后立刻就能画出队标、名单与招牌英雄，
 * 不用等一次请求。以前这一份是单独取的静态文件，取不到时页面只会显示"未指定队伍"，
 * 和"真的没选队"完全一样——用户看不出是数据没到（实测被这么误解过）。
 */
function readTeams(): DraftTeamCatalog | null {
	const raw = document.getElementById('draft-teams')?.textContent ?? '';
	try {
		const parsed = JSON.parse(raw) as DraftTeamCatalog;
		return Array.isArray(parsed?.teams) ? parsed : null;
	} catch {
		return null;
	}
}

interface Stored {
	recorded?: (number | null)[];
	/** 先选方所在的阵营。 */
	firstPick?: string;
	mode?: string;
	/** 在这三种功能里都是"你这一边"：对抗时你打哪边，复盘时哪一边算我方。 */
	mySide?: string;
	/** 两边队伍的站内 id（`lp-team-...`），空串是未指定。 */
	radiantTeam?: string;
	direTeam?: string;
	/** 跳过 24 手 BP，两边各挑五个人。 */
	directRadiant?: number[];
	directDire?: number[];
	/**
	 * 老版本把 key 与模型名存在这里，现在搬去了 `d2s-ai-v1`（见 lib/aiConfig.ts 的迁移）。
	 * 声明留着只是为了让 `loadAiConfig` 读得到，这个文件自己不再写这两项。
	 */
	key?: string;
	model?: string;
	/** 用户对「对面交给 AI」的选择（默认是）。没配置模型时实际会被关掉。 */
	aiSide?: boolean;
	/** 上一版的字段：那时只有「我方/对方」两个文本框与「直接选阵容」一个开关。 */
	ourSide?: string;
	directOurs?: number[];
	directTheirs?: number[];
}

function loadStored(): Stored {
	try {
		return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Stored;
	} catch {
		return {};
	}
}

const data = readData();
const stored = loadStored();

if (data) {
	/**
	 * 收窄后的别名：`data` 是 `DraftData | null`，顶层的 `if (data)` 收窄**不会**带进
	 * `run()` 这个闭包里，所以以前在几个地方用 `draft` 硬压，漏掉一处就是编译错误
	 * （真实漏过一次：`explainWithModel` 里那一处）。这里一次性固定成非空类型，
	 * 下面一律用 `draft`，不再出现感叹号。
	 */
	const draft: DraftData = data;
	const heroById = new Map(data.heroes.map((hero) => [hero.id, hero]));

	const isSide = (value: unknown): value is TeamSide => value === 'radiant' || value === 'dire';
	const isMode = (value: unknown): value is Mode => value === 'predict' || value === 'versus' || value === 'lineup';

	let recorded: (number | null)[] = Array.isArray(stored.recorded) ? stored.recorded.slice(0, 24) : [];
	let firstPick: TeamSide = isSide(stored.firstPick) ? stored.firstPick : 'radiant';
	/** 你打哪一边；预测那条路不用它，复盘那条路用它决定「我方」是谁。 */
	let mySide: TeamSide = isSide(stored.mySide) ? stored.mySide : 'radiant';
	let mode: Mode = isMode(stored.mode) ? stored.mode : 'predict';
	let radiantTeamId = typeof stored.radiantTeam === 'string' ? stored.radiantTeam : '';
	let direTeamId = typeof stored.direTeam === 'string' ? stored.direTeam : '';
	/** 模型配置。只存在这台浏览器；形状与读写见 lib/aiConfig.ts。 */
	let ai: AiConfig = loadAiConfig();
	/**
	 * 用户对「对面交给 AI」的选择。
	 *
	 * 与下面的 `aiSide` 分开是有原因的：没配置模型时实际值一律是关的，但那是**被迫**关的，
	 * 不能把它写进存储——否则用户配好模型回来，开关还停在「关」上，看起来像没生效。
	 */
	let aiSidePref = stored.aiSide !== false;
	/** 实际生效值：没配置模型就没有 AI 可以交给对面。 */
	let aiSide = isConfigured(ai) && aiSidePref;
	let attrFilter = 'all';
	let positionFilter = 'all';
	let query = '';
	let adviceOpen = false;
	let aiResult: { picks: { heroId: number; position: number; reason: string; risk: string }[]; summary: string } | null = null;
	/**
	 * 模型配置的世代号：每次「换了目标」（地址 / key / 模型）加一。
	 *
	 * 请求是异步的，最长能跑 30 秒。这中间另一个标签页保存了新配置时，`refreshAiConfig` 只会
	 * 清掉**当时**已经落在面板上的文字；在飞的那一份回来照样会把自己写回去，于是台头写着
	 * 「未配置模型」、下面却挂着上一个模型的分析——正是这次修复要挡的那一幕。
	 * 所以发请求前记下世代号，回来先对一眼，变了就整份丢掉。
	 */
	let aiGeneration = 0;
	/** AI 正在替对面决策，避免自动出招被重复触发。 */
	let aiBusy = false;
	/** 自动出招的定时器；撤销、清空、关掉开关都要能取消它。 */
	let aiTimer: number | null = null;
	/** 某一步没有可用候选时记下手号，避免自动出招在同一手上反复重试。 */
	let aiStallStep = -1;
	/** 对面上一手的决定，轮到它时显示。 */
	let lastAiMove = '';
	/** 队伍目录：队标、名单与招牌英雄。到位之前页面照常能用，只是少这一块。 */
	const teamsById = new Map<string, DraftTeamEntry>();
	/**
	 * **两边各自的近期真实 BP**。
	 *
	 * 以前只取"对面"那一支（那一路是给逐手建议用的），预测只能靠号位胜率与名单招牌——
	 * 于是推出来的 BP 会一选幻影长矛手、会把米拉娜留到第四手，而真实数据里对面 18 场里
	 * 禁了米拉娜 10 次。要预测"这两队会怎么打"，两边的近况都得在手上。
	 */
	let forms: { radiant: FoeForm | null; dire: FoeForm | null } = { radiant: null, dire: null };
	/** 每一边当前这份数据属于哪支队，用来丢弃过期响应（换队比响应快时）。 */
	const formKeys: Record<TeamSide, string> = { radiant: '', dire: '' };
	/** 每一边取数状态的文案：'' 表示没在取、也没有错。 */
	const formStatus: Record<TeamSide, string> = { radiant: '', dire: '' };
	/** 对面（你没打的那一边）的近期偏好。逐手建议与复盘用它，从 `forms` 里取。 */
	let foeForm: FoeForm | null = null;
	/** 队名是选出来的，换队之后稍等一下再取，避免来回切时打出一串请求。 */
	let foeTimer: number | null = null;
	/**
	 * 线上对位（谁在线上打谁、和谁走一路）。**可选增强**：单独一份静态文件、启动后异步取，
	 * 拿不到就少一条依据，不挡录 BP、也不影响胜率算法（它不进胜率）。
	 */
	let lanes: LaneData | null = null;
	/** 双方阵容锁定后的对比结果；盘面一变就作废。 */
	let verdict: DraftVerdict | null = null;
	/** 模型写的那段文字（数字仍然来自 `verdict`）。 */
	let verdictAi: { summary: string; points: { dimension: string; text: string }[] } | null = null;
	/** 这份对比对应的盘面指纹：撤销、改录之后不能留着对不上的结论。 */
	let verdictKey = '';
	/** 「阵容分析」那条路上两边各选五个英雄。 */
	let directRadiant: number[] = readLineup(stored.directRadiant, stored, 'radiant');
	let directDire: number[] = readLineup(stored.directDire, stored, 'dire');
	/** 现在往哪一边填。 */
	let directSide: TeamSide = 'radiant';
	/** 最后一次预测结果；换队、改先选、换版本都会作废。 */
	let prediction: DraftPrediction | null = null;
	/** 模型这轮给的禁选不合法时的原因；非空表示"下面这份是站内推的"。 */
	let rejected = '';
	/** 预测正在跑（模型那条路要几秒），避免重复点。 */
	let predictBusy = false;

	// ---------------------------------------------------------------- DOM

	const poolRoot = element<HTMLDivElement>('draft-pool');
	const boardGrid = element<HTMLDivElement>('draft-board-grid');
	const poolCount = element<HTMLSpanElement>('draft-pool-count');
	const poolHint = element<HTMLParagraphElement>('draft-pool-hint');
	const bannerStep = element<HTMLSpanElement>('draft-banner-step');
	const bannerTurn = element<HTMLSpanElement>('draft-banner-turn');
	const bannerDetail = element<HTMLSpanElement>('draft-banner-detail');
	const adviceToggle = element<HTMLButtonElement>('draft-advice-toggle');
	const adviceAi = element<HTMLButtonElement>('draft-advice-ai');
	const adviceBody = element<HTMLDivElement>('draft-advice-body');
	const adviceStatus = element<HTMLSpanElement>('draft-advice-status');
	const adviceSummary = element<HTMLParagraphElement>('draft-advice-summary');
	/** 没接模型时那段解释，由本地依据拼出来；有模型结果时它是空的。 */
	const adviceNote = element<HTMLParagraphElement>('draft-advice-note');
	const compositionLine = element<HTMLParagraphElement>('draft-composition');
	const adviceCards = element<HTMLDivElement>('draft-advice-cards');
	const lineupBox = element<HTMLDivElement>('draft-lineup');
	const foeStatusEl = element<HTMLParagraphElement>('draft-foe-status');
	const verdictBtn = element<HTMLButtonElement>('draft-verdict');
	const verdictStatus = element<HTMLSpanElement>('draft-verdict-status');
	const verdictBox = element<HTMLDivElement>('draft-verdict-box');
	const directPanel = element<HTMLDivElement>('draft-direct-panel');
	const directRadiantBtn = element<HTMLButtonElement>('draft-direct-radiant');
	const directDireBtn = element<HTMLButtonElement>('draft-direct-dire');
	const directHint = element<HTMLSpanElement>('draft-direct-hint');
	/** 配置状态那一行。表单在 /settings，这里只显示现状并给入口。 */
	const aiState = element<HTMLSpanElement>('draft-ai-state');
	const aiConfigBox = element<HTMLElement>('draft-ai-config');
	const radiantSelect = element<HTMLSelectElement>('draft-radiant-team');
	const direSelect = element<HTMLSelectElement>('draft-dire-team');
	const teamsPreview = element<HTMLDivElement>('draft-teams-preview');
	const predictRun = element<HTMLButtonElement>('draft-predict-run');
	const predictStatus = element<HTMLSpanElement>('draft-predict-status');
	const predictBox = element<HTMLDivElement>('draft-predict-box');
	const aiSideInput = element<HTMLInputElement>('draft-ai-side');
	/** 紧挨着那个开关的一句说明：它为什么是灰的。 */
	const aiHint = element<HTMLSpanElement>('draft-ai-hint');
	const aiMoveBox = element<HTMLDivElement>('draft-ai-move');
	const aiWho = element<HTMLSpanElement>('draft-ai-who');
	const aiStatus = element<HTMLSpanElement>('draft-ai-status');
	const aiPlay = element<HTMLButtonElement>('draft-ai-play');

	if (!poolRoot || !bannerStep || !adviceToggle) {
		// 页面结构被人改过，宁可不工作也不要抛一堆空引用错误。
		console.warn('[draft] 页面结构不完整，脚本退出');
	} else {
		run();
	}

	/** 读一条阵容。老版本把「我方/对方」存成 `directOurs`，按当时的 `ourSide` 折到天辉/夜魇。 */
	function readLineup(primary: unknown, source: Stored, side: TeamSide): number[] {
		const legacy = side === 'radiant' ? source.directOurs : source.directTheirs;
		const legacySide = source.ourSide === 'dire' ? 'dire' : 'radiant';
		const list = Array.isArray(primary) && primary.length > 0 ? primary : legacySide === side && Array.isArray(legacy) ? legacy : [];
		return list.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0).slice(0, 5);
	}

	function run(): void {
		// ------------------------------------------------------------ 状态

		const snapshotNow = () => snapshot(recorded);
		const teamIdOf = (side: TeamSide): string => (side === 'radiant' ? radiantTeamId : direTeamId);
		const teamEntryOf = (side: TeamSide): DraftTeamEntry | null => teamsById.get(teamIdOf(side)) ?? null;
		/** 队伍名；没选队伍时退回阵营名——**不编**一个队名出来。 */
		const teamNameOf = (side: TeamSide): string => teamEntryOf(side)?.name ?? '';
		const sideLabel = (side: TeamSide): string => teamNameOf(side) || (side === 'radiant' ? '天辉' : '夜魇');

		const save = (): void => {
			try {
				localStorage.setItem(
					STORE_KEY,
					// 只写用户的开关偏好，不写被配置状态逼出来的那个值（见 aiSidePref 的注释）。
					JSON.stringify({
						recorded,
						firstPick,
						mode,
						mySide,
						radiantTeam: radiantTeamId,
						direTeam: direTeamId,
						aiSide: aiSidePref,
						directRadiant,
						directDire,
					}),
				);
			} catch {
				// 隐私模式下写不进去，不影响使用。
			}
		};

		/** 两边的名单画像（含每个号位是谁、他在拿什么）；目录没到货时两边都是 null。 */
		const signatures = (): { radiant: RosterProfile | null; dire: RosterProfile | null } => ({
			radiant: rosterOf('radiant'),
			dire: rosterOf('dire'),
		});

		function rosterOf(side: TeamSide): RosterProfile | null {
			const entry = teamEntryOf(side);
			if (!entry || entry.roster.length === 0) return null;
			return buildRosterProfile(
				entry.name,
				// 号位要一起带上：没有它就只有"这支队爱用什么"，问不出"他们的二号位会拿什么"。
				entry.roster.map((member) => ({
					nick: member.nick,
					position: member.position,
					scope: member.scope,
					heroes: member.heroes,
				})),
			);
		}

		/** 对面这一手轮到谁在动、动的是禁用还是挑选。 */
		const currentTurn = (): { mine: boolean; action: 'ban' | 'pick'; side: TeamSide } | null => {
			const state = snapshotNow();
			if (state.done || !state.owner || !state.action) return null;
			const side = sideOfOwner(state.owner, firstPick);
			return { mine: side === mySide, action: state.action, side };
		};

		const setHint = (message: string): void => {
			if (poolHint) poolHint.textContent = message;
		};

		// ------------------------------------------------------------ 英雄池

		const tiles = new Map<number, HTMLButtonElement>();
		const groups = new Map<string, HTMLDivElement>();

		function buildPool(): void {
			if (!poolRoot) return;
			poolRoot.innerHTML = '';
			for (const attr of ATTR_ORDER) {
				const group = document.createElement('div');
				group.className = 'pool-group';
				/*
				 * 分组用 `data-attr-group`，**不能**用 `data-attr`：属性筛选按钮也是 `[data-attr]`，
				 * 两者共用的话，点英雄时事件冒泡到分组上，会把过滤器切到这个英雄的属性，
				 * 于是点一下英雄，整个池子就只剩下一组（实测踩过）。
				 */
				group.dataset.attrGroup = attr;
				const title = document.createElement('p');
				title.className = 'pool-group-title';
				const grid = document.createElement('div');
				grid.className = 'pool-grid';
				// 属性图标与文字一起放在标题里，跟客户端的英雄池一样。
				const icon = ATTRIBUTE_ICON[attr as keyof typeof ATTRIBUTE_ICON] ?? '';
				title.innerHTML = `${icon ? `<img class="pool-group-icon" src="${esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}${esc(ATTR_LABEL[attr] ?? attr)}（${draft.heroes.filter((hero) => hero.attr === attr).length}）`;
				group.append(title, grid);
				poolRoot.append(group);
				groups.set(attr, grid);
			}
			for (const hero of draft.heroes) {
				const tile = document.createElement('button');
				tile.type = 'button';
				tile.className = 'hero-tile';
				tile.dataset.heroId = String(hero.id);
				tile.title = hero.name;
				tile.innerHTML = `<img src="${esc(hero.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="hero-tile-name">${esc(hero.name)}</span>`;
				tile.addEventListener('click', () => onHeroClick(hero.id));
				(groups.get(hero.attr) ?? groups.get('UNI') ?? poolRoot).append(tile);
				tiles.set(hero.id, tile);
			}
		}

		function tileLabel(step: number): string {
			const entry = CM_STEPS[step - 1];
			const side = sideOfOwner(entry.owner, firstPick);
			const action = entry.action === 'ban' ? '禁用' : '挑选';
			return `第 ${step} 手 ${sideLabel(side)}${action}`;
		}

		function syncPool(): void {
			const state = snapshotNow();
			const needle = query.trim().toLowerCase();
			const position = positionFilter === 'all' ? null : Number(positionFilter);
			let visible = 0;

			for (const hero of draft.heroes) {
				const tile = tiles.get(hero.id);
				if (!tile) continue;
				// 阵容分析模式下已经录的 24 手 BP 不参与：那套东西与「直接填阵容」是两条独立的路。
				const usedAt = mode === 'lineup' ? undefined : state.used.get(hero.id);
				const inAttr = attrFilter === 'all' || hero.attr === attrFilter;
				const inPosition = position === null || hero.positions[position - 1] !== null;
				const inQuery =
					needle.length === 0 || hero.name.toLowerCase().includes(needle) || hero.nameEn.toLowerCase().includes(needle);
				const show = inAttr && inPosition && inQuery;
				tile.hidden = !show;
				if (show) visible += 1;

				if (usedAt) {
					const entry = CM_STEPS[usedAt - 1];
					tile.dataset.used = entry.action;
					tile.dataset.usedLabel = tileLabel(usedAt);
				} else if (mode === 'lineup' && directOwner(hero.id)) {
					// 阵容分析模式下「已经选了」看的是这套阵容，不是 24 手 BP。
					tile.dataset.used = 'pick';
					tile.dataset.usedLabel = directOwner(hero.id) === 'radiant' ? '天辉阵容' : '夜魇阵容';
				} else {
					delete tile.dataset.used;
					delete tile.dataset.usedLabel;
				}
			}

			if (poolCount) poolCount.textContent = `显示 ${visible} / ${draft.heroes.length} 个英雄`;
		}

		function applyFilters(): void {
			for (const group of groups.values()) {
				const wrapper = group.parentElement;
				if (wrapper) wrapper.hidden = attrFilter !== 'all' && wrapper.dataset.attrGroup !== attrFilter;
			}
			syncPool();
		}

		// ------------------------------------------------------------ BP 板

		interface SlotRef {
			/** 这一手落子/落禁用的那个格子。另一边留空占位，保持三列对齐。 */
			cell: HTMLDivElement;
			row: HTMLDivElement;
			/** 手号下面那行字：只有当前手才写"禁用/挑选"，其余留空，跟客户端一样。 */
			actionEl: HTMLSpanElement;
		}
		const slots = new Map<number, SlotRef>();
		/** 上一次建表用的是哪边先选：先选权一改，两侧归属整体镜像，表要重建。 */
		let builtFor: TeamSide | null = null;

		/**
		 * 建 24 行：天辉一列、夜魇一列、中间夹手号，**一行一手**按顺序往下走。
		 * 客户端就是这么排的，好处是听解说报"第 12 手"时能直接找到那一行，
		 * 也不用在"先七个禁用再五个挑选"里来回换算。
		 */
		function buildBoard(): void {
			if (!boardGrid) return;
			boardGrid.innerHTML = '';
			slots.clear();
			const first = firstPick;
			for (const entry of CM_STEPS) {
				const side = sideOfOwner(entry.owner, first);
				const row = document.createElement('div');
				row.className = 'draft-row';
				row.dataset.step = String(entry.step);
				row.dataset.action = entry.action;
				if (CM_PHASE_STARTS.includes(entry.step)) row.dataset.phaseStart = 'true';

				const left = document.createElement('div');
				const middle = document.createElement('div');
				const right = document.createElement('div');
				middle.className = 'draft-step';
				middle.innerHTML = `<span>${entry.step}</span><span class="draft-step-action"></span>`;
				const actionEl = middle.querySelector('.draft-step-action') as HTMLSpanElement;

				const cell = side === 'radiant' ? left : right;
				cell.className = 'draft-cell';
				cell.dataset.side = side;
				cell.dataset.action = entry.action;
				cell.title = `${side === 'radiant' ? '天辉' : '夜魇'} · 第 ${entry.step} 手${entry.action === 'ban' ? '禁用' : '挑选'}`;

				row.append(left, middle, right);
				boardGrid.append(row);
				slots.set(entry.step, { cell, row, actionEl });
			}
			builtFor = first;
		}

		function syncBoard(): void {
			const state = snapshotNow();
			if (builtFor !== firstPick || slots.size !== CM_STEPS.length) buildBoard();
			const current = state.done ? -1 : state.nextStep;

			for (const [step, ref] of slots) {
				const heroId = recorded[step - 1];
				const hero = typeof heroId === 'number' ? heroById.get(heroId) : undefined;
				if (hero) {
					ref.cell.dataset.state = 'filled';
					ref.cell.innerHTML = `<img src="${esc(hero.img)}" alt="${esc(hero.name)}" loading="lazy" referrerpolicy="no-referrer" />`;
				} else {
					ref.cell.dataset.state = 'empty';
					ref.cell.innerHTML = '';
				}
				ref.row.dataset.current = String(step === current);
				// 24 行都写"禁/选"会把中间那列塞满，只在当前手标出来就够看了。
				ref.actionEl.textContent = step === current ? (ref.cell.dataset.action === 'ban' ? '禁用' : '挑选') : '';
			}

			// 列头固定写阵营名，队名与先选的标记挂在旁边，跟客户端一致。
			const radiantLabel = element<HTMLSpanElement>('draft-label-radiant');
			const direLabel = element<HTMLSpanElement>('draft-label-dire');
			if (radiantLabel) radiantLabel.textContent = '天辉';
			if (direLabel) direLabel.textContent = '夜魇';
			for (const side of ['radiant', 'dire'] as TeamSide[]) {
				const badge = element<HTMLSpanElement>(`draft-badge-${side}`);
				if (!badge) continue;
				const bits = [sideLabel(side)];
				if (side === firstPick) bits.push('先选');
				badge.textContent = bits.join(' · ');
			}
		}

		// ------------------------------------------------------------ 当前手

		function syncBanner(): void {
			const state = snapshotNow();
			if (!bannerStep || !bannerTurn || !bannerDetail) return;
			if (state.done) {
				bannerStep.textContent = '24 手走完';
				bannerTurn.textContent = '这一局录完了';
				bannerDetail.textContent = '';
				return;
			}
			const side = sideOfOwner(state.owner ?? 'first', firstPick);
			const action = state.action === 'ban' ? '禁用' : '挑选';
			bannerStep.textContent = `第 ${state.nextStep} 手`;
			bannerTurn.textContent = `${sideLabel(side)}${action}`;
			const tail = state.tail;
			const tailSide = sideOfOwner(tail.ban, firstPick) === mySide ? '我方' : '对面';
			const mine = mySide === firstPick ? 'first' : 'second';
			bannerDetail.textContent = `我方还剩 ${state.remaining[mine].bans} 禁 ${state.remaining[mine].picks} 选 · 最后一手禁用和最后一手挑选都在${tailSide}`;
		}

		// ------------------------------------------------------------ 队伍与招牌英雄

		/**
		 * 装下队伍目录，并把与它有关的三处重画一遍：队伍卡片、对手的近期习惯、候选里的招牌依据。
		 */
		function applyTeams(body: DraftTeamCatalog): void {
			teamsById.clear();
			for (const team of body.teams) teamsById.set(team.id, team);
			renderTeams();
			scheduleFoe();
			renderAdvice();
		}

		/**
		 * 退路：内联那份缺失或坏了（页面被手工改过、或被别的工具重写过）时，再按老办法取一次
		 * `/draft-teams.json`。**失败也不影响录 BP**，只是队伍卡片会写明"没取到资料"。
		 */
		async function loadTeamsFromNetwork(): Promise<void> {
			try {
				const res = await fetch('/draft-teams.json');
				if (!res.ok) return;
				const body = (await res.json()) as DraftTeamCatalog;
				if (!Array.isArray(body?.teams)) return;
				applyTeams(body);
			} catch {
				// 拉不到就保持 null。
			}
		}

		/** 队标：没有图或图挂了都显示队名前两个字母，跟战队页一致。 */
		function logoMark(entry: DraftTeamEntry): string {
			const initial = esc(entry.name.trim().slice(0, 2).toUpperCase());
			if (!entry.logo) return initial;
			return `${initial}<img src="${esc(entry.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
		}

		/** 一位选手的招牌英雄小标签。图标来自英雄数据，拿不到就只写名字。 */
		function heroChip(heroId: number, note: string): string {
			const hero = heroById.get(heroId);
			const name = hero ? esc(hero.name) : `英雄 #${heroId}`;
			const icon = hero ? `<img src="${esc(hero.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '';
			return `<span class="team-brief-hero" title="${esc(note)}">${icon}${name}</span>`;
		}

		/**
		 * 两队的卡片：队标 + 队名 + 名单，每人下面挂他自己的招牌英雄。
		 *
		 * 口径逐人写：同一个人可能落在"本版本"和"近 90 天"两档里（见 `playerHeroes`），
		 * 统一的说法会让人以为全队是同一个窗口。
		 */
		function renderTeams(): void {
			if (!teamsPreview) return;
			teamsPreview.innerHTML = '';
			for (const side of ['radiant', 'dire'] as TeamSide[]) {
				const entry = teamEntryOf(side);
				const card = document.createElement('div');
				card.className = 'team-brief';
				const tint = side === 'radiant' ? 'text-[#62a86f]' : 'text-dota-light';
				if (!entry) {
					/*
					 * 两种"没有卡片"要分开说：**没选队**与**选了但资料没到**。
					 * 上一版两种情况都写"未指定队伍"，用户选了队之后看到这句只会以为选择没生效
					 * （实测被这么误解过）——所以选了队却查不到资料时，必须说清是资料的问题。
					 * 第三种是"这支队已经不在名录里"（降级被移出门户、改了名）：那种情况刷新也没用，
					 * 直接让人换一支，别把人耗在刷新上。
					 */
					const picked = teamIdOf(side);
					const select = side === 'radiant' ? radiantSelect : direSelect;
					const inList = Boolean(picked && select && [...select.options].some((option) => option.value === picked));
					const camp = side === 'radiant' ? '天辉' : '夜魇';
					const title = !picked ? `${camp}未指定队伍` : inList ? `${camp}那支队的资料没取到` : `${camp}这支队已不在名录里`;
					const note = !picked
						? '在上面选一支队，就能看到队标、名单与招牌英雄'
						: inList
							? '队名已经记下了，刷新一次就能看到队标、名单与招牌英雄'
							: '它可能改名或已经不在活跃名录里了，重选一支来看看';
					card.innerHTML = `<span class="team-brief-logo">${side === 'radiant' ? '天' : '夜'}</span>
						<span class="min-w-0 flex-1">
							<span class="block text-sm text-cream">${esc(title)}</span>
							<span class="mt-0.5 block text-xs text-faint">${note}</span>
						</span>`;
					teamsPreview.append(card);
					continue;
				}
				const members = entry.roster
					.map((member) => {
						const scope = signatureScopeLabel(member.scope);
						const heroes = member.heroes
							.slice(0, 4)
							.map((stat) => heroChip(stat.heroId, `${member.nick} · ${stat.games} 场 ${stat.wins} 胜${scope ? ` · ${scope}` : ''}`))
							.join('');
						const position = member.position ? `${member.position} 号位` : '位置不详';
						/*
						 * 一位选手占一整行：名字与号位在上、招牌在下。
						 * 挤成一行的话，窄屏上换行之后第二个英雄会掉到没有名字的一行里，
						 * 看起来像是另一个人打的。
						 */
						return `<span class="team-brief-member">
							<span class="flex flex-wrap items-baseline gap-1.5">
								<span class="text-xs text-cream">${esc(member.nick)}</span>
								<span class="text-[10px] text-faint">${position}${scope ? ` · ${esc(scope)}` : ''}</span>
							</span>
							<span class="flex flex-wrap items-center gap-1">${heroes}</span>
						</span>`;
					})
					.join('');
				card.innerHTML = `
					<span class="team-brief-logo">${logoMark(entry)}</span>
					<span class="min-w-0 flex-1">
						<span class="flex flex-wrap items-center gap-2">
							<span class="text-sm text-cream">${esc(entry.name)}</span>
							<span class="text-[10px] ${tint}">${side === 'radiant' ? '天辉' : '夜魇'}</span>
							${entry.regionLabel ? `<span class="text-[10px] text-faint">${esc(entry.regionLabel)}</span>` : ''}
						</span>
						<span class="mt-1 flex flex-col gap-1">${members || '<span class="text-xs text-faint">这份名单里还没有可用的招牌英雄</span>'}</span>
					</span>`;
				teamsPreview.append(card);
			}
		}

		// ------------------------------------------------------------ 两队的近期真实 BP

		/**
		 * 取**两边**近期的真实 BP（各一次请求，服务端缓存 30 分钟、浏览器 10 分钟）。
		 *
		 * 两边都要，是因为预测要回答"这两队会怎么打"：只知道对面禁了什么、不知道对面一般第几手拿，
		 * 就会推出一选幻影长矛手这种不合理的东西。逐手建议那边仍然只用"对面"那一份。
		 */
		async function syncFoeForm(): Promise<void> {
			await Promise.all((['radiant', 'dire'] as TeamSide[]).map((side) => syncSideForm(side)));
			foeForm = forms[otherSide(mySide)];
			renderFoe();
			renderAdvice();
			// 预测卡上也写着各队的近况，数据到了要重画一次。
			if (prediction) renderPrediction();
		}

		async function syncSideForm(side: TeamSide): Promise<void> {
			const entry = teamEntryOf(side);
			if (!entry) {
				forms[side] = null;
				formKeys[side] = '';
				formStatus[side] = '';
				return;
			}
			if (!entry.odId) {
				forms[side] = null;
				formKeys[side] = `miss:${entry.id}`;
				formStatus[side] = `站内没有 ${entry.name} 的 OpenDota 记录，取不到这支队近期的 BP`;
				return;
			}

			const requestKey = `${entry.id}:${entry.odId}`;
			if (formKeys[side] === requestKey) return;
			formKeys[side] = requestKey;
			forms[side] = null;
			formStatus[side] = `正在取 ${entry.name} 近期的 BP…`;
			renderFoe();
			try {
				const res = await fetch(`/api/draft/foe?id=${entry.odId}`);
				const body = (await res.json()) as { ok?: boolean; form?: FoeForm; reason?: string };
				if (formKeys[side] !== requestKey) return;
				if (body.ok && body.form) {
					forms[side] = body.form;
					formStatus[side] = '';
				} else {
					forms[side] = null;
					formStatus[side] = body.reason ?? '取不到这支队近期的 BP';
				}
			} catch {
				if (formKeys[side] !== requestKey) return;
				forms[side] = null;
				formStatus[side] = '取不到这支队近期的 BP（网络或上游故障）';
			}
		}

		/** 控制条下面那行：对面最近爱用什么。取数中与取不到的状态也走这里。 */
		function renderFoe(): void {
			if (!foeStatusEl) return;
			const top = foeForm
				? foeHighlights(foeForm, 3)
						.map((hero) => {
							const rate = foeWinRate(hero);
							const label = heroById.get(hero.heroId)?.name ?? `英雄 #${hero.heroId}`;
							return `${label} ${hero.picks} 场${rate === null ? '' : ` ${(rate * 100).toFixed(0)}%`}`;
						})
						.join(' · ')
				: '';
			const status = formStatus[otherSide(mySide)];
			const text = status || (foeForm ? `对面擅长：${foeHeadline(foeForm)}${top ? `；常拿 ${top}` : ''}` : '');
			foeStatusEl.textContent = text;
			foeStatusEl.style.display = text ? '' : 'none';
		}

		/** 换队之后稍等一下再取：来回切的时候每一下就发一次请求，既烧额度也拿不到有用的结果。 */
		function scheduleFoe(): void {
			if (foeTimer !== null) window.clearTimeout(foeTimer);
			foeTimer = window.setTimeout(() => {
				foeTimer = null;
				void syncFoeForm();
			}, 400);
		}

		// ------------------------------------------------------------ 阵容分析（跳过 BP）

		const directLineup = (side: TeamSide): number[] => (side === 'radiant' ? directRadiant : directDire);
		const setDirectLineup = (side: TeamSide, ids: number[]): void => {
			if (side === 'radiant') directRadiant = ids;
			else directDire = ids;
		};

		/** 这个英雄现在在直接阵容的哪一边；不在任何一边返回 null。 */
		function directOwner(heroId: number): TeamSide | null {
			if (directRadiant.includes(heroId)) return 'radiant';
			if (directDire.includes(heroId)) return 'dire';
			return null;
		}

		/**
		 * 点英雄池：已经在阵容里的移掉，否则填进当前这边。
		 * 这边满了自动切到另一边，省得每填完五个还要去点一下。
		 */
		function toggleDirectHero(heroId: number): void {
			const owner = directOwner(heroId);
			if (owner) {
				setDirectLineup(owner, directLineup(owner).filter((id) => id !== heroId));
				setHint(`已从${sideLabel(owner)}阵容移除 ${heroById.get(heroId)?.name ?? ''}`);
			} else {
				let target: TeamSide = directSide;
				if (directLineup(target).length >= 5) target = otherSide(target);
				if (directLineup(target).length >= 5) {
					setHint('两边都满了，先点掉一个再选');
					return;
				}
				directSide = target;
				setDirectLineup(target, [...directLineup(target), heroId]);
				setHint(`已加入${sideLabel(target)}阵容：${heroById.get(heroId)?.name ?? ''}`);
			}
			// 阵容变了，上一次的复盘作废——留着会跟现在的阵容对不上。
			verdict = null;
			verdictAi = null;
			verdictKey = '';
			if (verdictStatus) verdictStatus.textContent = '';
			save();
			renderAll();
		}

		/** 阵容分析的两排格子、当前填哪边、还有几个空位。 */
		function syncDirect(): void {
			if (!directPanel) return;

			for (const side of ['radiant', 'dire'] as TeamSide[]) {
				const box = element<HTMLDivElement>(`draft-direct-slots-${side}`);
				if (!box) continue;
				box.innerHTML = '';
				for (let index = 0; index < 5; index += 1) {
					const heroId = directLineup(side)[index];
					const hero = typeof heroId === 'number' ? heroById.get(heroId) : undefined;
					const cell = document.createElement('button');
					cell.type = 'button';
					cell.className = `direct-slot${hero ? ' is-filled' : ''}`;
					cell.dataset.heroId = hero ? String(hero.id) : '';
					cell.title = hero ? `点一下把 ${hero.name} 从这边移除` : '空位：点英雄池里的英雄填进来';
					cell.innerHTML = hero
						? `<img src="${esc(hero.img)}" alt="${esc(hero.name)}" loading="lazy" referrerpolicy="no-referrer" /><span class="direct-slot-name">${esc(hero.name)}</span>`
						: `<span class="direct-slot-number">${index + 1}</span>`;
					box.append(cell);
				}
			}

			if (directRadiantBtn) directRadiantBtn.setAttribute('aria-pressed', String(directSide === 'radiant'));
			if (directDireBtn) directDireBtn.setAttribute('aria-pressed', String(directSide === 'dire'));
			if (directHint) {
				directHint.textContent = `接下来点英雄池会填到${sideLabel(directSide)}（${directLineup(directSide).length}/5）`;
			}
		}

		// ------------------------------------------------------------ 三个功能的显隐

		/**
		 * 面板与页签的联动。
		 *
		 * 显隐判据挂在 `data-panel` / `data-active` 上（见页面里的样式）：这几块里既有 flex
		 * 也有 grid，写死一种 `display` 会把它们压平，所以由属性决定，脚本只切值。
		 * `workspace`（英雄池 + 板子的栅格）只在非预测模式下出现——预测那条路不点英雄。
		 */
		function applyMode(): void {
			for (const node of document.querySelectorAll<HTMLElement>('[data-panel]')) {
				const panel = node.dataset.panel;
				const active = panel === mode || (panel === 'workspace' && mode !== 'predict');
				node.dataset.active = String(active);
			}
			for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
				tab.setAttribute('aria-pressed', String(tab.dataset.tab === mode));
			}
		}

		// ------------------------------------------------------------ 阵容复盘（双方锁完之后）

		/** 已经录进阵容的英雄（被禁的不算），按阵营分。 */
		function pickedIds(side: TeamSide): number[] {
			const state = snapshotNow();
			const ids: number[] = [];
			for (let index = 0; index < state.cursor; index += 1) {
				const step = CM_STEPS[index];
				if (!step || step.action !== 'pick') continue;
				if (sideOfOwner(step.owner, firstPick) !== side) continue;
				const heroId = recorded[index];
				if (typeof heroId === 'number') ids.push(heroId);
			}
			return ids;
		}

		/** 当前拿来复盘的那一边的阵容：BP 模式看 24 手，阵容分析模式看填进去的五个。 */
		const lineupOf = (side: TeamSide): number[] => (mode === 'lineup' ? directLineup(side) : pickedIds(side));

		/** 盘面指纹：任何一手变化都会让它变。 */
		const recordedKey = (): string => recorded.map((heroId) => heroId ?? '-').join(',');

		/** 当前这份阵容的指纹：BP 模式看 24 手，阵容分析模式看两套阵容。 */
		const lineupKey = (): string =>
			mode === 'lineup' ? `d:${directRadiant.join(',')}|${directDire.join(',')}` : recordedKey();

		function currentVerdict(): DraftVerdict | null {
			return buildVerdict({
				data: draft,
				ourIds: lineupOf(mySide),
				theirIds: lineupOf(otherSide(mySide)),
				ourSide: mySide,
				selfTeam: teamNameOf(mySide),
				foeTeam: teamNameOf(otherSide(mySide)),
				foeForm,
				lanes,
			});
		}

		/**
		 * 开放条件：双方各五个号位都落人。
		 *
		 * 阵容没锁就比，比的是「如果现在开打」——那不是这颗按钮要回答的问题（那是建议面板的活），
		 * 而且结论下一步就过期。所以宁可让它关着，用 title 说清还差几手。
		 */
		function syncVerdictButton(): void {
			const oursCount = lineupOf(mySide).length;
			const theirsCount = lineupOf(otherSide(mySide)).length;
			const ready = oursCount >= 5 && theirsCount >= 5;
			if (verdictBtn) {
				verdictBtn.disabled = !ready;
				verdictBtn.title = ready
					? '双方阵容都锁定了，比较这套对局'
					: mode === 'lineup'
						? `两边各选五个英雄才开放（现在 ${oursCount} : ${theirsCount}）`
						: `双方各五个号位都选完才开放（现在 ${oursCount} : ${theirsCount}）`;
			}
			// 盘面变了就作废上一次的复盘：否则撤销之后会留着对不上的结论。
			if (verdictKey && verdictKey !== lineupKey()) {
				verdict = null;
				verdictAi = null;
				verdictKey = '';
				if (verdictStatus) verdictStatus.textContent = '';
				renderVerdict();
			}
		}

		const pctText = (value: number): string => `${(value * 100).toFixed(1)}%`;

		function renderVerdict(): void {
			if (!verdictBox) return;
			if (!verdict) {
				verdictBox.innerHTML = '';
				verdictBox.style.display = 'none';
				return;
			}
			const v = verdict;
			verdictBox.style.display = '';

			const rows = v.rows
				.map((row) => {
					const mark = row.better === 'even' ? '持平' : row.better === 'ours' ? `${v.ours.label} 占优` : `${v.theirs.label} 占优`;
					const markClass = row.better === 'even' ? 'text-faint' : row.better === 'ours' ? 'text-gold' : 'text-dota-light';
					const value = (n: number): string => (row.percent ? pctText(n) : n.toFixed(row.key === 'structure' ? 2 : 0));
					return `<div class="flex items-center gap-2 border-b border-line/40 py-1.5 text-xs">
						<span class="w-24 shrink-0 text-muted">${esc(row.label)}</span>
						<span class="w-32 shrink-0 text-cream">${value(row.ours)} : ${value(row.theirs)}</span>
						<span class="text-faint">参考 ${value(row.target)}</span>
						<span class="${markClass} ml-auto">${esc(mark)}</span>
					</div>`;
				})
				.join('');
			const picks =
				v.foePicks.length > 0
					? `<p class="mt-2 text-xs text-muted">${esc(v.theirs.label)} 这套里的近期熟手：${v.foePicks
							.map((pick) => `${esc(pick.hero.name)}（${pick.picks} 场${pick.rate === null ? '' : ` ${pctText(pick.rate)}`}）`)
							.join('、')}</p>`
					: '';
			/*
			 * 分路对位单独一段：它不进胜率，混在上面那行「参考 0」的对比里会被当成胜率的组成部分。
			 * 每一格都带场次，让人自己判断这条线有多可信。
			 */
			const laneCells =
				v.laneEdges.length > 0
					? `<p class="mt-2 text-xs text-muted">分路对位（线上）：${v.laneEdges
							.map(
								(edge) =>
									`${edge.side === 'ours' ? esc(v.ours.label) : esc(v.theirs.label)} ${edge.position} 号位 ${esc(edge.hero.name)} ${formatNet(edge.net)}（${edge.matches.toLocaleString('zh-CN')} 场${
										edge.opponents.length > 0 ? `，对过 ${esc(edge.opponents[0].hero.name)} 等 ${edge.opponents.length} 个` : ''
									}）`,
							)
							.join('；')}</p>`
					: '';
			const lanePartners =
				v.lanePartners.length > 0
					? `<p class="mt-1 text-xs text-faint">同路搭档（常规分路）：${v.lanePartners
							.map(
								(pair) =>
									`${pair.side === 'ours' ? esc(v.ours.label) : esc(v.theirs.label)} ${esc(pair.hero.name)} 与 ${esc(pair.partner.name)} ${formatNet(pair.net)}（${pair.matches.toLocaleString('zh-CN')} 场）`,
							)
							.join('；')}</p>`
					: '';
			const ai = verdictAi
				? `<div class="mt-3 space-y-1.5">${verdictAi.summary ? `<p class="text-sm text-cream">${esc(verdictAi.summary)}</p>` : ''}${verdictAi.points
						.map((point) => `<p class="text-xs leading-relaxed text-muted">${point.dimension ? `<span class="text-gold">${esc(point.dimension)}</span> ` : ''}${esc(point.text)}</p>`)
						.join('')}</div>`
				: '';

			verdictBox.innerHTML = `
				<div class="rounded-xl border border-line bg-surface-2/60 p-3">
					<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
						<span class="text-cream">${esc(v.ours.label)} <span class="font-display text-lg text-gold">${pctText(v.winRate.ours)}</span></span>
						<span class="text-cream"><span class="font-display text-lg text-dota-light">${pctText(v.winRate.theirs)}</span> ${esc(v.theirs.label)}</span>
					</div>
					<div class="mt-2 flex h-2 overflow-hidden rounded-full bg-surface">
						<span class="bg-dota" style="width: ${(v.winRate.ours * 100).toFixed(1)}%"></span>
						<span class="flex-1 bg-gold"></span>
					</div>
					<p class="mt-2 text-xs text-faint">胜率 = 号位偏差 ${(v.edge.position * 100).toFixed(1)} + 对位偏差 ${(v.edge.counter * 100).toFixed(1)}（百分点；号位偏差按五个号位合计）</p>
					<div class="mt-3">${rows}</div>
					${picks}
					${laneCells}
					${lanePartners}
					<p class="mt-2 text-xs leading-relaxed text-faint">${v.notes.map((note) => esc(note)).join(' ')}</p>
					${ai}
				</div>`;
		}

		/**
		 * 点「分析双方阵容」：先把本地算好的对比摆出来，再（有 key 时）让模型写文字。
		 *
		 * 顺序是有意的——数字不依赖模型，模型挂了、没 key、额度用完，这一面板照样能用。
		 */
		async function analyzeVerdict(): Promise<void> {
			const built = currentVerdict();
			if (!built) {
				if (verdictStatus) verdictStatus.textContent = '双方各五个号位都选完才能对比';
				return;
			}
			verdict = built;
			verdictAi = null;
			verdictKey = lineupKey();
			renderVerdict();
			verdictBox?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

			if (!isConfigured(ai)) {
				if (verdictStatus) verdictStatus.textContent = '数字已经算好；配好模型才会有文字分析（在下面的「AI 解释」里去设置）';
				return;
			}

			if (verdictStatus) verdictStatus.textContent = '模型分析中…';
			if (verdictBtn) verdictBtn.disabled = true;
			const generation = aiGeneration;
			try {
				const messages = buildVerdictMessages({
					verdict: built,
					data: draft,
					selfTeam: teamNameOf(mySide),
					foeTeam: teamNameOf(otherSide(mySide)),
					foeForm,
				});
				const reply = await requestChat(ai, messages, { maxTokens: VERDICT_MAX_TOKENS });
				// 配置在这 30 秒里被别的标签页改了：这份回复是按旧配置问的，不能再写回面板。
				if (generation !== aiGeneration) return;
				if (!reply.ok) {
					if (verdictStatus) {
						verdictStatus.textContent = reply.status
							? `模型没返回结果（HTTP ${reply.status}），上面是本地算的数字`
							: '调用模型失败（网络、跨域或超时），上面是本地算的数字';
					}
					return;
				}
				const parsed = parseVerdictReply(reply.content);
				if (!parsed) {
					if (verdictStatus) verdictStatus.textContent = '模型的回复解析不了，只保留本地算的数字';
					return;
				}
				verdictAi = parsed;
				if (verdictStatus) verdictStatus.textContent = '';
			} catch {
				if (verdictStatus) verdictStatus.textContent = '调用模型失败（网络或代理），上面是本地算的数字';
			} finally {
				syncVerdictButton();
				renderVerdict();
			}
		}

		// ------------------------------------------------------------ 建议

		function currentAdvice(): Advice | null {
			return advise({
				data: draft,
				recorded,
				ourSide: mySide,
				firstPicker: firstPick,
				limit: 5,
				foeForm,
				signatures: signatures(),
				lanes,
			});
		}

		/**
		 * 取线上对位那份静态文件。
		 *
		 * 单独一份、启动后异步取，是因为它有 0.2MB 而 /draft 已经内联了 90KB 的阵容数据；
		 * 它是可选增强，拉不到就少「分路对位」这条依据，录 BP 与胜率都不受影响。
		 * 取回来之后重画一次：不重画的话，用户得等到下一次操作才看得到这一条。
		 */
		async function loadLanes(): Promise<void> {
			try {
				const res = await fetch('/draft-lanes.json');
				if (!res.ok) return;
				const body = (await res.json()) as Partial<LaneData>;
				if (!body?.vs || !body?.with) return;
				lanes = { vs: body.vs, with: body.with };
				/*
				 * 复盘面板渲染的是**已经算好的** `verdict`，它可能是在 lanes 还没到货时算的，
				 * 光重画不会多出「分路对位」那一行（慢网下 147KB 要几秒，用户很可能先点了按钮）。
				 * 盘面指纹没变就重算一次；模型那段文字留着——它讲的是同一套阵容，
				 * 而胜率本来就不含线上这一项，重算不会让文字对不上。
				 */
				if (verdict && verdictKey === lineupKey()) verdict = currentVerdict();
				// 预测那条路也吃线上对位（它影响每一步的候选排序），重推一次比留着旧结果诚实。
				if (prediction?.source === 'local') prediction = predictDraftLocal({ data: draft, firstPicker: firstPick, signatures: signatures(), forms, lanes });
				renderAdvice();
				renderVerdict();
				renderPrediction();
			} catch {
				// 拉不到就保持 null：这条依据本来就可有可无。
			}
		}

		/**
		 * 允许模型挑的英雄：数据层排出来的几个，加上「对面擅长」那一栏。
		 *
		 * 两栏都是候选——这正是加这一栏的意义：对面拿手的英雄很可能排不进号位胜率的前几名，
		 * 但 BP 里它就是要优先禁掉的对象，模型得有机会选中它。
		 */
		const allowedHeroIds = (advice: Advice): number[] =>
			[...advice.candidates, ...advice.foeCandidates].map((candidate) => candidate.heroId);

		function renderAdvice(): void {
			if (!adviceToggle || !adviceBody) return;
			adviceToggle.setAttribute('aria-expanded', String(adviceOpen));
			adviceToggle.textContent = adviceOpen ? '收起建议' : '看建议（不剧透）';
			adviceBody.style.display = adviceOpen ? '' : 'none';
			if (!adviceOpen) return;

			const advice = currentAdvice();
			if (!advice) {
				if (adviceSummary) adviceSummary.textContent = '24 手已经走完，没有下一手可建议。';
				if (adviceNote) adviceNote.textContent = '';
				if (adviceCards) adviceCards.innerHTML = '';
				if (lineupBox) lineupBox.innerHTML = '';
				if (adviceAi) adviceAi.style.display = 'none';
				return;
			}
			/*
			 * 同一个按钮两种说法：没配模型时它其实是「去配置」的入口，写成「让 AI 解释」会让人以为
			 * 点了就有结果，然后收到一句「没配置模型」——那是把一次失望写在按钮上。
			 */
			if (adviceAi) {
				adviceAi.style.display = '';
				adviceAi.textContent = isConfigured(ai) ? '让 AI 解释这几手' : '配置模型后可以解释';
			}
			if (adviceSummary) {
				adviceSummary.textContent = aiResult?.summary ? `${advice.summary} AI：${aiResult.summary}` : advice.summary;
			}
			/*
			 * 没接模型（或模型这次没给出结果）时，用本地依据补一段解释；有模型结果时让位给它——
			 * 两段都摆出来会互相打架，而且模型那段的顺序和本地的不一定一致。
			 */
			if (adviceNote) {
				const narrative = aiResult ? '' : adviceNarrative(advice, (id) => heroById.get(id)?.name ?? `英雄 #${id}`);
				adviceNote.textContent = narrative;
				adviceNote.style.display = narrative ? '' : 'none';
			}
			if (compositionLine) compositionLine.textContent = advice.composition.text;

			if (lineupBox) {
				lineupBox.innerHTML = advice.lineup
					.map((slot) => {
						const name = slot.hero?.name ?? '还没人';
						const tag = slot.settled ? '已到手' : '预计能补到';
						return `<div class="lineup-slot" data-settled="${slot.settled}">${slot.position} 号位 · ${esc(name)}<br /><span class="text-faint">${tag} · ${(slot.rate * 100).toFixed(1)}%</span></div>`;
					})
					.join('');
			}

			if (adviceCards) adviceCards.innerHTML = '';
			if (!adviceCards) return;

			/** 模型给过解释时，优先用它的顺序与文案，数字仍然来自本站数据。 */
			const ordered: { candidate: AdviceCandidate; reason: string[]; risk: string }[] = [];
			/** 已经画过的英雄，避免「对面擅长」那一栏把同一张卡再画一遍。 */
			const appended = new Set<number>();
			if (aiResult) {
				for (const pick of aiResult.picks) {
					/*
					 * 两栏都得找：解析白名单（`allowedHeroIds`）与提示词都把「对面近期拿过的」算作可选项，
					 * 只在这里查 `candidates` 的话，模型选中那一栏的英雄会被静默丢掉——卡片退回本地顺序，
					 * 而摘要上还写着「AI：…」，用户看不出这一手其实没算数。
					 */
					const candidate =
						advice.candidates.find((item) => item.heroId === pick.heroId) ??
						advice.foeCandidates.find((item) => item.heroId === pick.heroId);
					if (!candidate) continue;
					ordered.push({ candidate, reason: [pick.reason, ...candidate.reasons], risk: pick.risk || candidate.risk });
				}
			}
			for (const candidate of advice.candidates) {
				if (ordered.some((item) => item.candidate.heroId === candidate.heroId)) continue;
				ordered.push({ candidate, reason: candidate.reasons, risk: candidate.risk });
			}

			/** 一张候选卡：点一下就把这个英雄录进当前这一手。 */
			const appendCard = (item: { candidate: AdviceCandidate; reason: string[]; risk: string }): void => {
				const hero = heroById.get(item.candidate.heroId);
				const card = document.createElement('button');
				card.type = 'button';
				card.className = 'advice-card';
				const rate = item.candidate.hasSample ? `${(item.candidate.rate * 100).toFixed(1)}%` : '无样本';
				card.innerHTML = `
					<span class="flex items-center gap-2">
						${hero ? `<img src="${esc(hero.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="h-8 w-14 rounded object-cover object-top" />` : ''}
						<span class="min-w-0">
							<span class="block truncate text-sm text-cream">${esc(hero?.name ?? `英雄 #${item.candidate.heroId}`)}</span>
							<span class="block text-xs text-gold">${item.candidate.position} 号位 · ${rate}</span>
						</span>
					</span>
					<span class="space-y-1 text-xs leading-relaxed text-muted">${item.reason.map((line) => `<span class="block">${esc(line)}</span>`).join('')}</span>
					<span class="text-xs leading-relaxed text-faint">风险：${esc(item.risk)}</span>
				`;
				card.addEventListener('click', () => onHeroClick(item.candidate.heroId));
				const legal = canPlay(recorded, item.candidate.heroId);
				card.disabled = !legal.ok;
				card.title = legal.ok ? `点一下就把 ${hero?.name ?? ''} 录进第 ${snapshotNow().nextStep} 手` : legal.reason ?? '';
				adviceCards.append(card);
				appended.add(item.candidate.heroId);
			};

			for (const item of ordered.slice(0, aiResult ? ADVICE_TARGET_COUNT + 2 : 5)) appendCard(item);

			/**
			 * 「对面擅长」单列一栏，不并进上面的排序：上面那些是号位胜率算出来的，
			 * 这些是**对面的人真的在拿**的（近期窗口 + 名单招牌）。BP 里两者的用法不同，
			 * 混着排会让谁更熟悄悄主导顺序。
			 */
			if (advice.foeCandidates.length > 0) {
				const rest = advice.foeCandidates.filter((candidate) => !appended.has(candidate.heroId));
				if (rest.length > 0) {
					const heading = document.createElement('p');
					heading.className = 'mt-2 text-xs font-semibold text-gold';
					const foeWho = foeForm ? foeHeadline(foeForm) : sideLabel(otherSide(mySide));
					heading.textContent = `对面近期拿过 / 名单里的招牌（${foeWho}）`;
					adviceCards.append(heading);
					for (const candidate of rest) appendCard({ candidate, reason: candidate.reasons, risk: candidate.risk });
				}
			}
		}

		// ------------------------------------------------------------ AI 预测

		/**
		 * 预测整局的禁选。
		 *
		 * **先摆本地推的，再有模型时覆盖**：本地那条路（`predictDraftLocal`）不花一次请求，
		 * 立刻就有结果；配了模型才有下面那段更自然的理由。模型失败、解析不过，本地那份留着不动——
		 * 与建议、复盘两处是同一套规矩。换队、改先选、换版本之后这份结果作废。
		 */
		async function runPrediction(): Promise<void> {
			if (predictBusy) return;
			// 新的一轮：上一轮"被拒的原因"要清掉，否则会挂在这一轮的卡片上。
			rejected = '';
			const local = predictDraftLocal({ data: draft, firstPicker: firstPick, signatures: signatures(), forms, lanes });
			if (!local) {
				if (predictStatus) predictStatus.textContent = '号位样本不足，推不出整局 BP';
				return;
			}
			prediction = local;
			renderPrediction();

			if (!isConfigured(ai)) {
				if (predictStatus) predictStatus.textContent = '按站内数据推的；配好模型可以让它把这套禁选讲一遍（在下面的「AI 解释」里设置）';
				return;
			}

			predictBusy = true;
			if (predictRun) predictRun.disabled = true;
			if (predictStatus) predictStatus.textContent = '模型预测中…';
			const generation = aiGeneration;
			try {
				const messages = buildPredictionMessages({
					data: draft,
					radiantTeam: teamNameOf('radiant'),
					direTeam: teamNameOf('dire'),
					firstPicker: firstPick,
					signatures: signatures(),
					forms,
				});
				const reply = await requestChat(ai, messages, { maxTokens: PREDICTION_MAX_TOKENS });
				if (generation !== aiGeneration) return;
				if (!reply.ok) {
					if (predictStatus) {
						predictStatus.textContent = reply.status
							? `模型没返回结果（HTTP ${reply.status}），上面是按站内数据推的`
							: '调用模型失败（网络、跨域或超时），上面是按站内数据推的';
					}
					return;
				}
				const result = parsePredictionReplyDetailed(
					reply.content,
					draft.heroes.map((hero) => hero.id),
				);
				if (!result.ok) {
					/*
					 * **把原因说出来。** 上一版这里只写一句"解析不了"，用户完全不知道自己该重试、
					 * 该换模型，还是该等我们改提示词——而实测这件事是间歇的：同一提示词上一把通过、
					 * 这一把被拒，被拒的原因有好几种（缺号位、两边撞了同一个英雄、挑选不足五个……）。
					 */
					rejected = result.reason;
					if (predictStatus) predictStatus.textContent = `模型这次给的禁选不合法，已退回站内推演：${result.reason}`;
					return;
				}
				rejected = '';
				const parsed = result.prediction;
				/*
				 * **挑选用模型的，禁用用"模型的 + 站内补齐"。**
				 *
				 * 实测 DeepSeek 反复把"各队禁对面熟手"和"各队拿自己熟手"同时写出来，于是六成左右的
				 * 禁用与它自己的挑选撞车（同一个英雄不能既被禁又被选）。挑选是它最在行的部分，
				 * 一律保留；禁用先用它给的不冲突的那几条，不够 7 条就按站内引擎那份补齐——
				 * 两边是同一个口径（先掐对面该号位的熟手），拼起来不会互相打架。
				 */
				const taken = new Set<number>([...parsed.radiant.picks, ...parsed.dire.picks].map((pick) => pick.heroId));
				/*
				 * 模型给的禁用没有号位，但站内推演的同一手有（"对面会拿它打几号位"）。
				 * 同一个英雄两边都禁过时就把号位补上——角标有数字才说明得清这一手掐的是哪个位置。
				 */
				const positionOf = (side: 'radiant' | 'dire'): Map<number, number> =>
					new Map(
						local[side].bans
							.filter((ban) => Number.isInteger(ban.position))
							.map((ban) => [ban.heroId, ban.position as number]),
					);
				const withPosition = (bans: { heroId: number; reason: string }[], positions: Map<number, number>) =>
					bans.map((ban) => ({ ...ban, ...(positions.has(ban.heroId) ? { position: positions.get(ban.heroId) } : {}) }));
				/*
				 * 补齐用的料，三个来源按可信度排：
				 * 1. 本地推演那一手的 7 条禁用；
				 * 2. **它攒下来的备用池**（每一手的前几名）；
				 * 3. **这支队真实 BP 里自己禁过的英雄**（按次数排）——这一层是最后兜底，
				 *    也是三者里最贴现实的：他们真的禁过它。
				 *
				 * 只用第 1 层时，模型丢掉大半禁用之后一边只剩四五条（板子空 5 格）；
				 * 加上第 2 层仍会偶发地差一条（备用池也会被对面占光）。三层下来才够稳。
				 */
				const fillOf = (side: 'radiant' | 'dire') => {
					const form = forms[side];
					const fromRealBp = (form?.heroes ?? [])
						.filter((hero) => hero.bansBy > 0)
						.sort((a, b) => b.bansBy - a.bansBy || a.heroId - b.heroId)
						.map((hero) => ({ heroId: hero.heroId, reason: `他们近 ${form?.windowDays ?? 30} 天自己禁过它 ${hero.bansBy} 次` }));
					return [...local[side].bans, ...(local.spareBans?.[side] ?? []), ...fromRealBp];
				};
				const radiantBans = mergeBans(parsed.radiant.bans, fillOf('radiant'), taken);
				const direBans = mergeBans(parsed.dire.bans, fillOf('dire'), taken);
				prediction = {
					radiant: { picks: parsed.radiant.picks, bans: withPosition(radiantBans.bans, positionOf('radiant')) },
					dire: { picks: parsed.dire.picks, bans: withPosition(direBans.bans, positionOf('dire')) },
					summary: parsed.summary,
					source: 'model',
					droppedBans: parsed.droppedBans,
					filledBans: radiantBans.filled + direBans.filled,
					// 模型没给手号：让前端按队长模式的固定顺序排（界面上会写明这一点）。
					assignedSteps: true,
				};
				if (predictStatus) predictStatus.textContent = '';
			} catch {
				if (predictStatus) predictStatus.textContent = '调用模型失败（网络或代理），上面是按站内数据推的';
			} finally {
				predictBusy = false;
				if (predictRun) predictRun.disabled = false;
				renderPrediction();
			}
		}

		/**
		 * 预测结果里的一边。
		 *
		 * 挑选**逐张卡片**画：头像、名字、`几号位 · 谁`、以及"他在本窗口拿过它多少场"。
		 * 这三样缺一样读者就没法核对——上一版只有头像和名字，于是"二号位的天穹守望者"
		 * 这种一眼就不对的东西，页面上既没标号位、也没说这个人在不在这个位置上打它。
		 * 不在池子里的用虚线框点出来，理由放在下面（不再只藏在 hover 里）。
		 */
		function renderPredictSide(side: TeamSide, data: PredictedSide): string {
			const entry = teamEntryOf(side);
			const profile = rosterOf(side);
			const label = sideLabel(side);
			const tint = side === 'radiant' ? '#62a86f' : 'var(--color-dota)';
			/** 这个英雄在这个号位的池子里那一行；不在就是 null。 */
			const familiarOf = (position: number, heroId: number) =>
				rosterPoolOf(profile, position)?.heroes.find((row) => row.heroId === heroId) ?? null;
			const playerOf = (position: number): string => rosterPoolOf(profile, position)?.players.join('、') ?? '';

			/*
			 * 禁用格：位置是"**对面**会拿它打几号位"（禁用的价值就来自它落进对面哪个位置），
			 * 所以这里不写"谁"，只标出号位，剩下的靠 hover 那句理由。
			 */
			/*
			 * 禁用格。**号位是可选的**：本地推演的禁用带号位（"对面会拿它打几号位"），
			 * 模型给的禁用只有 heroId 与理由——上一版不分情况地渲染号位角标，
			 * 模型那几条就在页面上印出了 `undefined`（截图里能看到）。所以这里按有无来画。
			 */
			const banChip = (row: { heroId: number; reason: string; position?: number }): string => {
				const hero = heroById.get(row.heroId);
				const name = hero ? esc(hero.name) : `英雄 #${row.heroId}`;
				const img = hero ? `<img src="${esc(hero.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '';
				const badge = Number.isInteger(row.position) ? `<span class="predict-pos">${row.position}</span>` : '';
				const title = [Number.isInteger(row.position) ? `对面会拿它打 ${row.position} 号位` : '', row.reason].filter(Boolean).join(' · ');
				return `<span class="predict-hero" data-kind="ban"${title ? ` title="${esc(title)}"` : ''}>${img}${name}${badge}</span>`;
			};

			/** 挑选卡：号位 + 选手 + 熟手与否，理由直接写在下面。 */
			const pickCard = (row: { heroId: number; position: number; reason: string }): string => {
				const hero = heroById.get(row.heroId);
				const name = hero ? esc(hero.name) : `英雄 #${row.heroId}`;
				const img = hero ? `<img src="${esc(hero.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '';
				const familiar = familiarOf(row.position, row.heroId);
				const owner = playerOf(row.position);
				const who = `${row.position} 号位${owner ? ` · ${esc(owner)}` : ''}`;
				/*
				 * 不在池子里时**把他的池子列出来**：读者第一反应是"这个人到底玩什么"，
				 * 光说"不在池子里"等于让人自己去翻上面那张名单卡。
				 */
				const pool = rosterPoolOf(profile, row.position);
				// 口径逐号位取：同队不同号位可能落在不同窗口里（一个人本版本打过、另一个靠回退）。
				const scope = signatureScopeLabel(pool?.scope || profile?.scope || '');
				const poolList = (pool?.heroes ?? [])
					.slice(0, 5)
					.map((hero) => heroById.get(hero.heroId)?.name ?? '')
					.filter(Boolean)
					.join('、');
				const flag = familiar
					? `<span class="text-gold">熟手 · ${scope ? `${esc(scope)}里` : '近期'} ${familiar.games} 场 ${familiar.wins} 胜</span>`
					: `<span class="text-dota-light">不在${owner ? ` ${esc(owner)} ` : ''}这个位置的池子里${poolList ? `（他在拿：${esc(poolList)}）` : ''}</span>`;
				return `<span class="predict-pick" data-familiar="${familiar ? 'true' : 'false'}">
					${img}
					<span class="min-w-0 flex-1">
						<span class="block truncate text-xs text-cream">${name}</span>
						<span class="block text-[10px] text-faint">${who}</span>
						<span class="block text-[10px]">${flag}</span>
						${row.reason ? `<span class="predict-reason mt-0.5 block text-[10px] leading-snug text-muted">${esc(row.reason)}</span>` : ''}
					</span>
				</span>`;
			};

			// 有几个挑选落在这个号位选手的池子之外——这一句让整份预测可核对，不用一张张看。
			const outside = data.picks.filter((row) => !familiarOf(row.position, row.heroId)).length;
			const outsideNote =
				profile && outside > 0
					? `<p class="mt-2 text-[10px] text-dota-light">${outside} 个挑选不在该号位选手的池子里（虚线框）：数据层没有他们的记录，或者这是模型自己挑的</p>`
					: '';
			const logo = entry ? `<span class="team-brief-logo" style="width:2rem;height:2rem">${logoMark(entry)}</span>` : '';
			return `<div class="predict-side">
				<p class="mb-2 flex items-center gap-2 text-sm text-cream">${logo}<span style="color:${tint}">${side === 'radiant' ? '天辉' : '夜魇'}</span>${esc(label)}</p>
				<p class="mb-1 text-xs text-faint">禁用（${data.bans.length}）</p>
				<div class="predict-row">${data.bans.map(banChip).join('') || '<span class="text-xs text-faint">—</span>'}</div>
				<p class="mb-1 mt-3 text-xs text-faint">挑选（${data.picks.length}）</p>
				<div class="predict-grid">${data.picks.map(pickCard).join('') || '<span class="text-xs text-faint">—</span>'}</div>
				${outsideNote}
			</div>`;
		}

		function renderPrediction(): void {
			if (!predictBox) return;
			if (!prediction) {
				predictBox.innerHTML = '';
				predictBox.style.display = 'none';
				renderPredictBoard();
				return;
			}
			const source = prediction.source === 'model' ? '模型预测' : '按站内数据推演';
			const summary = prediction.summary ? `<p class="mt-3 text-sm leading-relaxed text-muted">${esc(prediction.summary)}</p>` : '';
			/*
			 * 丢过或补过禁用都要照实说：这两件事都会让读者对"这份禁用是谁给的"产生误判。
			 * 实测模型十次里十次都会写出与挑选冲突的禁用，所以这段话基本每次都会出现。
			 */
			const notes: string[] = [];
			if (rejected) notes.push(`模型这轮给的禁选不合法，下面是站内推的：${rejected}`);
			if (prediction.droppedBans) notes.push(`模型给的禁用里有 ${prediction.droppedBans} 条与挑选撞了同一个英雄（一局里不能既禁又选），已丢弃`);
			/*
			 * 补齐不是保证能凑满：站内那份禁用也可能与已经定下来的英雄撞车。
			 * 所以这里只说"补了几条"，不承诺"每边 7 条"——上一版写了那句，实测有一侧只补到 5 条。
			 */
			if (prediction.filledBans) notes.push(`另外补了 ${prediction.filledBans} 条站内数据推的禁用（冲突太多时，某一侧的禁用会不足 7 条）`);
			const dropped = notes.length > 0 ? `<p class="mt-1 text-xs text-dota-light">${notes.join('；')}</p>` : '';
			const firstLine = `<p class="text-xs text-faint">${source} · 先选方 ${esc(sideLabel(firstPick))} · 挑选的理由写在卡片上，禁用那行的号位是"对面会拿它打几号位"（鼠标停一下有依据）</p>`;
			predictBox.style.display = '';
			predictBox.innerHTML = `
				<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
					${renderPredictSide('radiant', prediction.radiant)}
					${renderPredictSide('dire', prediction.dire)}
				</div>
				${summary}
				${dropped}
				${firstLine}`;
			renderPredictBoard();
		}

		/**
		 * 把预测结果摆到 24 手的板子上（与「和 AI 的对手 BP」那块同一种板子）。
		 *
		 * 为什么要有它：清单式地读"他们禁了什么"看不出**顺序**，而顺序正是判断"这一手禁它对不对"
		 * 的关键（第 1 手禁掉一个别人本来也不急着拿的英雄，等于白禁）。本地推演的手号是真手号
		 * （它就是一手一手推出来的），模型只给清单——那种情况按队长模式的固定顺序排下去，
		 * 并在下面写明"手号是排的"，别让读者以为是模型说的。
		 */
		function renderPredictBoard(): void {
			const panel = element<HTMLDivElement>('draft-predict-board-panel');
			const grid = element<HTMLDivElement>('draft-predict-grid');
			if (!panel || !grid) return;
			if (!prediction) {
				panel.style.display = 'none';
				grid.innerHTML = '';
				return;
			}
			panel.style.display = '';

			// 摆位置这件事抽成了纯函数（`predictionHands`），因为它有"两种摆法不能混用"的坑，
			// 那一条要能自检钉住——放在这里就只能靠肉眼看板子。
			const hands = predictionHands(prediction, firstPick);

			const nameOf = (side: TeamSide) => `${side === 'radiant' ? '天辉' : '夜魇'}${teamNameOf(side) ? ` · ${teamNameOf(side)}` : ''}`;
			const radiantName = element<HTMLSpanElement>('draft-predict-name-radiant');
			const direName = element<HTMLSpanElement>('draft-predict-name-dire');
			if (radiantName) radiantName.textContent = nameOf('radiant');
			if (direName) direName.textContent = nameOf('dire');

			grid.innerHTML = '';
			for (const entry of CM_STEPS) {
				const side = sideOfOwner(entry.owner, firstPick);
				const row = document.createElement('div');
				row.className = 'draft-row';
				row.dataset.action = entry.action;
				if (CM_PHASE_STARTS.includes(entry.step)) row.dataset.phaseStart = 'true';
				const left = document.createElement('div');
				const middle = document.createElement('div');
				const right = document.createElement('div');
				middle.className = 'draft-step';
				middle.innerHTML = `<span>${entry.step}</span><span class="draft-step-action">${entry.action === 'ban' ? '禁' : '选'}</span>`;
				const cell = side === 'radiant' ? left : right;
				cell.className = 'draft-cell';
				cell.dataset.side = side;
				cell.dataset.action = entry.action;
				const heroId = hands[entry.step - 1];
				const hero = typeof heroId === 'number' ? heroById.get(heroId) : undefined;
				if (hero) {
					cell.dataset.state = 'filled';
					cell.title = `第 ${entry.step} 手 ${side === 'radiant' ? '天辉' : '夜魇'}${entry.action === 'ban' ? '禁用' : '挑选'} ${hero.name}`;
					cell.innerHTML = `<img src="${esc(hero.img)}" alt="${esc(hero.name)}" loading="lazy" referrerpolicy="no-referrer" />`;
				} else {
					cell.dataset.state = 'empty';
				}
				row.append(left, middle, right);
				grid.append(row);
			}

			const note = element<HTMLParagraphElement>('draft-predict-board-note');
			if (note) {
				note.textContent = prediction.assignedSteps
					? '一行一手，中间是手号；禁用打叉变灰，挑选是头像。模型只给了两边各自的禁选清单，这里的手号是按队长模式的顺序排的，不是模型说的。'
					: '一行一手，中间是手号；禁用打叉变灰，挑选是头像。手号是推演出来的真实顺序。';
			}
		}

		// ------------------------------------------------------------ 交互

		// ------------------------------------------------------------ 对面交给 AI

		function cancelAutoMove(): void {
			if (aiTimer !== null) {
				window.clearTimeout(aiTimer);
				aiTimer = null;
			}
		}

		/**
		 * 轮到对面时这块就是主界面：默认自动出招，取消勾选之后由人代打（露出手动按钮）。
		 * 延迟 700ms 再落子，让人先看清"现在轮到对面了"。
		 */
		function syncAiBlock(): void {
			// 预测与阵容分析两条路都没有「轮到谁」，自动出招必须停掉——否则它会在后台把 24 手一路走完。
			if (mode !== 'versus') {
				cancelAutoMove();
				if (aiMoveBox) aiMoveBox.style.display = 'none';
				return;
			}
			const turn = currentTurn();
			const opponentTurn = Boolean(turn && !turn.mine);
			// 同一个按钮两种含义：接了模型是「让 AI 走」，没配模型时只是让本地规则替对面走。
			// 标签跟着配置走，不然又是一个「写着 AI 其实没有 AI」的地方。
			if (aiPlay) aiPlay.textContent = isConfigured(ai) ? '让 AI 走这一手' : '让对面走这一手';
			// 轮到我们时也留着这一行：对面刚禁/刚选了什么、为什么，是这一手要参考的信息。
			if (aiMoveBox) aiMoveBox.style.display = opponentTurn || lastAiMove ? '' : 'none';
			if (adviceToggle) adviceToggle.style.display = turn && turn.mine ? '' : 'none';
			// 轮不到我们时把建议收起来，避免看到一半"对面那一手"的解释。
			if (adviceBody && opponentTurn) adviceBody.style.display = 'none';
			if (!opponentTurn || !turn) {
				cancelAutoMove();
				if (aiWho) aiWho.textContent = '对面刚才';
				if (aiStatus) aiStatus.textContent = lastAiMove;
				if (aiPlay) aiPlay.style.display = 'none';
				return;
			}

			const actionText = turn.action === 'ban' ? '禁用' : '挑选';
			// 没配模型时对面走的是本地规则，台头就不能写「AI」。
			if (aiWho) aiWho.textContent = `${sideLabel(turn.side)}（${isConfigured(ai) ? 'AI' : '本地'}）${actionText}`;
			if (aiBusy) {
				if (aiStatus) aiStatus.textContent = '正在看数据…';
				if (aiPlay) aiPlay.style.display = 'none';
				return;
			}

			const stalled = aiStallStep === snapshotNow().nextStep;
			if (aiSide && !stalled) {
				if (aiStatus) aiStatus.textContent = lastAiMove || '自动出招中…';
				if (aiPlay) aiPlay.style.display = 'none';
				if (aiTimer === null) {
					aiTimer = window.setTimeout(() => {
						aiTimer = null;
						void playOpponentMove();
					}, 700);
				}
				return;
			}

			cancelAutoMove();
			if (aiStatus) {
				aiStatus.textContent =
					lastAiMove || (isConfigured(ai) ? '这一手由你代打，直接点英雄池' : '没配置模型，这一手由你代打；也可以让它按本地数据自己走');
			}
			if (aiPlay) aiPlay.style.display = aiSide ? 'none' : '';
		}

		/**
		 * 本地规则那一手的依据，拼给界面那行日志用。
		 *
		 * **不复用候选卡的 `reasons`**：那些句子是按出招方的视角生成的，里面有「我方 / 对面」，
		 * 直接贴到这行上人称会指反。这里只用结构化字段重写，顺便只保留这一手真正的关键依据。
		 */
		function localMoveReason(candidate: AdviceCandidate, action: 'ban' | 'pick'): string {
			const familiar = foeHeroOf(foeForm, candidate.heroId);
			// 落子前那一手的 owner 就是对面。快照里的数字**含当前这一手**，
			// "落完这手还剩" 的扣减在 opponentMoveReason 里做（那一步能自检）。
			const state = snapshotNow();
			return opponentMoveReason({
				action,
				position: candidate.position,
				rate: candidate.rate,
				hasSample: candidate.hasSample,
				// 门槛与「对面擅长什么」那一栏共用 MIN_PICKS，免得出现「依据里说他是熟手、
				// 熟悉度那一栏却没有他」这种对不上的情况。
				foePicks: familiar && familiar.picks >= MIN_PICKS ? familiar.picks : null,
				windowDays: foeForm?.windowDays ?? 0,
				remainingBefore: state.owner ? state.remaining[state.owner] : null,
			});
		}

		/**
		 * 对面这一手怎么走。**数据先算、模型后挑**：先用对面的视角算出候选，
		 * 配了模型就让它在里面挑一个并说明；没配（或调用失败）就取数据里的第一顺位，
		 * 依据用 `localMoveReason` 从结构化字段重写一句。所以不配模型也能对着打，
		 * 台头会写明这一手是「本地」走的，不会假装有 AI。
		 */
		async function playOpponentMove(): Promise<void> {
			const turn = currentTurn();
			if (aiBusy || !turn || turn.mine) return;
			aiBusy = true;
			syncAiBlock();
			try {
				// 替对面落子：同一份数据这时是**它自己**的，人称靠视角参数翻过来。
				const enemyAdvice = advise({
					data: draft,
					recorded,
					ourSide: turn.side,
					firstPicker: firstPick,
					limit: 5,
					foeForm,
					signatures: signatures(),
					lanes,
				});
				if (!enemyAdvice || enemyAdvice.candidates.length === 0) {
					lastAiMove = '这一步没有可用候选，撤销或跳过后再来';
					aiStallStep = snapshotNow().nextStep;
					return;
				}

				const top = enemyAdvice.candidates[0];
				let heroId = top.heroId;
				// 先把本地那句依据备好：模型失败时直接用它，而不是回落到一句没有信息量的空话。
				let why = localMoveReason(top, turn.action);
				if (isConfigured(ai)) {
					const decided = await askModelForOpponentMove(enemyAdvice, turn.side);
					if (decided) {
						heroId = decided.heroId;
						why = decided.reason;
					}
				}

				recorded = play(recorded, heroId);
				const hero = heroById.get(heroId);
				const actionText = turn.action === 'ban' ? '禁用' : '挑选';
				lastAiMove = `${sideLabel(turn.side)}${actionText}了 ${hero?.name ?? ''} · ${why}`;
				aiResult = null;
				save();
			} finally {
				aiBusy = false;
				renderAll();
			}
		}

		/** 让模型替对面做决定。返回 null 时调用方退回数据里的第一顺位。 */
		async function askModelForOpponentMove(enemyAdvice: Advice, enemy: TeamSide): Promise<{ heroId: number; reason: string } | null> {
			const messages = buildAdviceMessages(
				{
					advice: enemyAdvice,
					data: draft,
					// 视角翻转：从对面看，它自己是"我方"，屏幕前的人是"对面"。
					selfTeam: teamNameOf(enemy),
					foeTeam: teamNameOf(otherSide(enemy)),
					recorded,
					ourSide: enemy,
					firstPicker: firstPick,
					foeForm,
					signatures: signatures(),
				},
				'theirs',
			);
			// 网络、限流、超时、解析失败都退回数据决策，别让对战卡在这里——所以这里一律返回 null。
			const reply = await requestChat(ai, messages, { maxTokens: ADVICE_MAX_TOKENS });
			if (!reply.ok) return null;
			const parsed = parseAdviceReply(reply.content, allowedHeroIds(enemyAdvice));
			if (!parsed) return null;
			return { heroId: parsed.picks[0].heroId, reason: parsed.picks[0].reason };
		}

		function onHeroClick(heroId: number): void {
			// 阵容分析那条路上，点英雄池就是往阵容里加减人，与 24 手 BP 无关。
			if (mode === 'lineup') {
				toggleDirectHero(heroId);
				return;
			}
			const check = canPlay(recorded, heroId);
			if (!check.ok) {
				setHint(check.reason ?? '这一手不能用这个英雄');
				return;
			}
			recorded = play(recorded, heroId);
			aiResult = null;
			const hero = heroById.get(heroId);
			setHint(`已记录：${tileLabel(recorded.length)} · ${hero?.name ?? ''}`);
			save();
			renderAll();
		}

		function renderAll(): void {
			applyMode();
			applyFilters();
			syncBoard();
			syncBanner();
			syncDirect();
			renderFoe();
			syncVerdictButton();
			renderAdvice();
			renderTeams();
			syncAiBlock();
		}

		/** 换队、改先选之后，上一次的预测与复盘都不再对应当前的盘面。 */
		function invalidateDerived(): void {
			prediction = null;
			rejected = '';
			if (predictStatus) predictStatus.textContent = '';
			renderPrediction();
			verdict = null;
			verdictAi = null;
			verdictKey = '';
			if (verdictStatus) verdictStatus.textContent = '';
			renderVerdict();
		}

		function bindControls(): void {
			element<HTMLButtonElement>('draft-undo')?.addEventListener('click', () => {
				cancelAutoMove();
				lastAiMove = '';
				aiStallStep = -1;
				recorded = undo(recorded);
				aiResult = null;
				setHint('撤销了一手');
				save();
				renderAll();
			});
			element<HTMLButtonElement>('draft-skip')?.addEventListener('click', () => {
				cancelAutoMove();
				aiStallStep = -1;
				recorded = skip(recorded);
				aiResult = null;
				setHint('这一手跳过了');
				save();
				renderAll();
			});
			element<HTMLButtonElement>('draft-reset')?.addEventListener('click', () => {
				if (recorded.length > 0 && !window.confirm('清空这一局录进去的 BP？')) return;
				cancelAutoMove();
				lastAiMove = '';
				aiStallStep = -1;
				recorded = [];
				aiResult = null;
				setHint('');
				save();
				renderAll();
			});

			element<HTMLInputElement>('draft-search')?.addEventListener('input', (event) => {
				query = (event.target as HTMLInputElement).value;
				syncPool();
			});

			document.querySelectorAll<HTMLButtonElement>('[data-attr]').forEach((button) => {
				button.addEventListener('click', () => {
					attrFilter = button.dataset.attr ?? 'all';
					document.querySelectorAll<HTMLButtonElement>('[data-attr]').forEach((other) => {
						other.setAttribute('aria-pressed', String(other === button));
					});
					applyFilters();
				});
			});

			document.querySelectorAll<HTMLButtonElement>('[data-position]').forEach((button) => {
				button.addEventListener('click', () => {
					positionFilter = button.dataset.position ?? 'all';
					document.querySelectorAll<HTMLButtonElement>('[data-position]').forEach((other) => {
						other.setAttribute('aria-pressed', String(other === button));
					});
					syncPool();
				});
			});

			document.querySelectorAll<HTMLButtonElement>('[data-my-side]').forEach((button) => {
				button.addEventListener('click', () => {
					mySide = button.dataset.mySide === 'dire' ? 'dire' : 'radiant';
					aiResult = null;
					// 两份数据都还在（两边的近况与选边无关），只是"对面"换成另一边了。
					foeForm = forms[otherSide(mySide)];
					syncSideButtons();
					save();
					renderAll();
					scheduleFoe();
				});
			});

			document.querySelectorAll<HTMLButtonElement>('[data-first-pick]').forEach((button) => {
				button.addEventListener('click', () => {
					firstPick = button.dataset.firstPick === 'dire' ? 'dire' : 'radiant';
					aiResult = null;
					syncSideButtons();
					slots.clear();
					invalidateDerived();
					save();
					renderAll();
				});
			});

			document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
				button.addEventListener('click', () => {
					mode = isMode(button.dataset.tab) ? button.dataset.tab : 'predict';
					// 切走时把自动出招停掉：预测/复盘两条路没有「轮到谁」，后台接着走会莫名其妙地写满盘面。
					if (mode !== 'versus') cancelAutoMove();
					save();
					renderAll();
				});
			});

			const onTeamChange = (side: TeamSide): void => {
				const value = (side === 'radiant' ? radiantSelect : direSelect)?.value ?? '';
				if (side === 'radiant') radiantTeamId = value;
				else direTeamId = value;
				// 换了队：这一边的近况作废（另一边的不动），预测与复盘也要重来。
				formKeys[side] = '';
				forms[side] = null;
				foeForm = forms[otherSide(mySide)];
				invalidateDerived();
				save();
				renderAll();
				scheduleFoe();
			};
			radiantSelect?.addEventListener('change', () => onTeamChange('radiant'));
			direSelect?.addEventListener('change', () => onTeamChange('dire'));

			adviceToggle?.addEventListener('click', () => {
				adviceOpen = !adviceOpen;
				renderAdvice();
			});
			adviceAi?.addEventListener('click', () => {
				void explainWithModel();
			});

			verdictBtn?.addEventListener('click', () => {
				void analyzeVerdict();
			});

			predictRun?.addEventListener('click', () => {
				void runPrediction();
			});

			directRadiantBtn?.addEventListener('click', () => {
				directSide = 'radiant';
				syncDirect();
			});
			directDireBtn?.addEventListener('click', () => {
				directSide = 'dire';
				syncDirect();
			});
			// 格子是每次重建的，所以用委托：点已填的格子把那个英雄移出去。
			directPanel?.addEventListener('click', (event) => {
				const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('.direct-slot');
				const heroId = Number(cell?.dataset.heroId);
				if (!cell || !Number.isSafeInteger(heroId) || heroId <= 0) return;
				toggleDirectHero(heroId);
			});

			aiSideInput?.addEventListener('change', () => {
				aiSidePref = Boolean(aiSideInput.checked);
				aiSide = isConfigured(ai) && aiSidePref;
				cancelAutoMove();
				aiStallStep = -1;
				save();
				syncAiBlock();
			});
			aiPlay?.addEventListener('click', () => {
				cancelAutoMove();
				void playOpponentMove();
			});

			// 配置的那两条回边，见 refreshAiConfig 的注释。
			window.addEventListener('pageshow', (event) => {
				if (event.persisted) refreshAiConfig();
			});
			window.addEventListener('storage', (event) => {
				if (event.key === AI_STORE_KEY) refreshAiConfig();
			});
		}

		function syncSideButtons(): void {
			document.querySelectorAll<HTMLButtonElement>('[data-my-side]').forEach((button) => {
				button.setAttribute('aria-pressed', String(button.dataset.mySide === mySide));
			});
			document.querySelectorAll<HTMLButtonElement>('[data-first-pick]').forEach((button) => {
				button.setAttribute('aria-pressed', String(button.dataset.firstPick === firstPick));
			});
		}

		/**
		 * 配置状态那一行。
		 *
		 * **本页不再能改配置**：表单在 `/settings`，这里只说明现在是什么状态、并给一个入口。
		 * 文案取 `aiConfig` 的三态，本页再补上「对面会由谁出招」这半句。
		 */
		function syncAiState(extra?: string): void {
			if (!aiState) return;
			aiState.textContent = extra ?? (isConfigured(ai) ? aiStateLabel(ai) : `${aiStateLabel(ai)}；对面由本地数据出招`);
		}

		/**
		 * 把与模型有关的控件摆到与配置一致的位置。
		 *
		 * 没配置时**禁用**「对面交给 AI」：开关能点、点了却什么也没接上，等于在骗人。
		 * 这与「按钮别随便禁用」那条老规矩不冲突——那说的是禁用之后没人告诉用户为什么；
		 * 这里禁用时旁边就写着原因和入口。
		 */
		function syncAiControls(): void {
			const configured = isConfigured(ai);
			if (!configured && aiSide) {
				// 被配置逼着关掉的值不写回存储，见 aiSidePref 的注释。
				aiSide = false;
				if (aiSideInput) aiSideInput.checked = false;
			}
			if (aiSideInput) aiSideInput.disabled = !configured;
			// 原因写在开关旁边（设置区那份隔着一百多行，用户第一反应是盯着这个灰掉的开关）。
			if (aiHint) aiHint.textContent = configured ? '' : '未配置模型，对面由本地数据出招';
			syncAiState();
		}

		/**
		 * 配置在别处被改了就把这一页也跟上。
		 *
		 * 之前只在加载时读一次，于是「去 /settings 填好再按返回键回来」这一路是坏的：
		 * 从 bfcache 退回来时脚本根本不会重跑，页面继续按「未配置模型」渲染；另一个标签页里
		 * 保存了新 key，这一页也还在用旧的发请求。两条路各有一个事件：
		 * `pageshow`（persisted 为真 = 从缓存恢复）与 `storage`（另一个标签页写进了同一个键）。
		 */
		function refreshAiConfig(): void {
			const next = loadAiConfig();
			if (sameAiConfig(next, ai)) return;
			/*
			 * 换了地址 / key / 模型：台头会立刻改成新状态，但上一份建议还是按旧配置问出来的，
			 * 再挂在面板上就是"假装有 AI"（清掉 key 之后尤其明显：上面写「未配置模型」，
			 * 下面还列着上一个模型的 picks 与「AI：…」摘要）。只改测试结果不算换配置，那份建议仍然有效。
			 *
			 * 复盘面板那段文字（`verdictAi`）与预测那份结果（`prediction`）是同一件事的两处，
			 * 得一起撤；它们不挂在 `renderAll()` 里，还要专门重画一次，否则文字会留在原地。
			 */
			if (!sameAiTarget(next, ai)) {
				aiGeneration += 1;
				aiResult = null;
				verdictAi = null;
				// 预测那份如果是模型给的，同样不能再挂着：换了模型，那段话不是它说的了。
				if (prediction?.source === 'model') prediction = null;
				renderVerdict();
				renderPrediction();
			}
			ai = next;
			aiSide = isConfigured(ai) && aiSidePref;
			if (aiSideInput) aiSideInput.checked = aiSide;
			syncAiControls();
			renderAll();
		}

		// ------------------------------------------------------------ 模型调用

		function setStatus(text: string): void {
			if (adviceStatus) adviceStatus.textContent = text;
		}

		/**
		 * 让模型解释这一手。请求体里的候选、数字全部来自本地计算结果，
		 * 模型只负责排序与措辞；解析不过就当这次没结果。
		 */
		async function explainWithModel(): Promise<void> {
			if (!isConfigured(ai)) {
				setStatus('没配置模型；建议由本站数据算出，配置之后才会多一段解释（入口在下面「AI 解释」的设置里）');
				// 原来这里把焦点挪到 key 输入框。输入框搬去 /settings 之后，留在本页能做的是
				// 把配置那一行推到眼前：直接跳页会让人以为刚录的 BP 丢了。
				aiConfigBox?.scrollIntoView({ block: 'center', behavior: 'smooth' });
				return;
			}
			const advice = currentAdvice();
			if (!advice) {
				setStatus('没有可建议的一手');
				return;
			}
			const messages = buildAdviceMessages({
				advice,
				data: draft,
				// 给我方出主意：视角里的"自己"就是屏幕前的人在打的那支队。
				selfTeam: teamNameOf(mySide),
				foeTeam: teamNameOf(otherSide(mySide)),
				recorded,
				ourSide: mySide,
				firstPicker: firstPick,
				foeForm,
				signatures: signatures(),
			});
			setStatus('模型思考中…');
			if (adviceAi) adviceAi.disabled = true;
			const generation = aiGeneration;
			try {
				const reply = await requestChat(ai, messages, { maxTokens: ADVICE_MAX_TOKENS });
				// 与复盘那条同理：配置在飞行中被改了，这份按旧配置问来的解释不能挂到面板上。
				if (generation !== aiGeneration) return;
				if (!reply.ok) {
					setStatus(chatErrorMessage(reply));
					return;
				}
				const content = reply.content;
				if (!content.trim()) {
					// 实测过的一种情况：模型把上限全用在思考上，content 是空的。
					// 请求里已经关了思考，这里只是兜底，别让用户看到"点了没反应"。
					setStatus(reply.finishReason === 'length' ? '模型输出被截断，再点一次试试' : '模型这次返回了空内容，再点一次试试');
					return;
				}
				const parsed = parseAdviceReply(content, allowedHeroIds(advice));
				if (!parsed) {
					setStatus('模型这次没给出可用结果，重试或按数据面板判断');
					return;
				}
				aiResult = parsed;
				setStatus('已由模型解释');
				renderAdvice();
			} catch {
				setStatus('请求发不出去，检查网络或代理');
			} finally {
				if (adviceAi) adviceAi.disabled = false;
			}
		}

		// ------------------------------------------------------------ 启动

		/*
		 * 选择框的值来自存储里的队伍 id。选项是服务端渲染出来的，所以这里只是把值对回去；
		 * 存的队伍已经不在名录里（改名、降级被移出门户）时，`select.value` 会是空串，
		 * 页面就按「未指定」走——不硬塞一个看起来像那么回事的队名。
		 */
		if (radiantSelect) radiantSelect.value = radiantTeamId;
		if (direSelect) direSelect.value = direTeamId;
		if (aiSideInput) aiSideInput.checked = aiSide;
		/*
		 * 队伍目录优先用页面内联的那份：装在 `renderAll()` 之前，所以首屏画出来的就是真卡片，
		 * 不会先闪一下"未指定队伍"。内联那份缺失或坏了才走网络（见 `loadTeamsFromNetwork`）。
		 */
		const teams = readTeams();
		if (teams) applyTeams(teams);
		buildPool();
		buildBoard();
		bindControls();
		syncSideButtons();
		syncAiControls();
		renderAll();
		renderPrediction();
		if (!teams) void loadTeamsFromNetwork();
		// 线上对位是可选增强，慢慢取，取到了自己会重画一次。
		void loadLanes();
	}
}
