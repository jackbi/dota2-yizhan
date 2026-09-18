/*
 * 相对导入带 `.ts` 后缀：这些模块要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { DraftData, DraftHero } from '../lib/draftData.ts';
import {
	ADVICE_TARGET_COUNT,
	DEEPSEEK_ENDPOINT,
	DEFAULT_DEEPSEEK_MODEL,
	buildAdviceMessages,
	buildChatRequest,
	parseAdviceReply,
} from '../lib/draftPrompt.ts';
import type { Advice, AdviceCandidate } from '../lib/draftScore.ts';
import { advise } from '../lib/draftScore.ts';
import type { DraftSide } from '../lib/draftOrder.ts';
import { CM_STEPS, canPlay, otherSide, play, sideOfOwner, skip, snapshot, undo } from '../lib/draftOrder.ts';

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
	const adviceCards = element<HTMLDivElement>('draft-advice-cards');
	const lineupBox = element<HTMLDivElement>('draft-lineup');
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
					JSON.stringify({ recorded, ourSide, firstPick, ourTeam, theirTeam, key: keyInput?.value ?? '', model, aiSide }),
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
				title.textContent = `${ATTR_LABEL[attr] ?? attr}（${data!.heroes.filter((hero) => hero.attr === attr).length}）`;
				group.append(title, grid);
				poolRoot.append(group);
				groups.set(attr, grid);
			}
			for (const hero of data!.heroes) {
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

			for (const hero of data!.heroes) {
				const tile = tiles.get(hero.id);
				if (!tile) continue;
				const usedAt = state.used.get(hero.id);
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
				} else {
					delete tile.dataset.used;
					delete tile.dataset.usedLabel;
				}
			}

			if (poolCount) poolCount.textContent = `显示 ${visible} / ${data!.heroes.length} 个英雄`;
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

		// ------------------------------------------------------------ 建议

		function currentAdvice(): Advice | null {
			return advise({ data: data!, recorded, ourSide, firstPicker: firstPickerSide(), limit: 5 });
		}

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

			for (const item of ordered.slice(0, aiResult ? ADVICE_TARGET_COUNT + 2 : 5)) {
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
				const enemyAdvice = advise({ data: data!, recorded, ourSide: turn.side, firstPicker: firstPickerSide(), limit: 5 });
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
						data: data!,
						// 视角翻转：从对面看，它自己是"我方"，屏幕前的人是"对面"。
						selfTeam: theirTeam,
						foeTeam: ourTeam,
						recorded,
						ourSide: enemy,
						firstPicker: firstPickerSide(),
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
				const parsed = parseAdviceReply(body.choices?.[0]?.message?.content ?? '', enemyAdvice.candidates.map((c) => c.heroId));
				if (!parsed) return null;
				return { heroId: parsed.picks[0].heroId, reason: parsed.picks[0].reason };
			} catch {
				// 网络、限流、解析失败都退回数据决策，别让对战卡在这里。
				return null;
			}
		}

		function onHeroClick(heroId: number): void {
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
			applyFilters();
			syncBoard();
			syncBanner();
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
			});

			matchSelect?.addEventListener('change', () => {
				const option = matchSelect.selectedOptions[0];
				ourTeam = option?.dataset.home ?? '';
				theirTeam = option?.dataset.away ?? '';
				if (ourTeamInput) ourTeamInput.value = ourTeam;
				if (theirTeamInput) theirTeamInput.value = theirTeam;
				save();
				syncBoard();
			});

			adviceToggle?.addEventListener('click', () => {
				adviceOpen = !adviceOpen;
				renderAdvice();
			});
			adviceAi?.addEventListener('click', () => {
				void explainWithModel();
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
				data,
				ourTeam,
				theirTeam,
				recorded,
				ourSide,
				firstPicker: firstPickerSide(),
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
				const parsed = parseAdviceReply(content, advice.candidates.map((candidate) => candidate.heroId));
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
	}
}
