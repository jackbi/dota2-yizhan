/*
 * 相对导入带 `.ts` 后缀：这些模块要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { DraftData, DraftHero } from '../lib/draftData.ts';
import { ATTRIBUTE_ICON } from '../lib/heroApi';
import {
	ADVICE_TARGET_COUNT,
	DEEPSEEK_ENDPOINT,
	DEFAULT_DEEPSEEK_MODEL,
	buildAdviceMessages,
	buildChatRequest,
	buildVerdictMessages,
	parseAdviceReply,
	parseVerdictReply,
	VERDICT_MAX_TOKENS,
} from '../lib/draftPrompt.ts';
import type { Advice, AdviceCandidate } from '../lib/draftScore.ts';
import { advise } from '../lib/draftScore.ts';
import type { DraftVerdict } from '../lib/draftVerdict.ts';
import { buildVerdict } from '../lib/draftVerdict.ts';
import type { DraftSide } from '../lib/draftOrder.ts';
import { CM_PHASE_STARTS, CM_STEPS, canPlay, otherSide, play, sideOfOwner, skip, snapshot, undo } from '../lib/draftOrder.ts';
import type { FoeForm } from '../lib/draftFoe.ts';
import { foeHeadline, foeHighlights, foeWinRate } from '../lib/draftFoe.ts';

/**
 * 队伍名的正规化规则，**必须与 `opendota.ts` 里的 `norm` 逐字一致**：
 * `/draft-teams.json` 的键就是用那条规则算出来的，差一个字符就查不到队伍。
 * `scripts/draftFoe.check.ts` 会把两处源码放在一起比对，改了一边漏了另一边会直接失败。
 */
const normTeamName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

/**
 * 阵容分析页的客户端：录制 BP、算建议、可选地让 DeepSeek 解释。
 *
 * 有两条边界写在这里而不是服务端：
 * - **DeepSeek 的 key 只存在这台浏览器**（localStorage），请求由浏览器直接发给 DeepSeek，
 *   站点不经手。这也是这个功能能开源的前提：别人 clone 之后用自己的 key，作者不承担费用。
 * - **建议的排序不依赖模型**。候选、号位、胜率、样本量都是本地算的（`draftScore`），
 *   模型拿到的是算好的候选，只能在里面排个序、写段解释。它挂了、key 无效、余额不足，
 *   数据面板照常可用。
 *
 * DOM 只建一次：英雄池 127 个格子、两边各 12 个 BP 格子先建好，状态变化时改属性而不是
 * 重建节点。重建会让浏览器反复解码头像，点起来一顿一顿的。
 */

const STORE_KEY = 'd2s-draft-v1';
const ATTR_LABEL: Record<string, string> = { STR: '力量', AGI: '敏捷', INT: '智力', UNI: '全才' };
const ATTR_ORDER = ['STR', 'AGI', 'INT', 'UNI'];

type TeamSide = DraftSide;

function element<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

/**
 * 拼 HTML 时的转义。模型的回复要经过这一层再插进 DOM：提示词里带着用户填的队名，
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

interface Stored {
	recorded?: (number | null)[];
	ourSide?: TeamSide;
	firstPick?: 'ours' | 'theirs';
	ourTeam?: string;
	theirTeam?: string;
	key?: string;
	model?: string;
	/** 对面是不是交给 AI（默认是）。 */
	aiSide?: boolean;
	/** 跳过 24 手 BP，直接给两边各选五个英雄。 */
	directMode?: boolean;
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

	let recorded: (number | null)[] = Array.isArray(stored.recorded) ? stored.recorded.slice(0, 24) : [];
	let ourSide: TeamSide = stored.ourSide === 'dire' ? 'dire' : 'radiant';
	let firstPick: 'ours' | 'theirs' = stored.firstPick === 'theirs' ? 'theirs' : 'ours';
	let ourTeam = typeof stored.ourTeam === 'string' ? stored.ourTeam : '';
	let theirTeam = typeof stored.theirTeam === 'string' ? stored.theirTeam : '';
	let model = typeof stored.model === 'string' && stored.model ? stored.model : DEFAULT_DEEPSEEK_MODEL;
	let aiSide = stored.aiSide !== false;
	let attrFilter = 'all';
	let positionFilter = 'all';
	let query = '';
	let adviceOpen = false;
	let aiResult: { picks: { heroId: number; position: number; reason: string; risk: string }[]; summary: string } | null = null;
	/** AI 正在替对面决策，避免自动出招被重复触发。 */
	let aiBusy = false;
	/** 自动出招的定时器；撤销、清空、关掉开关都要能取消它。 */
	let aiTimer: number | null = null;
	/** 某一步没有可用候选时记下手号，避免自动出招在同一手上反复重试。 */
	let aiStallStep = -1;
	/** 对面上一手的决定，轮到它时显示。 */
	let lastAiMove = '';
	/** 对面近期的英雄偏好。指定了队名才去取，取不到就整段不用。 */
	let foeForm: FoeForm | null = null;
	/** 当前这份数据属于哪支队，用来丢弃过期响应（换队名比响应快时）。 */
	let foeRequestKey = '';
	/** 取数状态的文案：'' 表示没在取、也没有错。 */
	let foeStatus = '';
	/** 队名 → 队伍 id 的索引。只有手填队名那条路才需要，所以按需拉一次。 */
	let teamIndexPromise: Promise<Map<string, number>> | null = null;
	/** 队名是打出来的，等手停下来再取，省掉一整串半截队名的请求。 */
	let foeTimer: number | null = null;
	/** 双方阵容锁定后的对比结果；BP 一变就作废。 */
	let verdict: DraftVerdict | null = null;
	/** 模型写的那段文字（数字仍然来自 `verdict`）。 */
	let verdictAi: { summary: string; points: { dimension: string; text: string }[] } | null = null;
	/** 这份对比对应的盘面指纹：撤销、改录之后不能留着对不上的结论。 */
	let verdictKey = '';
	/** 「直接选阵容」模式：不走 24 手 BP，两边各挑五个英雄直接比。 */
	let directMode = stored.directMode === true;
	let directOurs: number[] = Array.isArray(stored.directOurs) ? stored.directOurs.filter((id) => typeof id === 'number').slice(0, 5) : [];
	let directTheirs: number[] = Array.isArray(stored.directTheirs) ? stored.directTheirs.filter((id) => typeof id === 'number').slice(0, 5) : [];
	/** 现在往哪一边填。 */
	let directSide: 'ours' | 'theirs' = 'ours';

	const firstPickerSide = (): TeamSide => (firstPick === 'ours' ? ourSide : otherSide(ourSide));
	const otherTeamSide = (): TeamSide => otherSide(ourSide);

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
	const compositionLine = element<HTMLParagraphElement>('draft-composition');
	const adviceCards = element<HTMLDivElement>('draft-advice-cards');
	const lineupBox = element<HTMLDivElement>('draft-lineup');
	const foeStatusEl = element<HTMLParagraphElement>('draft-foe-status');
	const verdictBtn = element<HTMLButtonElement>('draft-verdict');
	const verdictStatus = element<HTMLSpanElement>('draft-verdict-status');
	const verdictBox = element<HTMLDivElement>('draft-verdict-box');
	const directToggle = element<HTMLInputElement>('draft-direct-mode');
	const directPanel = element<HTMLDivElement>('draft-direct-panel');
	const directOursBtn = element<HTMLButtonElement>('draft-direct-ours');
	const directTheirsBtn = element<HTMLButtonElement>('draft-direct-theirs');
	const directHint = element<HTMLSpanElement>('draft-direct-hint');
	const boardPanel = element<HTMLDivElement>('draft-board-panel');
	const advicePanel = element<HTMLElement>('draft-advice-panel');
	const keyInput = element<HTMLInputElement>('draft-key');
	const keyState = element<HTMLSpanElement>('draft-key-state');
	const modelSelect = element<HTMLSelectElement>('draft-model');
	const ourTeamInput = element<HTMLInputElement>('draft-our-team');
	const theirTeamInput = element<HTMLInputElement>('draft-their-team');
	const matchSelect = element<HTMLSelectElement>('draft-match');
	const aiSideInput = element<HTMLInputElement>('draft-ai-side');
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

	function run(): void {
		// ------------------------------------------------------------ 状态

		const snapshotNow = () => snapshot(recorded);
		const sideLabel = (side: TeamSide): string => {
			if (side === ourSide) return ourTeam.trim() || '我方';
			return theirTeam.trim() || '对方';
		};

		const save = (): void => {
			try {
				localStorage.setItem(
					STORE_KEY,
					JSON.stringify({ recorded, ourSide, firstPick, ourTeam, theirTeam, key: keyInput?.value ?? '', model, aiSide, directMode, directOurs, directTheirs }),
				);
			} catch {
				// 隐私模式下写不进去，不影响使用。
			}
		};

		/** 对面这一手轮到谁在动、动的是禁用还是挑选。 */
		const currentTurn = (): { ours: boolean; action: 'ban' | 'pick'; side: TeamSide } | null => {
			const state = snapshotNow();
			if (state.done || !state.owner || !state.action) return null;
			const side = sideOfOwner(state.owner, firstPickerSide());
			return { ours: side === ourSide, action: state.action, side };
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
			const side = sideOfOwner(entry.owner, firstPickerSide());
			const action = entry.action === 'ban' ? '禁用' : '挑选';
			return `第 ${step} 手 ${side === ourSide ? '我方' : '对方'}${action}`;
		}

		function syncPool(): void {
			const state = snapshotNow();
			const needle = query.trim().toLowerCase();
			const position = positionFilter === 'all' ? null : Number(positionFilter);
			let visible = 0;

			for (const hero of draft.heroes) {
				const tile = tiles.get(hero.id);
				if (!tile) continue;
				// 直接模式下已经录的 24 手 BP 不参与：那套东西与「直接选阵容」是两条独立的路。
				const usedAt = directMode ? undefined : state.used.get(hero.id);
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
				} else if (directMode && directOwner(hero.id)) {
					// 直接模式下「已经选了」看的是这套阵容，不是 24 手 BP。
					tile.dataset.used = 'pick';
					tile.dataset.usedLabel = directOwner(hero.id) === 'ours' ? '我方阵容' : '对方阵容';
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
			const first = firstPickerSide();
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
			if (builtFor !== firstPickerSide() || slots.size !== CM_STEPS.length) buildBoard();
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

			// 列头固定写阵营名，队名与我方/先选的标记挂在旁边，跟客户端一致。
			const radiantLabel = element<HTMLSpanElement>('draft-label-radiant');
			const direLabel = element<HTMLSpanElement>('draft-label-dire');
			if (radiantLabel) radiantLabel.textContent = '天辉';
			if (direLabel) direLabel.textContent = '夜魇';
			for (const side of ['radiant', 'dire'] as TeamSide[]) {
				const badge = element<HTMLSpanElement>(`draft-badge-${side}`);
				if (!badge) continue;
				const bits = [sideLabel(side)];
				if (side === firstPickerSide()) bits.push('先选');
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
			const ours = sideOfOwner(state.owner ?? 'first', firstPickerSide()) === ourSide;
			const action = state.action === 'ban' ? '禁用' : '挑选';
			bannerStep.textContent = `第 ${state.nextStep} 手`;
			bannerTurn.textContent = `${ours ? '我方' : '对方'}${action}`;
			const tail = state.tail;
			const tailSide = sideOfOwner(tail.ban, firstPickerSide()) === ourSide ? '我方' : '对方';
			bannerDetail.textContent = `我方还剩 ${state.remaining[firstPick === 'ours' ? 'first' : 'second'].bans} 禁 ${
				state.remaining[firstPick === 'ours' ? 'first' : 'second'].picks
			} 选 · 最后一手禁用和最后一手挑选都在${tailSide}`;
		}

		// ------------------------------------------------------------ 对面擅长什么

		/** 队名 → 队伍 id 的索引，只在手填队名时才需要，所以按需拉、拉一次。 */
		async function loadTeamIndex(): Promise<Map<string, number>> {
			teamIndexPromise ??= fetch('/draft-teams.json')
				.then((res) => (res.ok ? (res.json() as Promise<[string, number][]>) : []))
				.then((rows) => new Map(rows))
				// 拉不到就当「查不到这支队」：这是锦上添花的依据，不该影响录 BP。
				.catch(() => new Map<string, number>());
			return teamIndexPromise;
		}

		/**
		 * 队伍名 → OpenDota 队伍 id。
		 *
		 * 赛程下拉里选中的那一场，两边 id 是构建期写进 option 的，直接采信；手填队名才回落到
		 * 索引（多一次请求）。两条路都必须走同一套正规化规则，否则「Team Spirit」和
		 * 「team spirit」会一个查得到一个查不到。
		 */
		async function resolveTeamId(name: string): Promise<number | null> {
			const key = normTeamName(name);
			if (!key) return null;
			const option = matchSelect?.selectedOptions[0];
			if (option?.value) {
				const pairs: [string, string | undefined][] = [
					[option.dataset.home ?? '', option.dataset.homeId],
					[option.dataset.away ?? '', option.dataset.awayId],
				];
				for (const [optionName, rawId] of pairs) {
					const id = Number(rawId);
					if (normTeamName(optionName) === key && Number.isSafeInteger(id) && id > 0) return id;
				}
			}
			const index = await loadTeamIndex();
			return index.get(`n:${key}`) ?? index.get(`t:${key}`) ?? null;
		}

		/**
		 * 取对方那支队近期的英雄偏好。**同一支队不重复取**，换队名时旧响应作废
		 * （网络比人慢，慢了半拍的结果回来时不能盖掉新的那支队）。
		 */
		async function syncFoeForm(): Promise<void> {
			const name = theirTeam.trim();
			const key = normTeamName(name);
			if (!key) {
				foeForm = null;
				foeRequestKey = '';
				foeStatus = '';
				renderFoe();
				renderAdvice();
				return;
			}

			const id = await resolveTeamId(name);
			if (id === null) {
				foeForm = null;
				foeRequestKey = `miss:${key}`;
				foeStatus = '按队名定位不到这支职业队伍，取不到对面的近期习惯';
				renderFoe();
				renderAdvice();
				return;
			}

			const requestKey = `${key}:${id}`;
			if (foeRequestKey === requestKey) return;
			foeRequestKey = requestKey;
			foeForm = null;
			foeStatus = `正在取 ${name} 近期的英雄偏好…`;
			renderFoe();
			try {
				const res = await fetch(`/api/draft/foe?id=${id}`);
				const body = (await res.json()) as { ok?: boolean; form?: FoeForm; reason?: string };
				if (foeRequestKey !== requestKey) return;
				if (body.ok && body.form) {
					foeForm = body.form;
					foeStatus = '';
				} else {
					foeForm = null;
					foeStatus = body.reason ?? '取不到对面的近期习惯';
				}
			} catch {
				if (foeRequestKey !== requestKey) return;
				foeForm = null;
				foeStatus = '取不到对面的近期习惯（网络或上游故障）';
			}
			renderFoe();
			renderAdvice();
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
			const text = foeStatus || (foeForm ? `对面擅长：${foeHeadline(foeForm)}${top ? `；常拿 ${top}` : ''}` : '');
			foeStatusEl.textContent = text;
			foeStatusEl.style.display = text ? '' : 'none';
		}

		/** 队名改完再取：每敲一个字母都发一次请求，既烧额度也拿不到有用的结果。 */
		function scheduleFoe(): void {
			if (foeTimer !== null) window.clearTimeout(foeTimer);
			foeTimer = window.setTimeout(() => {
				foeTimer = null;
				void syncFoeForm();
			}, 500);
		}

		// ------------------------------------------------------------ 直接选阵容（跳过 BP）

		const directLineup = (side: 'ours' | 'theirs'): number[] => (side === 'ours' ? directOurs : directTheirs);
		const setDirectLineup = (side: 'ours' | 'theirs', ids: number[]): void => {
			if (side === 'ours') directOurs = ids;
			else directTheirs = ids;
		};

		/** 这个英雄现在在直接阵容的哪一边；不在任何一边返回 null。 */
		function directOwner(heroId: number): 'ours' | 'theirs' | null {
			if (directOurs.includes(heroId)) return 'ours';
			if (directTheirs.includes(heroId)) return 'theirs';
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
				setHint(`已从${owner === 'ours' ? '我方' : '对方'}阵容移除 ${heroById.get(heroId)?.name ?? ''}`);
			} else {
				let target: 'ours' | 'theirs' = directSide;
				if (directLineup(target).length >= 5) target = target === 'ours' ? 'theirs' : 'ours';
				if (directLineup(target).length >= 5) {
					setHint('两边都满了，先点掉一个再选');
					return;
				}
				directSide = target;
				setDirectLineup(target, [...directLineup(target), heroId]);
				setHint(`已加入${target === 'ours' ? '我方' : '对方'}阵容：${heroById.get(heroId)?.name ?? ''}`);
			}
			// 阵容变了，上一次的复盘作废——留着会跟现在的阵容对不上。
			verdict = null;
			verdictAi = null;
			verdictKey = '';
			if (verdictStatus) verdictStatus.textContent = '';
			save();
			renderAll();
		}

		/** 直接模式的两排格子、当前填哪边、还有几个空位。 */
		function syncDirect(): void {
			if (!directPanel) return;
			if (!directMode) {
				directPanel.style.display = 'none';
				return;
			}
			directPanel.style.display = '';

			for (const side of ['ours', 'theirs'] as const) {
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

			if (directOursBtn) directOursBtn.setAttribute('aria-pressed', String(directSide === 'ours'));
			if (directTheirsBtn) directTheirsBtn.setAttribute('aria-pressed', String(directSide === 'theirs'));
			if (directHint) {
				const label = directSide === 'ours' ? ourTeam.trim() || '我方' : theirTeam.trim() || '对方';
				directHint.textContent = `接下来点英雄池会填到${label}（${directLineup(directSide).length}/5）`;
			}
		}

		/**
		 * 两种模式的显隐。直接模式下 BP 相关的界面（当前手、BP 板、逐手建议）整体收起来——
		 * 那条路上它们没有意义，留着只会让人以为还要录 BP。
		 */
		function applyMode(): void {
			const banner = element<HTMLDivElement>('draft-banner');
			if (banner) banner.style.display = directMode ? 'none' : '';
			if (boardPanel) boardPanel.style.display = directMode ? 'none' : '';
			if (advicePanel) advicePanel.style.display = directMode ? 'none' : '';
			if (directPanel) directPanel.style.display = directMode ? '' : 'none';
			if (directToggle) directToggle.checked = directMode;
			// 阵营、先选权、"对面交给 AI"、撤销/跳过/清空都只对 24 手 BP 有意义。
			for (const node of document.querySelectorAll<HTMLElement>('[data-bp-only]')) node.style.display = directMode ? 'none' : '';
		}

		// ------------------------------------------------------------ 阵容复盘（双方锁完之后）

		/** 已经录进阵容的英雄（被禁的不算），按阵营分。 */
		function pickedIds(side: DraftSide): number[] {
			const state = snapshotNow();
			const ids: number[] = [];
			for (let index = 0; index < state.cursor; index += 1) {
				const step = CM_STEPS[index];
				if (!step || step.action !== 'pick') continue;
				if (sideOfOwner(step.owner, firstPickerSide()) !== side) continue;
				const heroId = recorded[index];
				if (typeof heroId === 'number') ids.push(heroId);
			}
			return ids;
		}

		/** 盘面指纹：任何一手变化都会让它变。 */
		const recordedKey = (): string => recorded.map((heroId) => heroId ?? '-').join(',');

		/** 当前这份阵容的指纹：BP 模式看 24 手，直接模式看两套阵容。 */
		const lineupKey = (): string => (directMode ? `d:${directOurs.join(',')}|${directTheirs.join(',')}` : recordedKey());

		function currentVerdict(): DraftVerdict | null {
			return buildVerdict({
				data: draft,
				ourIds: directMode ? directOurs : pickedIds(ourSide),
				theirIds: directMode ? directTheirs : pickedIds(otherSide(ourSide)),
				ourSide,
				selfTeam: ourTeam,
				foeTeam: theirTeam,
				foeForm,
			});
		}

		/**
		 * 开放条件：双方各五个号位都落人。
		 *
		 * 阵容没锁就比，比的是「如果现在开打」——那不是这颗按钮要回答的问题（那是建议面板的活），
		 * 而且结论下一步就过期。所以宁可让它关着，用 title 说清还差几手。
		 */
		function syncVerdictButton(): void {
			const oursCount = directMode ? directOurs.length : pickedIds(ourSide).length;
			const theirsCount = directMode ? directTheirs.length : pickedIds(otherSide(ourSide)).length;
			const ready = oursCount >= 5 && theirsCount >= 5;
			if (verdictBtn) {
				verdictBtn.disabled = !ready;
				verdictBtn.title = ready
					? '双方阵容都锁定了，比较这套对局'
					: directMode
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

			const key = (keyInput?.value ?? '').trim();
			if (!key) {
				if (verdictStatus) verdictStatus.textContent = '数字已经算好；填上 DeepSeek key 才会有文字分析';
				return;
			}

			if (verdictStatus) verdictStatus.textContent = '模型分析中…';
			if (verdictBtn) verdictBtn.disabled = true;
			try {
				const messages = buildVerdictMessages({ verdict: built, data: draft, selfTeam: ourTeam, foeTeam: theirTeam, foeForm });
				const send = (jsonMode: boolean) =>
					fetch(DEEPSEEK_ENDPOINT, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
						body: JSON.stringify(buildChatRequest({ model, messages, jsonMode, maxTokens: VERDICT_MAX_TOKENS })),
					});
				let response = await send(true);
				if (response.status === 400) response = await send(false);
				if (!response.ok) {
					if (verdictStatus) verdictStatus.textContent = `模型没返回结果（HTTP ${response.status}），上面是本地算的数字`;
					return;
				}
				const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
				const parsed = parseVerdictReply(body.choices?.[0]?.message?.content ?? '');
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
			return advise({ data: draft, recorded, ourSide, firstPicker: firstPickerSide(), limit: 5, foeForm });
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
				if (adviceCards) adviceCards.innerHTML = '';
				if (lineupBox) lineupBox.innerHTML = '';
				if (adviceAi) adviceAi.style.display = 'none';
				return;
			}
			if (adviceAi) adviceAi.style.display = '';
			if (adviceSummary) {
				adviceSummary.textContent = aiResult?.summary ? `${advice.summary} AI：${aiResult.summary}` : advice.summary;
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
			if (aiResult) {
				for (const pick of aiResult.picks) {
					const candidate = advice.candidates.find((item) => item.heroId === pick.heroId);
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
			};

			for (const item of ordered.slice(0, aiResult ? ADVICE_TARGET_COUNT + 2 : 5)) appendCard(item);

			/**
			 * 「对面擅长」单列一栏，不并进上面的排序：上面那些是号位胜率算出来的，
			 * 这些是**对面近期真的在拿**的。BP 里两者的用法不同，混着排会让谁更熟悄悄主导顺序。
			 */
			if (advice.foeCandidates.length > 0) {
				const heading = document.createElement('p');
				heading.className = 'mt-2 text-xs font-semibold text-gold';
				heading.textContent = `对面近期拿过的（${foeHeadline(foeForm)}）`;
				adviceCards.append(heading);
				for (const candidate of advice.foeCandidates) appendCard({ candidate, reason: candidate.reasons, risk: candidate.risk });
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
			// 直接模式没有「轮到谁」，自动出招必须停掉——否则它会在后台把 24 手 BP 一路走完。
			if (directMode) {
				cancelAutoMove();
				if (aiMoveBox) aiMoveBox.style.display = 'none';
				return;
			}
			const turn = currentTurn();
			const opponentTurn = Boolean(turn && !turn.ours);
			// 轮到我们时也留着这一行：对面刚禁/刚选了什么、为什么，是这一手要参考的信息。
			if (aiMoveBox) aiMoveBox.style.display = opponentTurn || lastAiMove ? '' : 'none';
			if (adviceToggle) adviceToggle.style.display = turn && turn.ours ? '' : 'none';
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
			if (aiWho) aiWho.textContent = `${sideLabel(turn.side)}（AI）${actionText}`;
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
			if (aiStatus) aiStatus.textContent = lastAiMove || '这一手由你代打，直接点英雄池';
			if (aiPlay) aiPlay.style.display = aiSide ? 'none' : '';
		}

		/**
		 * 对面这一手怎么走。**数据先算、模型后挑**：先用对面的视角算出候选，
		 * 有 key 就让模型在里面挑一个并说明，没有 key（或调用失败）就直接取数据里的第一顺位。
		 * 所以不配 key 也能和 AI 对着打，只是它不会说话。
		 */
		async function playOpponentMove(): Promise<void> {
			const turn = currentTurn();
			if (aiBusy || !turn || turn.ours) return;
			aiBusy = true;
			syncAiBlock();
			try {
				// 替对面落子：同一份「对面擅长」的数据这时是**它自己**的，人称靠 foeSide 翻过来。
				const enemyAdvice = advise({ data: draft, recorded, ourSide: turn.side, firstPicker: firstPickerSide(), limit: 5, foeForm, foeSide: 'ours' });
				if (!enemyAdvice || enemyAdvice.candidates.length === 0) {
					lastAiMove = '这一步没有可用候选，撤销或跳过后再来';
					aiStallStep = snapshotNow().nextStep;
					return;
				}

				let heroId = enemyAdvice.candidates[0].heroId;
				let reason = '';
				if ((keyInput?.value ?? '').trim()) {
					const decided = await askModelForOpponentMove(enemyAdvice, turn.side);
					if (decided) {
						heroId = decided.heroId;
						reason = decided.reason;
					}
				}

				recorded = play(recorded, heroId);
				const hero = heroById.get(heroId);
				const actionText = turn.action === 'ban' ? '禁用' : '挑选';
				const why = reason || '按号位胜率与剩余手数判断';
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
			try {
				const messages = buildAdviceMessages(
					{
						advice: enemyAdvice,
						data: draft,
						// 视角翻转：从对面看，它自己是"我方"，屏幕前的人是"对面"。
						selfTeam: theirTeam,
						foeTeam: ourTeam,
						recorded,
						ourSide: enemy,
						firstPicker: firstPickerSide(),
						foeForm,
					},
					'theirs',
				);
				const response = await fetch(DEEPSEEK_ENDPOINT, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(keyInput?.value ?? '').trim()}` },
					body: JSON.stringify(buildChatRequest({ model, messages })),
				});
				if (!response.ok) return null;
				const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
				const parsed = parseAdviceReply(body.choices?.[0]?.message?.content ?? '', allowedHeroIds(enemyAdvice));
				if (!parsed) return null;
				return { heroId: parsed.picks[0].heroId, reason: parsed.picks[0].reason };
			} catch {
				// 网络、限流、解析失败都退回数据决策，别让对战卡在这里。
				return null;
			}
		}

		function onHeroClick(heroId: number): void {
			// 直接选阵容那条路上，点英雄池就是往阵容里加减人，与 24 手 BP 无关。
			if (directMode) {
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
			syncAiBlock();
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

			document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((button) => {
				button.addEventListener('click', () => {
					ourSide = button.dataset.side === 'dire' ? 'dire' : 'radiant';
					aiResult = null;
					syncSideButtons();
					save();
					renderAll();
				});
			});

			document.querySelectorAll<HTMLButtonElement>('[data-first-pick]').forEach((button) => {
				button.addEventListener('click', () => {
					firstPick = button.dataset.firstPick === 'theirs' ? 'theirs' : 'ours';
					aiResult = null;
					syncSideButtons();
					slots.clear();
					save();
					renderAll();
				});
			});

			ourTeamInput?.addEventListener('input', () => {
				ourTeam = ourTeamInput.value;
				save();
				syncBoard();
			});
			theirTeamInput?.addEventListener('input', () => {
				theirTeam = theirTeamInput.value;
				save();
				syncBoard();
				// 对方换了人，「对面擅长什么」跟着换；手停下再取。
				scheduleFoe();
			});

			matchSelect?.addEventListener('change', () => {
				const option = matchSelect.selectedOptions[0];
				ourTeam = option?.dataset.home ?? '';
				theirTeam = option?.dataset.away ?? '';
				if (ourTeamInput) ourTeamInput.value = ourTeam;
				if (theirTeamInput) theirTeamInput.value = theirTeam;
				save();
				syncBoard();
				scheduleFoe();
			});

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

			directToggle?.addEventListener('change', () => {
				directMode = directToggle.checked;
				// 切模式时把不要的那条路收拾干净：自动出招要停，复盘结果也不再对应现在的阵容。
				if (directMode) cancelAutoMove();
				verdict = null;
				verdictAi = null;
				verdictKey = '';
				if (verdictStatus) verdictStatus.textContent = '';
				save();
				renderAll();
			});
			directOursBtn?.addEventListener('click', () => {
				directSide = 'ours';
				syncDirect();
			});
			directTheirsBtn?.addEventListener('click', () => {
				directSide = 'theirs';
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
				aiSide = Boolean(aiSideInput.checked);
				cancelAutoMove();
				aiStallStep = -1;
				save();
				syncAiBlock();
			});
			aiPlay?.addEventListener('click', () => {
				cancelAutoMove();
				void playOpponentMove();
			});

			keyInput?.addEventListener('change', () => {
				save();
				syncKeyState();
			});
			modelSelect?.addEventListener('change', () => {
				model = modelSelect.value;
				save();
			});
			element<HTMLButtonElement>('draft-clear')?.addEventListener('click', () => {
				if (keyInput) keyInput.value = '';
				save();
				syncKeyState('已清除');
			});
			element<HTMLButtonElement>('draft-test')?.addEventListener('click', () => {
				void testConnection();
			});
		}

		function syncSideButtons(): void {
			document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((button) => {
				button.setAttribute('aria-pressed', String(button.dataset.side === ourSide));
			});
			document.querySelectorAll<HTMLButtonElement>('[data-first-pick]').forEach((button) => {
				button.setAttribute('aria-pressed', String(button.dataset.firstPick === firstPick));
			});
		}

		function syncKeyState(extra?: string): void {
			if (!keyState) return;
			const has = (keyInput?.value ?? '').trim().length > 0;
			keyState.textContent = extra ?? (has ? 'key 只存在这台浏览器' : '还没填 key');
			// 故意**不**在没有 key 时禁用按钮：禁用状态下点击不触发事件，用户只会看到"点了没反应"，
			// 反而不知道要先去填 key。
		}

		// ------------------------------------------------------------ DeepSeek

		function setStatus(text: string): void {
			if (adviceStatus) adviceStatus.textContent = text;
		}

		async function testConnection(): Promise<void> {
			const key = (keyInput?.value ?? '').trim();
			if (!key) {
				syncKeyState('先填 key');
				return;
			}
			syncKeyState('测试中…');
			try {
				const response = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${key}` } });
				syncKeyState(response.ok ? '连接正常' : `失败：HTTP ${response.status}`);
			} catch {
				syncKeyState('连不上，检查网络或代理');
			}
		}

		/**
		 * 让模型解释这一手。请求体里的候选、数字全部来自本地计算结果，
		 * 模型只负责排序与措辞；解析不过就当这次没结果。
		 */
		async function explainWithModel(): Promise<void> {
			const key = (keyInput?.value ?? '').trim();
			if (!key) {
				setStatus('先在下面填 DeepSeek key');
				keyInput?.focus();
				keyInput?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
				// 给我方出主意：视角里的"自己"就是屏幕前的人。
				selfTeam: ourTeam,
				foeTeam: theirTeam,
				recorded,
				ourSide,
				firstPicker: firstPickerSide(),
				foeForm,
			});
			setStatus('模型思考中…');
			if (adviceAi) adviceAi.disabled = true;
			try {
				/**
				 * 发一次请求。`jsonMode` 为假时去掉 `response_format`：
				 * 这个参数万一不受支持会被 400 拒掉，而解析层本来就能处理带代码块围栏的回复，
				 * 所以退一步继续用，不要让整个功能跟着挂掉。
				 */
				const send = (jsonMode: boolean) =>
					fetch(DEEPSEEK_ENDPOINT, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
						body: JSON.stringify(buildChatRequest({ model, messages, jsonMode })),
					});
				let response = await send(true);
				if (response.status === 400) {
					response = await send(false);
				}
				if (!response.ok) {
					const text = await response.text().catch(() => '');
					setStatus(
						response.status === 401
							? 'key 无效或已过期'
							: response.status === 402
								? 'DeepSeek 余额不足'
								: response.status === 429
									? '触发限流，稍后再试'
									: `请求失败（HTTP ${response.status}）${text.slice(0, 80)}`,
					);
					return;
				}
				const body = (await response.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
				const choice = body.choices?.[0];
				const content = choice?.message?.content ?? '';
				if (!content.trim()) {
					// 实测过的一种情况：模型把上限全用在思考上，content 是空的。
					// 请求里已经关了思考，这里只是兜底，别让用户看到"点了没反应"。
					setStatus(choice?.finish_reason === 'length' ? '模型输出被截断，再点一次试试' : '模型这次返回了空内容，再点一次试试');
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

		if (ourTeamInput) ourTeamInput.value = ourTeam;
		if (theirTeamInput) theirTeamInput.value = theirTeam;
		if (keyInput) keyInput.value = typeof stored.key === 'string' ? stored.key : '';
		if (modelSelect) modelSelect.value = model;
		if (aiSideInput) aiSideInput.checked = aiSide;
		buildPool();
		buildBoard();
		bindControls();
		syncSideButtons();
		syncKeyState();
		renderAll();
		// 刷新后带着上次的队名，顺手把对面的近期习惯也取回来。
		void syncFoeForm();
	}
}
