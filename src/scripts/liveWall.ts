import { PLATFORM_META, roomUrl } from '../data/site';
import type { Platform, RoomRef } from '../data/types';

/**
 * 分屏直播页（监控室）的客户端逻辑。
 *
 * 左侧房间列表与右侧监控室都由这里渲染，和 `items.astro` / `heroes.astro` 一样走
 * "构建期出 JSON、浏览器出网格"。这个工具本身就依赖 JS：记住墙上的房间要用
 * localStorage，拖拽更是浏览器行为，所以页面上给了 `<noscript>` 兜底。
 *
 * 三条约定：
 * - **不猜开播状态。** 只有 OB 成员的 `live` 来自构建期抓取；热门榜本身只列当前开播
 *   的房间，所以那一批标「榜单」而不是标绿点，避免把榜单快照包装成实时状态。
 * - **拖拽必须有等价操作。** 每行都有「加入」按钮（键盘/触屏），拖拽只是快捷方式。
 * - **iframe 只在用户明确要播时才创建。** 一个斗鱼房间页是很重的页面，9 路同时加载
 *   足以拖垮浏览器，所以恢复历史时只还原排布、不自动播放。
 */

interface Payload {
	ob: RoomRef[];
	popular: RoomRef[];
	snapshotAt: string;
}

interface State {
	layout: number;
	slots: (string | null)[];
	manual: RoomRef[];
}

const LAYOUTS = [1, 2, 4, 6, 9];
const MAX_SLOTS = 9;
const STORAGE_KEY = 'dota2-live-wall/v1';

/** Tailwind 只认完整字面量，所以这里必须写全，不能拼字符串。 */
const GRID_CLASS: Record<number, string> = {
	1: 'grid-cols-1',
	2: 'grid-cols-1 sm:grid-cols-2',
	4: 'grid-cols-1 sm:grid-cols-2',
	6: 'grid-cols-2 xl:grid-cols-3',
	9: 'grid-cols-2 lg:grid-cols-3',
};

/**
 * 沉浸模式（网页全屏 / 浏览器全屏）下的网格：行列数写死并各自平分高度，
 * 格子跟着视口长，不再按 16:9 留黑边。手机上窄，6/9 格退回两列多行。
 */
const IMMERSIVE_GRID_CLASS: Record<number, string> = {
	1: 'grid-cols-1 grid-rows-1',
	2: 'grid-cols-2 grid-rows-1',
	4: 'grid-cols-2 grid-rows-2',
	6: 'grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2',
	9: 'grid-cols-2 grid-rows-5 sm:grid-cols-3 sm:grid-rows-3',
};

const STATE_LABEL: Record<string, string> = {
	live: '直播中',
	replay: '轮播中',
	offline: '未开播',
	closed: '房间已关闭',
	unknown: '状态未知',
};

const payload: Payload = JSON.parse(document.getElementById('live-data')?.textContent ?? '{}');
const listEl = document.getElementById('room-list');
const wallEl = document.getElementById('wall');
const countEl = document.getElementById('room-count');
const searchEl = document.getElementById('room-search') as HTMLInputElement | null;
const filterEl = document.getElementById('room-filters');
const layoutEl = document.getElementById('wall-layout');
const panelEl = document.getElementById('wall-panel');
const pageFullBtn = document.getElementById('wall-page-full') as HTMLButtonElement | null;
const browserFullBtn = document.getElementById('wall-browser-full') as HTMLButtonElement | null;

if (listEl && wallEl && countEl && searchEl && filterEl && layoutEl) {
	const rooms = new Map<string, RoomRef>();
	for (const r of [...(payload.ob ?? []), ...(payload.popular ?? [])]) rooms.set(r.key, r);

	let query = '';
	let filter = 'all';
	let state: State = restore();
	/** 网页全屏：面板脱离文档流铺满浏览器窗口。 */
	let pageFull = false;
	/** 浏览器全屏：由 fullscreenchange 同步，用户按 Esc 时也得跟着变。 */
	let browserFull = false;

	// ------------------------------------------------------------ 工具

	function esc(s: string): string {
		return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
	}

	/** 平台热度按国内习惯写；两家口径不同，只在同平台内可比。 */
	function hot(n: number | undefined): string {
		if (!n) return '';
		if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`;
		if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
		return String(n);
	}

	function badge(platform: Platform): string {
		const meta = PLATFORM_META[platform];
		return `<span class="shrink-0 rounded px-1 py-0.5 text-[10px] font-bold" style="background:${meta.color};color:#fff">${meta.short}</span>`;
	}

	/** OB 成员才有构建期状态；热门榜只标「榜单」。 */
	function statusDot(r: RoomRef): string {
		const cls =
			r.live === 'live'
				? 'animate-pulse bg-[#22c55e]'
				: r.live === 'replay'
					? 'bg-gold'
					: r.live
						? 'bg-zinc-500'
						: 'bg-dota';
		return `<span class="h-1.5 w-1.5 shrink-0 rounded-full ${cls}" aria-hidden="true"></span>`;
	}

	function statusText(r: RoomRef): string {
		if (r.live) return STATE_LABEL[r.live] ?? '状态未知';
		return '榜单';
	}

	function restore(): State {
		const fallback: State = { layout: 4, slots: Array(MAX_SLOTS).fill(null), manual: [] };
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return fallback;
			const parsed = JSON.parse(raw) as Partial<State>;
			const slots = Array.isArray(parsed.slots) ? parsed.slots.slice(0, MAX_SLOTS) : [];
			while (slots.length < MAX_SLOTS) slots.push(null);
			const manual = (Array.isArray(parsed.manual) ? parsed.manual : []).filter(
				(r): r is RoomRef => !!r && typeof r.key === 'string' && typeof r.roomId === 'string',
			);
			const layout = LAYOUTS.includes(Number(parsed.layout)) ? Number(parsed.layout) : 4;
			return { layout, slots, manual };
		} catch {
			return fallback;
		}
	}

	function save(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch {
			// 隐私模式下存不了，不影响本次使用。
		}
	}

	function flash(el: Element | null): void {
		if (!el) return;
		el.classList.add('ring-2', 'ring-gold');
		setTimeout(() => el.classList.remove('ring-2', 'ring-gold'), 900);
	}

	// ------------------------------------------------------------ 左侧列表

	function visibleRooms(): RoomRef[] {
		const q = query.trim().toLowerCase();
		return [...state.manual, ...(payload.ob ?? []), ...(payload.popular ?? [])].filter((r) => {
			if (filter === 'ob' && r.source !== 'ob') return false;
			if (filter === 'manual' && r.source !== 'manual') return false;
			if (filter === 'dy' && r.platform !== 'douyu') return false;
			if (filter === 'hy' && r.platform !== 'huya') return false;
			if (filter === 'popular' && r.source !== 'popular') return false;
			if (!q) return true;
			return `${r.name} ${r.title ?? ''} ${r.roomId}`.toLowerCase().includes(q);
		});
	}

	function rowHtml(r: RoomRef): string {
		const meta = PLATFORM_META[r.platform];
		const hotText = hot(r.hot);
		return `
			<div class="room-row flex items-center gap-1 rounded-lg border border-line/70 bg-surface-2/40 transition hover:border-dota/60 hover:bg-surface-2"
				draggable="true" data-key="${esc(r.key)}">
				<button type="button" class="room-add flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
					data-key="${esc(r.key)}" aria-label="把 ${esc(r.name)} 加入监控室">
					${statusDot(r)}
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm text-cream">${esc(r.name)}</span>
						<span class="block truncate text-[11px] text-faint">${meta.label} ${esc(r.roomId)}${r.title ? ' · ' + esc(r.title) : ''}</span>
					</span>
					${
						hotText
							? `<span class="shrink-0 text-[11px] tabular-nums text-faint" title="${meta.label}热度，抓取时 ${hotText}">${hotText}</span>`
							: ''
					}
					${badge(r.platform)}
					<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line text-faint transition" aria-hidden="true">
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
					</span>
				</button>
			</div>`;
	}

	function renderList(): void {
		const rows = visibleRooms();
		listEl!.innerHTML =
			rows.length > 0
				? rows.map(rowHtml).join('')
				: '<p class="px-3 py-6 text-center text-sm text-faint">没有匹配的直播间。</p>';
		const total = rooms.size + state.manual.length;
		countEl!.textContent = `显示 ${rows.length} / ${total} 个`;
	}

	// ------------------------------------------------------------ 右侧监控室

	function tileHtml(index: number): string {
		const key = state.slots[index];
		const r = key ? (rooms.get(key) ?? state.manual.find((m) => m.key === key)) : undefined;
		const base =
			'wall-tile relative flex aspect-video flex-col overflow-hidden rounded-xl border transition';

		if (!r) {
			return `<div class="${base} border-dashed border-line/80 bg-ink-2/60" data-slot="${index}">
				<div class="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
					<span class="font-display text-2xl text-line">${index + 1}</span>
					<span class="text-xs text-faint">把左边的房间拖到这里</span>
				</div>
			</div>`;
		}

		return `<div class="${base} border-line bg-ink-2" data-slot="${index}" data-key="${esc(r.key)}">
			<div class="flex items-center gap-2 border-b border-line bg-surface/80 px-2 py-1.5">
				${statusDot(r)}
				<span class="min-w-0 flex-1 truncate text-xs font-medium text-cream">${esc(r.name)}</span>
				<span class="shrink-0 text-[10px] tabular-nums text-faint">${esc(r.roomId)}</span>
				${badge(r.platform)}
				<button type="button" class="tile-remove shrink-0 rounded px-1.5 py-0.5 text-faint transition hover:bg-surface-3 hover:text-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
					data-tile="${index}" aria-label="把 ${esc(r.name)} 从第 ${index + 1} 格移出">✕</button>
			</div>
			<div class="tile-body relative flex-1 bg-black">
				<div class="tile-idle absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-2/80">
					<button type="button" class="tile-play flex items-center gap-2 rounded-lg bg-dota px-4 py-2 text-sm font-medium text-white transition hover:bg-dota-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
						data-tile="${index}">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
						播放这一格
					</button>
					<span class="px-3 text-center text-[11px] leading-relaxed text-faint">
						点开才会加载直播间页面${r.live ? '' : '（榜单房间，抓取时在播）'}
					</span>
				</div>
			</div>
			<a href="${roomUrl(r.platform, r.roomId)}" target="_blank" rel="noopener noreferrer"
				class="absolute bottom-2 right-2 z-10 rounded-md bg-dota/90 px-2 py-1 text-[11px] font-medium text-white backdrop-blur transition hover:bg-dota focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
				data-open="${esc(r.key)}">打开直播间</a>
		</div>`;
	}

	function renderWall(): void {
		const n = state.layout;
		wallEl!.className = `grid gap-3 ${gridClass(n)}`;
		wallEl!.innerHTML = Array.from({ length: n }, (_, i) => tileHtml(i)).join('');
		layoutEl!.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
			b.setAttribute('aria-pressed', String(Number(b.dataset.layout) === n));
		});
		const used = state.slots.slice(0, n).filter(Boolean).length;
		const status = document.getElementById('wall-status');
		if (status) status.textContent = `墙上 ${used} / ${n} 格`;
	}

	/** 真正创建 iframe 只发生在用户点了播放之后。 */
	function playSlot(index: number): void {
		const tile = wallEl!.querySelector<HTMLElement>(`[data-slot="${index}"]`);
		const key = state.slots[index];
		if (!tile || !key) return;
		const r = rooms.get(key) ?? state.manual.find((m) => m.key === key);
		if (!r) return;
		const body = tile.querySelector('.tile-body');
		if (!body || body.querySelector('iframe')) return;
		tile.querySelector('.tile-idle')?.remove();
		const frame = document.createElement('iframe');
		frame.src = roomUrl(r.platform, r.roomId);
		frame.title = `${r.name} 直播间`;
		frame.className = 'h-full w-full';
		frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
		frame.setAttribute('loading', 'lazy');
		body.prepend(frame);
	}

	function stopAll(): void {
		wallEl!.querySelectorAll('iframe').forEach((f) => f.remove());
		renderWall();
	}

	// ------------------------------------------------------------ 全屏

	function immersive(): boolean {
		return pageFull || browserFull;
	}

	/** 沉浸模式下格子平分视口高度，网格类得换一套。 */
	function gridClass(n: number): string {
		const map = immersive() ? IMMERSIVE_GRID_CLASS : GRID_CLASS;
		return map[n] ?? GRID_CLASS[n] ?? 'grid-cols-1';
	}

	function setNote(msg: string): void {
		const el = document.getElementById('wall-note');
		if (el) el.textContent = msg;
	}

	function syncFullButtons(): void {
		if (pageFullBtn) {
			pageFullBtn.setAttribute('aria-pressed', String(pageFull));
			// 系统全屏时本来就是满屏，网页全屏再点没有任何可见效果，索性禁掉。
			pageFullBtn.disabled = browserFull;
			const label = pageFullBtn.querySelector('.wall-fs-label');
			if (label) label.textContent = pageFull ? '退出网页全屏' : '网页全屏';
		}
		if (browserFullBtn) {
			browserFullBtn.setAttribute('aria-pressed', String(browserFull));
			const label = browserFullBtn.querySelector('.wall-fs-label');
			if (label) label.textContent = browserFull ? '退出全屏' : '浏览器全屏';
		}
	}

	/**
	 * 只切类名，**绝不重渲染**：renderWall 会重建 innerHTML，把已经加载的 iframe 全部冲掉，
	 * 那就成了"一全屏就把画面停了"。格子的高度改由 global.css 里的 .wall-immersive 规则接管，
	 * 这样已加载的播放器不受影响。
	 */
	function applyImmersive(): void {
		panelEl?.classList.toggle('wall-immersive', immersive());
		// 网页全屏时面板盖住了整页，底下的滚动要锁住。
		document.body.classList.toggle('wall-immersive-lock', pageFull);
		wallEl!.className = `grid gap-3 ${gridClass(state.layout)}`;
		syncFullButtons();
	}

	/** 系统全屏 API 缺失或被拒时的退路，总比按钮点了没反应强。 */
	function fallbackToPageFull(reason: string): void {
		pageFull = true;
		applyImmersive();
		setNote(reason);
	}

	// ------------------------------------------------------------ 加入 / 拖拽

	function assign(key: string, index: number): void {
		// 同一个房间已经在别格时先清掉，避免同一路开两份。
		const existing = state.slots.indexOf(key);
		if (existing >= 0) state.slots[existing] = null;
		state.slots[index] = key;
		save();
		renderWall();
	}

	/** 拖拽的等价操作：滚到第一个空格，满了就替换最后一格。 */
	function addToFirstFree(key: string): void {
		const free = state.slots.slice(0, state.layout).indexOf(null);
		const index = free >= 0 ? free : state.layout - 1;
		assign(key, index);
		flash(wallEl!.querySelector(`[data-slot="${index}"]`));
	}

	function moveTileTo(index: number, key: string): void {
		assign(key, index);
		flash(wallEl!.querySelector(`[data-slot="${index}"]`));
	}

	// ------------------------------------------------------------ 手动添加

	function parseManual(input: string, platform: Platform): { platform: Platform; roomId: string } | null {
		const v = input.trim();
		if (!v) return null;
		const url = /(?:douyu\.com|huya\.com|bilibili\.com)\/([A-Za-z0-9_]+)/.exec(v);
		if (url) {
			const p: Platform = v.includes('huya.com') ? 'huya' : v.includes('bilibili.com') ? 'bilibili' : 'douyu';
			return { platform: p, roomId: url[1] };
		}
		if (!/^[A-Za-z0-9_]+$/.test(v)) return null;
		return { platform, roomId: v };
	}

	function addManual(platform: Platform, roomId: string): void {
		const key = `${platform}:${roomId}`;
		if (rooms.has(key)) {
			flash(listEl!.querySelector(`[data-key="${CSS.escape(key)}"]`));
			return;
		}
		const room: RoomRef = { key, platform, roomId, name: `房间 ${roomId}`, source: 'manual' };
		state.manual.unshift(room);
		rooms.set(key, room);
		save();
		renderList();
		flash(listEl!.querySelector(`[data-key="${CSS.escape(key)}"]`));
	}

	// ------------------------------------------------------------ 事件

	searchEl.addEventListener('input', () => {
		query = searchEl.value;
		renderList();
	});

	filterEl.addEventListener('click', (e) => {
		const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
		if (!btn) return;
		filter = btn.dataset.filter ?? 'all';
		filterEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
			b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
		});
		renderList();
	});

	layoutEl.addEventListener('click', (e) => {
		const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-layout]');
		if (!btn) return;
		state.layout = Number(btn.dataset.layout);
		save();
		renderWall();
	});

	document.getElementById('wall-clear')?.addEventListener('click', () => {
		state.slots = Array(MAX_SLOTS).fill(null);
		save();
		renderWall();
	});

	document.getElementById('wall-stop')?.addEventListener('click', stopAll);

	// Esc 退出网页全屏。系统全屏时 Esc 归浏览器管（它会自己退出并触发 fullscreenchange），
	// 这里让开，否则会把两个全屏一起关掉。
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape' || !pageFull || document.fullscreenElement) return;
		pageFull = false;
		applyImmersive();
		setNote('');
	});

	pageFullBtn?.addEventListener('click', () => {
		pageFull = !pageFull;
		applyImmersive();
		setNote(pageFull ? '已切到网页全屏：格子撑满窗口，按 Esc 或再点一次按钮退出。' : '');
	});

	browserFullBtn?.addEventListener('click', () => {
		if (browserFull) {
			void document.exitFullscreen();
			return;
		}
		const target = panelEl ?? wallEl!;
		const request = (target as HTMLElement & { requestFullscreen?: () => Promise<void> }).requestFullscreen;
		if (!request) {
			fallbackToPageFull('这个浏览器没有系统全屏接口，已改用网页全屏。');
			return;
		}
		void request.call(target).catch(() => {
			// 常见于嵌在 iframe 里且没给 allowfullscreen，或者不在用户手势里调用。
			fallbackToPageFull('浏览器拒绝了系统全屏请求，已改用网页全屏。');
		});
	});

	// 全屏状态只能从事件里读：用户可能按 Esc、按 F11，或由浏览器自己退出。
	document.addEventListener('fullscreenchange', () => {
		const was = browserFull;
		browserFull = !!document.fullscreenElement;
		applyImmersive();
		if (browserFull) setNote('已进入浏览器全屏，按 Esc 退出。');
		else if (was) setNote(pageFull ? '已退出浏览器全屏，仍在网页全屏。' : '');
	});

	document.getElementById('room-form')?.addEventListener('submit', (e) => {
		e.preventDefault();
		const input = document.getElementById('room-input') as HTMLInputElement | null;
		const select = document.getElementById('room-platform') as HTMLSelectElement | null;
		if (!input || !select) return;
		const parsed = parseManual(input.value, select.value as Platform);
		if (!parsed) {
			input.setAttribute('aria-invalid', 'true');
			return;
		}
		input.removeAttribute('aria-invalid');
		addManual(parsed.platform, parsed.roomId);
		input.value = '';
	});

	// 事件委托：列表和监控室的内容都是动态渲染的。
	listEl.addEventListener('click', (e) => {
		const add = (e.target as HTMLElement).closest<HTMLElement>('.room-add');
		if (!add?.dataset.key) return;
		addToFirstFree(add.dataset.key);
	});

	listEl.addEventListener('dragstart', (e) => {
		const row = (e.target as HTMLElement).closest<HTMLElement>('.room-row');
		if (!row?.dataset.key || !e.dataTransfer) return;
		e.dataTransfer.setData('text/plain', row.dataset.key);
		e.dataTransfer.effectAllowed = 'copy';
		row.classList.add('opacity-50');
	});

	listEl.addEventListener('dragend', (e) => {
		(e.target as HTMLElement).closest<HTMLElement>('.room-row')?.classList.remove('opacity-50');
	});

	wallEl.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		const play = target.closest<HTMLElement>('.tile-play');
		if (play?.dataset.tile) {
			playSlot(Number(play.dataset.tile));
			return;
		}
		const remove = target.closest<HTMLElement>('.tile-remove');
		if (remove?.dataset.tile) {
			state.slots[Number(remove.dataset.tile)] = null;
			save();
			renderWall();
		}
	});

	// 整块墙都是放置区：落在空格上就放那一格，落在墙上就找第一个空格。
	wallEl.addEventListener('dragover', (e) => {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
		tile?.classList.add('ring-2', 'ring-dota');
	});

	wallEl.addEventListener('dragleave', (e) => {
		(e.target as HTMLElement).closest<HTMLElement>('[data-slot]')?.classList.remove('ring-2', 'ring-dota');
	});

	wallEl.addEventListener('drop', (e) => {
		e.preventDefault();
		const key = e.dataTransfer?.getData('text/plain');
		wallEl.querySelectorAll('[data-slot]').forEach((t) => t.classList.remove('ring-2', 'ring-dota'));
		if (!key || !rooms.has(key)) return;
		const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
		if (tile?.dataset.slot) moveTileTo(Number(tile.dataset.slot), key);
		else addToFirstFree(key);
	});

	renderList();
	renderWall();
}
