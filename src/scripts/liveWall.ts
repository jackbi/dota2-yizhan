import { PLATFORM_META, embedUrl, roomUrl } from '../data/site';
import type { Platform, RoomRef } from '../data/types';
import { createDouyuDanmaku } from '../lib/douyuDanmaku';

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
 * - **格子尺寸可调。** 列宽行高不再是写死的等分，拖动格子之间的分隔条即可改（见 applyTracks），
 *   按格数分别记住；不动它就是等分，也就是原来的样子。
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
	/** 只显示画面：把平台页面裁到播放器区域 */
	crop: boolean;
	/**
	 * 每格的取景纵向微调（px），按房间 key 存。
	 *
	 * 自动锚点能对齐绝大多数房间，但**广告是后到的**：广告插在播放器上面时会把播放器再顶下去，
	 * 而那一刻我们已经滚过位置了。实测同一平台 9999 正好、88660 偏 180px，所以偏移只能按房间记，
	 * 给每格一组上下按钮自己对齐。
	 */
	cropOffsets: Record<string, number>;
	/**
	 * 列宽 / 行高比例，**按格数分别存**（key 是格数）。
	 *
	 * 存的是比例而不是像素：同一套比例在网页全屏、浏览器全屏、拉窗口后都要能跟着变，
	 * 存 px 一换视口就错位。数组长度是写入时的列数 / 行数——断点变了（比如 9 格从两列变三列）
	 * 长度就对不上，那时按比例重采样（见 resample），形状大致保留。
	 */
	ratios: Record<string, { c: number[]; r: number[] }>;
	/**
	 * 显式要求「嵌平台整页」的房间 key。
	 *
	 * 斗鱼默认走直链 + `<video>`（见 `playDouyu`），只有解析失败、自动播放被拦，或者用户自己
	 * 切过来时才用 iframe。虎牙本来就是官方播放器页，跟这个开关无关。
	 */
	iframeKeys: string[];
}

const LAYOUTS = [1, 2, 4, 6, 9];
const MAX_SLOTS = 9;
const STORAGE_KEY = 'dota2-live-wall/v1';

/**
 * 「只显示画面」的取景参数——**现在只剩斗鱼一家**。
 *
 * 每格里嵌的是平台**整个直播间页面**，导航、弹幕、礼物、推荐位都在里面，画面自然小。
 * iframe 跨域，父页面碰不到里面的 DOM，所以唯一的办法是把 iframe 放大再错位，
 * 让播放器正好落在格子里——外层 `overflow: hidden` 把其余部分裁掉。
 *
 * 难点是**播放器在页面里的位置不稳定**：斗鱼有个 1299px 高的推荐/广告块把播放器顶到
 * y=1439。用 **URL 片段锚点**可以解决：带上播放器容器的 id，iframe 自己会把播放器滚到顶部，
 * 位置就归零了。
 *
 * **但锚点必须"加载完再补"，不能只写在初次导航的地址里。** 斗鱼是客户端渲染，播放器容器
 * 出现在浏览器的片段滚动之后，于是滚不滚全看运气——实测 `9999` 滚到了（scrollY=1379）
 * 而 `88660` 完全没滚（scrollY=1），页面上就露出一条房间信息条。
 * 加载完再补一次**同文档**的片段导航（只改 hash，不重新加载），那次一定滚得准。
 * 所以 `scheduleAnchor()` 会在页面出来后补一次，把位置按住。
 *
 * 补锚点后的实测值（1280×720 视口，冷启动）：
 *
 * | 平台 | 锚点 | 播放器位置 | 尺寸 | 页头 |
 * | --- | --- | --- | --- | --- |
 * | 斗鱼 | `#js-player-video` | (32, 0) | 813×457 | `relative`，会滚走 |
 *
 * **虎牙已经不需要裁切了**：它有一个官方的纯播放器页 `liveshare.huya.com/iframe/{房间号}`
 * （见 `data/site.ts` 的 `embedUrl()`），嵌进去就是画面本身，还自带每格可拖的音量滑杆。
 * 所以 `CROP` 里没有虎牙——`cropSpecOf('huya')` 返回 undefined，虎牙格子走「正常铺满」那条路。
 * （之前的写死值是 `#J_playerMain`、(90,60)、785×442，虎牙页头 `fixed` 吸顶得留 60px；
 * 那套连同它的偏移微调都已经删掉，别再照着老注释往回加。）
 *
 * **B站 不在表里，因为它根本嵌不进来**：`live.bilibili.com` 发
 * `X-Frame-Options: SAMEORIGIN`，浏览器直接把 iframe 拒掉
 * （`net::ERR_BLOCKED_BY_RESPONSE`，这正是"被响应头拒绝"的标志），格子里只会是黑的。
 * 手动添加里粘 B站 链接会得到一个打不开的格子，页面上有提示。
 *
 * 取景框以这组数写死，平台改版就会偏；广告后到时也会把播放器顶偏（实测同一间正好、
 * 一间偏 180px），所以每格左下角有上下微调，按房间号记住。
 */
interface CropSpec {
	/** 播放器容器的 id，补在房间地址后面当片段锚点 */
	anchor: string;
	/** 播放器在 iframe 视口里的左上角与尺寸（1280×720 视口下实测） */
	x: number;
	y: number;
	w: number;
	h: number;
}

const CROP: Partial<Record<Platform, CropSpec>> = {
	douyu: { anchor: 'js-player-video', x: 32, y: 0, w: 813, h: 457 },
};

/** 取景时 iframe 的逻辑视口：桌面布局下的整数尺寸。 */
const CROP_VIEW = { w: 1280, h: 720 };

/**
 * 页面加载完之后补一次片段锚点。
 *
 * 两个坑，都是实测踩出来的：
 *
 * 1. **不能把地址改回不带片段的形式。** 本地页面数 `load` 次数验证过：加片段、换片段都是
 *    同文档导航、不重新加载；但**去掉**片段会让 iframe 整页重载，重载后锚点又变回"初次导航"
 *    的竞态，页面还会被反复刷掉（曾把格子刷成全黑）。
 * 2. **只能补一次。** 斗鱼是 Next.js，每次 hash 变化都会走一次路由转场，反复补会让它不停
 *    "跳过转场"，最后把播放器整个刷没——实测补三次，两格斗鱼全黑、控制台 252 条
 *    `AbortError: Transition was skipped`。补一次时，位置就稳了（补完再等 6 秒复测没有位移）。
 *
 * 所以：给足时间让客户端把播放器渲染出来，然后只改这一次 hash。
 */
function scheduleAnchor(frame: HTMLIFrameElement, base: string, anchor: string): void {
	setTimeout(() => {
		if (frame.isConnected) frame.src = `${base}#${anchor}`;
	}, 6000);
}

/** 拖动分隔条时单条轨道的下限：比这更窄 / 更矮的格子放直播没意义。 */
const MIN_COL_PX = 120;
const MIN_ROW_PX = 110;
/** 分隔条的命中宽度（px）与方向键每次的调整量（px）。 */
const SPLIT_HIT_PX = 14;
const KEY_STEP_PX = 20;

/** 比例数组归一化到和 1，顺手把脏数据（0、NaN、负数）当 1 处理。 */
function normalize(list: number[]): number[] {
	const clean = list.map((v) => (Number.isFinite(v) && v > 0 ? v : 1));
	const sum = clean.reduce((a, b) => a + b, 0) || clean.length || 1;
	return clean.map((v) => v / sum);
}

/**
 * 把存下来的比例重采样到新的轨道数。
 *
 * 断点一变列数就会变（9 格在两列断点是 2×5、三列断点是 3×3），存的比例长度对不上。
 * 直接丢弃会让用户拉过的窗口在旋转屏幕后白费，所以按比例分桶取平均，形状大致留住。
 */
function resample(src: number[] | undefined, len: number): number[] {
	if (!src || src.length === 0) return Array(len).fill(1 / Math.max(1, len));
	if (src.length === len) return normalize(src.slice());
	const out: number[] = [];
	for (let i = 0; i < len; i++) {
		const from = Math.floor((i * src.length) / len);
		const to = Math.max(from + 1, Math.ceil(((i + 1) * src.length) / len));
		const end = Math.min(to, src.length);
		let sum = 0;
		for (let j = from; j < end; j++) sum += src[j];
		out.push(sum / Math.max(1, end - from));
	}
	return normalize(out);
}

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
const roomPanelEl = document.getElementById('room-panel');
const panelEl = document.getElementById('wall-panel');
const pageFullBtn = document.getElementById('wall-page-full') as HTMLButtonElement | null;
const browserFullBtn = document.getElementById('wall-browser-full') as HTMLButtonElement | null;

if (listEl && wallEl && countEl && searchEl && filterEl && layoutEl) {
	const rooms = new Map<string, RoomRef>();
	for (const r of [...(payload.ob ?? []), ...(payload.popular ?? [])]) rooms.set(r.key, r);

	/** 分隔条按 `c:1`（第 1 列右侧）/ `r:2`（第 2 行下方）建一次就复用，拖动中被删掉会掉指针捕获。 */
	const splitters = new Map<string, HTMLElement>();

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

	/**
	 * 榜单快照时间（本地时区，`MM.DD HH:mm`）。
	 *
	 * 这句话原来在页面底部那张说明卡里，卡片收掉之后挪到列表页脚：**「数据有多旧」是这页最该写清的事**
	 * ——热门榜与 OB 状态都是构建期快照，不随时间刷新，所以时间必须一直看得见。
	 */
	function snapshotLabel(): string {
		const at = new Date(payload.snapshotAt);
		if (Number.isNaN(at.getTime())) return '未知';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${pad(at.getMonth() + 1)}.${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
	}

	function badge(platform: Platform): string {
		const meta = PLATFORM_META[platform];
		return `<span class="shrink-0 rounded px-1 py-0.5 text-[10px] font-bold" style="background:${meta.color};color:#fff">${meta.short}</span>`;
	}

	/** OB 成员才有构建期状态；热门榜只标「榜单」。 */
	function dotColor(r: RoomRef): string {
		return r.live === 'live'
			? 'animate-pulse bg-[#22c55e]'
			: r.live === 'replay'
				? 'bg-gold'
				: r.live
					? 'bg-zinc-500'
					: 'bg-dota';
	}

	function statusText(r: RoomRef): string {
		if (r.live) return STATE_LABEL[r.live] ?? '状态未知';
		return '榜单';
	}

	/**
	 * 头像 + 右下角状态点。
	 *
	 * 头像是**背景图**而不是 `<img>`：加载失败时不会渲染破图图标，而是露出底下的首字母占位
	 * （品牌渐变底），所以拿不到头像的房间看起来一样整齐。状态点收进头像角上省一列宽度，
	 * 同时用 `sr-only` 补一句状态文字——开播状态不能只靠颜色表达。
	 */
	function avatarBadge(r: RoomRef, size: 'row' | 'tile'): string {
		const box = size === 'row' ? 'h-8 w-8 rounded-lg text-[10px]' : 'h-5 w-5 rounded text-[8px]';
		const dot = size === 'row' ? 'h-2 w-2' : 'h-1.5 w-1.5';
		return `<span class="relative shrink-0">
			<span class="relative grid ${box} place-items-center overflow-hidden bg-gradient-to-br from-dota to-dota-deep font-display text-white" aria-hidden="true">
				${esc(r.name.slice(0, 2))}
				${r.avatar ? `<span class="absolute inset-0 bg-cover bg-center" style="background-image:url('${esc(r.avatar)}')"></span>` : ''}
			</span>
			<span class="absolute -bottom-0.5 -right-0.5 ${dot} rounded-full ring-2 ring-ink-2 ${dotColor(r)}" aria-hidden="true"></span>
			<span class="sr-only">${esc(statusText(r))}</span>
		</span>`;
	}

	function restore(): State {
		const fallback: State = {
			layout: 4,
			slots: Array(MAX_SLOTS).fill(null),
			manual: [],
			crop: false,
			cropOffsets: {},
			ratios: {},
			iframeKeys: [],
		};
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
			const cropOffsets: Record<string, number> = {};
			for (const [key, value] of Object.entries(parsed.cropOffsets ?? {})) {
				const n = Number(value);
				if (Number.isFinite(n) && n !== 0) cropOffsets[key] = Math.max(-600, Math.min(600, n));
			}
			const iframeKeys = (Array.isArray(parsed.iframeKeys) ? parsed.iframeKeys : []).filter(
				(k): k is string => typeof k === 'string' && k.length > 0,
			);
			return {
				layout,
				slots,
				manual,
				crop: parsed.crop === true,
				cropOffsets,
				ratios: sanitizeRatios(parsed.ratios),
				iframeKeys,
			};
		} catch {
			return fallback;
		}
	}

	/**
	 * 只认格数作 key、正数作比例，长度按最多格数截断。
	 * 长度和当前列数 / 行数不一致是正常的——存的时候是一种断点，读的时候可能是另一种。
	 */
	function sanitizeRatios(raw: unknown): Record<string, { c: number[]; r: number[] }> {
		const out: Record<string, { c: number[]; r: number[] }> = {};
		if (!raw || typeof raw !== 'object') return out;
		const clean = (list: unknown): number[] => {
			if (!Array.isArray(list)) return [];
			const nums = list.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
			return nums.length > 0 ? normalize(nums.slice(0, MAX_SLOTS)) : [];
		};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!LAYOUTS.includes(Number(key))) continue;
			const entry = value as { c?: unknown; r?: unknown } | null;
			const c = clean(entry?.c);
			const r = clean(entry?.r);
			if (c.length > 0 || r.length > 0) out[key] = { c, r };
		}
		return out;
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
					${avatarBadge(r, 'row')}
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
		countEl!.textContent = `显示 ${rows.length} / ${total} 个 · 榜单快照 ${snapshotLabel()}`;
	}

	// ------------------------------------------------------------ 右侧监控室

	/**
	 * 「只显示画面」下每格的取景微调。
	 *
	 * 自动锚点能对齐大多数房间，但广告是后到的，个别房间会偏（实测同平台一间正好、一间偏 180px），
	 * 所以留一组上下按钮自己对齐；中间那个数字按钮显示当前偏移量，点它复位。按房间号记住。
	 */
	function cropControl(r: RoomRef, index: number): string {
		if (!state.crop || !cropSpecOf(r.platform)) return '';
		const offset = state.cropOffsets[r.key] ?? 0;
		const btn =
			'flex h-5 w-5 items-center justify-center rounded bg-ink/80 text-cream/80 backdrop-blur transition hover:bg-dota hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';
		const arrow = (d: string) =>
			`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
		return `<span class="absolute bottom-2 left-2 z-10 flex flex-col items-center gap-1" role="group" aria-label="画面取景微调">
			<button type="button" class="tile-crop-up ${btn}" data-tile="${index}" aria-label="把 ${esc(r.name)} 的画面往上移">${arrow('M18 15l-6-6-6 6')}</button>
			<button type="button" class="tile-crop-reset ${btn} text-[9px] tabular-nums" data-tile="${index}" aria-label="把 ${esc(r.name)} 的画面位置复位">${offset > 0 ? `+${offset}` : String(offset)}</button>
			<button type="button" class="tile-crop-down ${btn}" data-tile="${index}" aria-label="把 ${esc(r.name)} 的画面往下移">${arrow('M6 9l6 6 6-6')}</button>
		</span>`;
	}

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

		/*
		 * 虎牙格子里是它的官方播放器，**控制条就贴在底部**（暂停/刷新/弹幕/音量）。
		 * 我们那个 "打开直播间" 原先固定挂右下角，实测正好盖在音量滑杆和清晰度上（见截图），
		 * 所以按平台换个位置：虎牙放到标题栏里，斗鱼保持右下角（它底部是裁出来的播放器区域，
		 * 不冲突）。
		 */
		const huya = r.platform === 'huya';
		const openLink = (cls: string): string =>
			`<a href="${roomUrl(r.platform, r.roomId)}" target="_blank" rel="noopener noreferrer"
				class="${cls}" data-open="${esc(r.key)}">打开直播间</a>`;

		return `<div class="${base} border-line bg-ink-2" data-slot="${index}" data-key="${esc(r.key)}">
			<div class="flex items-center gap-2 border-b border-line bg-surface/80 px-2 py-1.5">
				${avatarBadge(r, 'tile')}
				<span class="min-w-0 flex-1 truncate text-xs font-medium text-cream">${esc(r.name)}</span>
				<span class="shrink-0 text-[10px] tabular-nums text-faint">${esc(r.roomId)}</span>
				${badge(r.platform)}
				${huya ? openLink('shrink-0 rounded px-1 text-[11px] text-dota-light transition hover:bg-surface-3 hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold') : ''}
				${
					r.platform === 'douyu' && state.iframeKeys.includes(r.key)
						? `<button type="button" class="tile-use-video shrink-0 rounded px-1 text-[11px] text-dota-light transition hover:bg-surface-3 hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold" data-tile="${index}" title="改用直链播放（画面自己铺满，音量可控）">直链</button>`
						: ''
				}
				<button type="button" class="tile-remove shrink-0 rounded px-1.5 py-0.5 text-faint transition hover:bg-surface-3 hover:text-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
					data-tile="${index}" aria-label="把 ${esc(r.name)} 从第 ${index + 1} 格移出">✕</button>
			</div>
			<div class="tile-body relative flex-1 overflow-hidden bg-black">
				<div class="tile-idle absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-2/80">
					<button type="button" class="tile-play flex items-center gap-2 rounded-lg bg-dota px-4 py-2 text-sm font-medium text-white transition hover:bg-dota-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
						data-tile="${index}">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
						播放这一格
					</button>
					<span class="tile-hint px-3 text-center text-[11px] leading-relaxed text-faint">
						点开才会加载${huya ? '虎牙官方播放器' : '直播间画面'}${r.live ? '' : '（榜单房间，抓取时在播）'}
					</span>
				</div>
			</div>
			${cropControl(r, index)}
			${huya ? '' : openLink('absolute bottom-2 right-2 z-10 rounded-md bg-dota/90 px-2 py-1 text-[11px] font-medium text-white backdrop-blur transition hover:bg-dota focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold')}
		</div>`;
	}

	function renderWall(): void {
		const n = state.layout;
		// 重建 innerHTML 会把 `<video>` 一起抹掉，所以先把播放器按规矩销毁——否则 mpegts.js
		// 手里还攥着已经不存在的 media element，控制台会刷一串错。
		destroyAllDouyuTiles();
		// 列宽行高全部走内联的 grid-template-*（见 applyTracks），类名只留布局骨架。
		wallEl!.className = 'grid gap-3';
		wallEl!.innerHTML = Array.from({ length: n }, (_, i) => tileHtml(i)).join('');
		layoutEl!.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
			b.setAttribute('aria-pressed', String(Number(b.dataset.layout) === n));
		});
		syncCropControls();
		applyTracks();
		syncWallStatus();
	}

	/**
	 * 工具栏上的格数文案。
	 *
	 * 单独抽出来是因为 `resetTile()` 也可能改变格数（点 ✕ 把房间移出格子），而它刻意不重建
	 * 整面墙——不抽出来的话，工具栏会停在移出前的数字，要等下一次 `renderWall()`（换格数、
	 * 全屏、清空）才纠正。
	 */
	function syncWallStatus(): void {
		const used = state.slots.slice(0, state.layout).filter(Boolean).length;
		const status = document.getElementById('wall-status');
		if (status) status.textContent = `墙上 ${used} / ${state.layout} 格`;
	}

	// ------------------------------------------------------------ 格子尺寸

	/**
	 * 墙面排成几列几行。
	 *
	 * 列宽行高改由 JS 写成内联的 `grid-template-*`（见 applyTracks），排列就不能再交给 Tailwind 的
	 * `sm:grid-cols-2` 这类类名——内联样式会盖掉媒体查询，窄屏再也不会换列。所以排列一并搬到这里，
	 * 断点值保持原样（sm 640 / lg 1024 / xl 1280），只是从类名换成表达式。
	 *
	 * 沉浸模式（网页全屏 / 浏览器全屏）下格子跟着视口长，不再按 16:9 留黑边；
	 * 手机上窄，6/9 格退回两列多行。
	 */
	function arrangement(n: number): { cols: number; rows: number } {
		const w = window.innerWidth;
		const sm = w >= 640;
		const lg = w >= 1024;
		const xl = w >= 1280;
		let cols: number;
		if (immersive()) {
			cols = n === 1 ? 1 : n === 2 || n === 4 ? 2 : sm ? 3 : 2;
		} else if (n === 1) {
			cols = 1;
		} else if (n === 2 || n === 4) {
			cols = sm ? 2 : 1;
		} else if (n === 6) {
			cols = xl ? 3 : 2;
		} else {
			cols = lg ? 3 : 2;
		}
		return { cols, rows: Math.ceil(n / cols) };
	}

	function gridGap(): number {
		return parseFloat(getComputedStyle(wallEl!).columnGap) || 0;
	}

	/** 当前列数下每格的宽度；单列时就是墙面的宽度。 */
	function cellWidth(cols: number): number {
		return Math.max(80, (wallEl!.clientWidth - gridGap() * (cols - 1)) / cols);
	}

	/** 等分时每行的高度：格子是 16:9，所以等于该行列宽 × 9/16（下限免得窄屏上塌成一条）。 */
	function rowBasePx(cols: number): number {
		return Math.max(120, (cellWidth(cols) * 9) / 16);
	}

	/** 取第 n 套格数的比例；列数 / 行数对不上（换过断点）就重采样。 */
	function ratiosOf(n: number, cols: number, rows: number): { c: number[]; r: number[] } {
		const stored = state.ratios[String(n)];
		return { c: resample(stored?.c, cols), r: resample(stored?.r, rows) };
	}

	/**
	 * 非全屏时墙面的目标总高。
	 *
	 * 桌面端（≥1024px，和 `lg:` 断点对齐）**一屏放下整面墙**：以「视口剩下的高度」为准，
	 * 4/6/9 格时行高会被压得比 16:9 矮，这是故意的——原来一律按 16:9 折行高，
	 * 两个直播间时格子只有 ~195px 高，上下全是空白；格子一多又反过来溢出、还得滚动。
	 * 手机上仍按 16:9：墙排在长长的房间列表下面，一屏一格反而不好翻。
	 *
	 * 下限是 `MIN_ROW_PX * 行数`：视口实在太矮时（小笔记本、工具栏换行）宁可让页面滚动，
	 * 也不要把格子压成一条缝。
	 */
	function wallTargetHeight(cols: number, rows: number): number {
		const base = rowBasePx(cols) * rows;
		if (window.innerWidth < 1024) return base;
		const top = wallEl!.getBoundingClientRect().top;
		// 底下留 24px：和侧栏的 `lg:max-h-[calc(100dvh-6rem)]` 观感一致，别顶到窗口边缘。
		const available = window.innerHeight - top - 24;
		const floor = MIN_ROW_PX * rows + gridGap() * (rows - 1);
		return Math.max(available, Math.min(base, floor));
	}

	/**
	 * 一个「比例单位」折算成多少 px——比例和总是 1，所以它就是整条可用轨道空间。
	 *
	 * 行高分两种：沉浸模式下面板 fixed 铺满视口，墙面高度确定，直接用墙面高度；
	 * 非沉浸模式下墙面高度是内容撑出来的，得回到「目标总高」这个总量（见 wallTargetHeight）。
	 */
	function unitPx(kind: 'c' | 'r', cols: number, rows: number): number {
		const gap = gridGap();
		if (kind === 'c') return Math.max(1, wallEl!.clientWidth - gap * (cols - 1));
		if (immersive()) return Math.max(1, wallEl!.clientHeight - gap * (rows - 1));
		// 行之间还有 gap，可用轨道空间要先把它们扣掉——和 `applyTracks()` 里算法保持一致，
		// 否则拖动分隔条时的最小格高会差那么十几像素。
		return Math.max(1, wallTargetHeight(cols, rows) - gap * (rows - 1));
	}

	/**
	 * 把比例写成 `grid-template-columns` / `grid-template-rows`。
	 *
	 * 列宽用 fr：容器宽度确定，fr 按比例分且把 gap 算在里面（用百分比会连 gap 一起超出去）。
	 * 行高在全屏时同样用 fr 跟着视口长；非全屏时容器高度不确定，fr 会被当成 auto
	 * （实测行高塌成标题条那么高），所以按 `wallTargetHeight()` 折成 px。
	 */
	function applyTracks(): void {
		const { cols, rows } = arrangement(state.layout);
		const ratio = ratiosOf(state.layout, cols, rows);
		wallEl!.style.gridTemplateColumns = ratio.c.map((v) => `${v}fr`).join(' ');
		if (immersive()) {
			wallEl!.style.gridTemplateRows = ratio.r.map((v) => `${v}fr`).join(' ');
		} else {
			// 行之间还有 gap，得从目标总高里先扣掉，否则整墙会比视口高出几行 gap。
			const total = wallTargetHeight(cols, rows) - gridGap() * (rows - 1);
			wallEl!.style.gridTemplateRows = ratio.r.map((v) => `${Math.max(40, v * total).toFixed(1)}px`).join(' ');
		}
		drawSplitters(cols, rows);
		syncRoomPanelHeight();
		// 格子尺寸变了，取景的比例也得跟着重算，否则已经在播的画面会错位。
		refitCrops();
	}

	/**
	 * 让左侧房间列表**和墙一样高**。
	 *
	 * 侧栏原来写的是 `lg:max-h-[calc(100dvh-6rem)]`：它按「面板顶到视口顶」算，
	 * 可实际上它跟墙一样从标题 / 工具栏下面开始（实测 top≈389px），于是整页被它顶出一条长滚动条，
	 * 两侧底边也参差不齐。这里按实测的顶边算，和 `wallTargetHeight()` 用的是同一套数。
	 */
	function syncRoomPanelHeight(): void {
		if (!roomPanelEl) return;
		if (window.innerWidth < 1024 || immersive()) {
			roomPanelEl.style.maxHeight = '';
			return;
		}
		const top = roomPanelEl.getBoundingClientRect().top;
		roomPanelEl.style.maxHeight = `${Math.max(320, window.innerHeight - top - 24)}px`;
	}

	/** `c:1` 是第 1 列与第 2 列之间的竖条，`r:2` 是第 2 行与第 3 行之间的横条。 */
	function splitParts(key: string): { kind: 'c' | 'r'; index: number } {
		return { kind: key[0] === 'r' ? 'r' : 'c', index: Number(key.slice(2)) };
	}

	/** 分隔条两侧的格子：竖条取右侧那一列的第一格，横条取下方那一行的第一格。 */
	function splitAnchor(key: string, cols: number): HTMLElement | null {
		const { kind, index } = splitParts(key);
		const slot = kind === 'c' ? index : index * cols;
		return wallEl!.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
	}

	/**
	 * 画 / 挪分隔条。
	 *
	 * 元素按 key 复用，拖动中**绝不能重建**：`setPointerCapture` 捕获在元素上，元素一被换掉捕获
	 * 就没了，拖到一半直接断。所以这里只补齐缺的、删掉多的，位置每次重算。
	 */
	function drawSplitters(cols: number, rows: number): void {
		const box = document.getElementById('wall-splitters');
		if (!box) return;
		const wanted = new Set<string>();
		for (let i = 1; i < cols; i++) wanted.add(`c:${i}`);
		for (let j = 1; j < rows; j++) wanted.add(`r:${j}`);
		for (const [key, el] of splitters) {
			if (!wanted.has(key)) {
				el.remove();
				splitters.delete(key);
			}
		}
		for (const key of wanted) {
			let el = splitters.get(key);
			if (!el) {
				const { kind, index } = splitParts(key);
				const vertical = kind === 'c';
				el = document.createElement('button');
				el.type = 'button';
				el.className = `wall-splitter wall-splitter-${vertical ? 'c' : 'r'}`;
				el.dataset.split = key;
				el.setAttribute('role', 'separator');
				el.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
				el.setAttribute('aria-valuemin', '0');
				el.setAttribute('aria-valuemax', '100');
				el.setAttribute(
					'aria-label',
					vertical ? `调整第 ${index} 列与第 ${index + 1} 列的宽度` : `调整第 ${index} 行与第 ${index + 1} 行的高度`,
				);
				el.addEventListener('pointerdown', (e) => startDrag(e, el!));
				el.addEventListener('keydown', onSplitterKey);
				box.append(el);
				splitters.set(key, el);
			}
			positionSplitter(el, key, cols, rows);
		}
	}

	function positionSplitter(el: HTMLElement, key: string, cols: number, rows: number): void {
		const { kind, index } = splitParts(key);
		const tile = splitAnchor(key, cols);
		if (!tile) return;
		const offset = gridGap() / 2 + SPLIT_HIT_PX / 2;
		const wallRect = wallEl!.getBoundingClientRect();
		const rect = tile.getBoundingClientRect();
		if (kind === 'c') {
			el.style.left = `${rect.left - wallRect.left - offset}px`;
			el.style.width = `${SPLIT_HIT_PX}px`;
			el.style.top = '0px';
			el.style.height = `${wallEl!.clientHeight}px`;
		} else {
			el.style.top = `${rect.top - wallRect.top - offset}px`;
			el.style.height = `${SPLIT_HIT_PX}px`;
			el.style.left = '0px';
			el.style.width = `${wallEl!.clientWidth}px`;
		}
		const ratio = ratiosOf(state.layout, cols, rows);
		const list = kind === 'c' ? ratio.c : ratio.r;
		const share = list[index - 1] + list[index];
		el.setAttribute('aria-valuenow', String(Math.round((list[index - 1] / (share || 1)) * 100)));
	}

	/**
	 * 挪一条分隔条：两侧轨道一个涨一个跌，总尺寸不变（等于"重新分"而不是"整体放大"）。
	 *
	 * 下限取 `MIN_*_PX`，空间实在不够时退到该对的四分之一——手机上两列本来就只有 150px 宽，
	 * 按固定的 120px 卡死会一点都拖不动。
	 */
	function adjust(kind: 'c' | 'r', index: number, deltaPx: number): void {
		const { cols, rows } = arrangement(state.layout);
		const ratio = ratiosOf(state.layout, cols, rows);
		const list = kind === 'c' ? ratio.c : ratio.r;
		const unit = unitPx(kind, cols, rows);
		const pair = list[index - 1] + list[index];
		const min = Math.min((kind === 'c' ? MIN_COL_PX : MIN_ROW_PX) / unit, pair / 4);
		const lo = min - list[index - 1];
		const hi = list[index] - min;
		const d = lo > hi ? pair / 2 - list[index - 1] : Math.min(hi, Math.max(lo, deltaPx / unit));
		list[index - 1] += d;
		list[index] -= d;
		state.ratios[String(state.layout)] = ratio;
		applyTracks();
	}

	function startDrag(e: PointerEvent, el: HTMLElement): void {
		const key = el.dataset.split;
		if (!key || e.button !== 0) return;
		e.preventDefault();
		const { kind, index } = splitParts(key);
		// 指针捕获必须打在这个元素上：拖动会横穿 iframe，父页面收不到 pointermove，
		// 捕获之后事件才会一直回投给它。
		el.setPointerCapture(e.pointerId);
		el.dataset.active = '1';
		document.documentElement.style.cursor = kind === 'c' ? 'col-resize' : 'row-resize';
		document.documentElement.style.userSelect = 'none';
		let last = kind === 'c' ? e.clientX : e.clientY;
		const move = (ev: PointerEvent) => {
			const now = kind === 'c' ? ev.clientX : ev.clientY;
			if (now === last) return;
			adjust(kind, index, now - last);
			last = now;
		};
		const end = () => {
			document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', end);
			document.removeEventListener('pointercancel', end);
			delete el.dataset.active;
			document.documentElement.style.cursor = '';
			document.documentElement.style.userSelect = '';
			save();
		};
		document.addEventListener('pointermove', move);
		document.addEventListener('pointerup', end);
		document.addEventListener('pointercancel', end);
	}

	/** 拖拽的等价操作：焦点落在分隔条上时用方向键挪。 */
	function onSplitterKey(e: KeyboardEvent): void {
		const el = e.currentTarget as HTMLElement;
		const key = el.dataset.split;
		if (!key) return;
		const { kind, index } = splitParts(key);
		const step = e.shiftKey ? KEY_STEP_PX * 3 : KEY_STEP_PX;
		const delta =
			kind === 'c'
				? e.key === 'ArrowLeft'
					? -step
					: e.key === 'ArrowRight'
						? step
						: 0
				: e.key === 'ArrowUp'
					? -step
					: e.key === 'ArrowDown'
						? step
						: 0;
		if (!delta) return;
		e.preventDefault();
		adjust(kind, index, delta);
		save();
	}

	/** 取景开关的状态。每格的位置微调按钮在格子里，由 tileHtml 渲染。 */
	function syncCropControls(): void {
		document.getElementById('wall-crop')?.setAttribute('aria-pressed', String(state.crop));
	}

	/**
	 * 把 iframe 放大再错位，让播放器正好落在格子里。
	 *
	 * `scale(s) translate(-cx, -cy)`：translate 在缩放前的坐标系里生效，
	 * 所以播放器左上角 (spec.x, spec.y) 正好映射到格子左上角。
	 * 缩放取 cover（宽高各算一次取大者），格子不是 16:9 时按多的那头裁，不会留白。
	 */
	function fitCrop(frame: HTMLIFrameElement, spec: CropSpec, key: string): void {
		const body = frame.parentElement;
		if (!body) return;
		const tw = body.clientWidth;
		const th = body.clientHeight;
		if (tw < 2 || th < 2) return;
		const s = Math.max(tw / spec.w, th / spec.h);
		const cx = spec.x + (spec.w - tw / s) / 2;
		const cy = spec.y + (state.cropOffsets[key] ?? 0) + (spec.h - th / s) / 2;
		frame.style.transform = `scale(${s}) translate(${-cx}px, ${-cy}px)`;
	}

	/**
	 * 窗口或格子尺寸变了要重算，否则画面会错位。
	 *
	 * 这里同时管两件浮在画面上的东西：取景的 iframe（`transform` 错位）和斗鱼的弹幕层
	 * （收进画面矩形，见 `fitDanmaku`）。所以它其实是「格子尺寸变了」的统一入口。
	 */
	function refitCrops(): void {
		wallEl!.querySelectorAll<HTMLIFrameElement>('iframe[data-crop]').forEach((frame) => {
			const spec = cropSpecOf(frame.dataset.platform ?? '');
			if (spec && frame.dataset.key) fitCrop(frame, spec, frame.dataset.key);
		});
		refitDanmaku();
	}

	function cropSpecOf(platform: string): CropSpec | undefined {
		return CROP[platform as Platform];
	}

	// ------------------------------------------------------------ 斗鱼：直链 + <video>

	/**
	 * 斗鱼格子**自己播流**，不再嵌整页。
	 *
	 * 为什么可以这么做（都是实测出来的，别凭直觉改）：
	 *
	 * - 服务端能解出直链：`betard → getEncryption →` 纯 MD5 签名 `→ getH5PlayV1`
	 *   （见 `lib/liveStream.ts`，**不需要跑平台 JS**）。
	 * - 斗鱼 CDN 给 `Access-Control-Allow-Origin: *`，浏览器直连没有跨域问题。
	 * - **视频字节不过我们的服务器**：`/api/live/stream-url` 只回一条 URL，剩下的浏览器直接去 CDN 拉。
	 *
	 * 但那条 URL 有两个要命的性质，整个实现都是绕着它们转的：
	 *
	 * 1. **一次性。** 同一个 token 第一次拉能一直推（实测 6 秒 11MB），第二次只剩约 400KB 就断。
	 *    所以任何重试、重播、换清晰度都**必须重新解析**，绝不能把旧地址再用一次。
	 * 2. **有效期很短。** 解析完等 25 秒再拉就已经断（1 秒内没事）。所以是「点了才解析、解析完立刻播」，
	 *    不能提前解析揣着。
	 *
	 * 顺带一提：这两条也解释了「为什么之前怎么试都只出一秒画面」——诊断脚本在播放前先用这条地址
	 * 探了三次 CORS，token 被消耗掉了。
	 *
	 * 好处是实打实的：画面 `object-fit: contain` **整幅**落在格子里（不必再去裁平台的页面，
	 * 格子和 16:9 不合时留黑边）、**音量归父页面管**（默认静音，想让哪一格出声就点哪一格）、
	 * 内存比嵌整页小得多。
	 * 代价是每次播放要一次解析往返（约 1～4 秒），以及斗鱼改接口时这一块会先坏。
	 */
	interface DouyuTile {
		player: {
			pause(): void;
			unload(): void;
			detachMediaElement(): void;
			destroy(): void;
		};
	video: HTMLVideoElement;
	/** 弹幕那条长连接。和播放器是两码事，但生命周期绑定在同一格里（见 `destroyDouyuTile`）。 */
	danmaku: DanmakuHandle;
}
	const douyuTiles = new Map<number, DouyuTile>();
	/** 每格已重试几次（重新解析算一次）。轮播房间放完会 ended，允许自动续一次。 */
	const retries = new Map<number, number>();

	function setHint(tile: HTMLElement, text: string): void {
		const el = tile.querySelector('.tile-hint');
		if (el) el.textContent = text;
	}

	function destroyDouyuTile(index: number): void {
		const entry = douyuTiles.get(index);
		douyuTiles.delete(index);
		if (!entry) return;
		try {
			entry.player.pause();
			entry.player.unload();
			entry.player.detachMediaElement();
			entry.player.destroy();
		} catch {
			// 已经坏掉的播放器，销毁失败无所谓。
		}
		// 弹幕是另一条连接，播放器销毁失败也得关掉——不然换格之后它还在往一个不存在的格子里塞。
		entry.danmaku.close();
		entry.video.remove();
	}

	function destroyAllDouyuTiles(): void {
		for (const index of [...douyuTiles.keys()]) destroyDouyuTile(index);
	}

	/** 直链播不动时的退路：把这个格子切回「嵌平台整页 + 取景」那条老路。 */
	function useIframeFallback(index: number, note: string): void {
		destroyDouyuTile(index);
		state.iframeKeys = [...new Set([...state.iframeKeys, state.slots[index] ?? ''])].filter(Boolean);
		save();
		setNote(note);
		// 只重画这一格：`renderWall()` 会把别的格子里正在播的画面一起停掉（实测掉过一回）。
		resetTile(index);
		playSlot(index);
	}

	// ------------------------------------------------------------ 斗鱼的弹幕

	/** 弹幕车道数。4 条在 4/6/9 格里也不会糊成一片；再多就变成刷屏。 */
	const DANMAKU_LANES = 4;
	/** 滚动速度（px/s）。比平台自己那层慢一点——观众看的是比赛，不是弹幕。 */
	const DANMAKU_SPEED = 110;
	/** 一条弹幕最多几个字。斗鱼的长弹幕很少，截掉比让一条占满整屏强。 */
	const DANMAKU_MAX_CHARS = 60;
	/** 每条车道「上一次占用的尾巴什么时候离开右边缘」，跟着格子存（格子换了就没了）。 */
	const danmakuLanes = new WeakMap<HTMLElement, number[]>();

	interface DanmakuHandle {
		close(): void;
		overlay: HTMLElement;
	}

	/**
	 * 往格子里推一条弹幕。
	 *
	 * 车道「谁先空谁接」：每条车道记着上一条的尾巴离开右边缘的时刻，新弹幕走最早空出来的那条；
	 * 全满就直接叠在最早空的那条上——直播弹幕晚几秒就没人看了，宁可重叠也别排队。
	 *
	 * 动画交给 Web Animations API 而不是 CSS：时长得按字数算（长弹幕走久一点），用 CSS 就得给每条
	 * 弹幕写一次 `animation-duration` 内联样式，还得让 keyframes 知道格子宽度，绕一圈不如这里直接
	 * 给两个 `translateX`。`oncancel` 也得收尾——格子被换掉时动画会停在半路。
	 */
	function pushDanmaku(overlay: HTMLElement, raw: string): void {
		const width = overlay.clientWidth;
		if (width < 2) return;
		// 大主播一秒十几条，不设上限浏览器会被 DOM 拖住（9 格同开时尤其）。
		if (overlay.childElementCount > 40) return;

		const text = raw.slice(0, DANMAKU_MAX_CHARS);
		const el = document.createElement('span');
		el.className = 'tile-danmaku-item';
		el.textContent = text;
		overlay.append(el);

		/*
		 * 宽度**估**出来，不去 `getBoundingClientRect()`：那会强制一次重排，而弹幕是按每条来的，
		 * 9 格同开时一秒上百次重排、代价比这点偏差大得多。中日韩字符按 13px、其余按 7px 估，
		 * 估偏了只影响「车道多久算空出来」，不影响文字本身。
		 */
		let laneWidth = 0;
		for (const ch of text) laneWidth += ch.codePointAt(0)! > 0x2e80 ? 13 : 7;
		const distance = width + laneWidth;
		const duration = (distance / DANMAKU_SPEED) * 1000;

		const lanes = danmakuLanes.get(overlay) ?? new Array<number>(DANMAKU_LANES).fill(0);
		danmakuLanes.set(overlay, lanes);
		const now = performance.now();
		let lane = 0;
		for (let i = 1; i < lanes.length; i++) if (lanes[i] < lanes[lane]) lane = i;
		lanes[lane] = now + (laneWidth / distance) * duration + 200;
		el.style.top = `${(lane * 100) / DANMAKU_LANES}%`;

		const animation = el.animate(
			[{ transform: `translateX(${width}px)` }, { transform: `translateX(${-laneWidth}px)` }],
			{ duration, easing: 'linear' },
		);
		const drop = (): void => el.remove();
		animation.onfinish = drop;
		animation.oncancel = drop;
	}

	/**
	 * 把弹幕层收进**画面本身**的范围。
	 *
	 * 画面是 `object-fit: contain` 的：格子比 16:9 宽时左右会留黑边，弹幕铺满整格就会跑到黑边上，
	 * 白字飘在画面外的黑底上看着像 bug。这里按视频自己的比例算出画面矩形（浏览器就是这么摆的），
	 * 把弹幕层缩进去。
	 *
	 * 拿不到尺寸就保持原样（`loadedmetadata` 之前 `videoWidth` 是 0），所以起播后还要再调一次；
	 * 格子尺寸变了由 `refitOverlays()` 负责。
	 */
	function fitDanmaku(video: HTMLVideoElement, overlay: HTMLElement): void {
		const body = overlay.parentElement;
		const vw = video.videoWidth;
		const vh = video.videoHeight;
		if (!body || !vw || !vh) return;
		const w = body.clientWidth;
		const h = body.clientHeight;
		if (w < 2 || h < 2) return;
		const scale = Math.min(w / vw, h / vh);
		const width = vw * scale;
		const height = vh * scale;
		overlay.style.left = `${(w - width) / 2}px`;
		overlay.style.top = `${(h - height) / 2}px`;
		overlay.style.width = `${width}px`;
		overlay.style.height = `${height}px`;
	}

	/** 格子尺寸变了重算弹幕范围（和 `refitCrops()` 一起被调）。 */
	function refitDanmaku(): void {
		for (const entry of douyuTiles.values()) fitDanmaku(entry.video, entry.danmaku.overlay);
	}

	/**
	 * 开一条弹幕连接，把 `chatmsg` 画到这个格子上。
	 *
	 * 斗鱼的弹幕是**另一条长连接**（不进视频流，也不经过我们的服务器，见 `lib/douyuDanmaku.ts`），
	 * 所以它和播放器是两条命：播放器被销毁时这里必须跟着 `close()`，否则换格之后它还在收。
	 *
	 * 显示层在这里建（而不是在 `playDouyu` 摆 `<video>` 那几行里）：弹幕要盖在画面上，
	 * 得等 `<video>` 先进 DOM 才有得盖，而「建层 → 挂连接 → 登记进 `douyuTiles`」本来就该是一处的事。
	 */
	function startDanmaku(r: RoomRef, video: HTMLVideoElement): DanmakuHandle {
		const body = video.parentElement;
		// 弹幕浮在画面上。左下角那排按钮在 `.tile-body` 外面，所以这层不吃点击。
		const overlay = document.createElement('div');
		overlay.className = 'tile-danmaku';
		// 一屏几十条、一直在变的聊天文字，对读屏只是噪音（和头像底、播放图标一样是装饰）。
		overlay.setAttribute('aria-hidden', 'true');
		body?.append(overlay);
		// 起播前 `videoWidth` 是 0，`fitDanmaku()` 算不出来，所以拿到尺寸后补一次。
		video.addEventListener('loadedmetadata', () => fitDanmaku(video, overlay));
		// 连上之前给按钮留个说法：斗鱼有时会无视新连接，那时格子里一条弹幕都不来，光看画面
		// 分不出「没连上」和「没人说话」。
		const toggle = overlay.closest<HTMLElement>('[data-slot]')?.querySelector<HTMLElement>('.tile-danmaku-toggle');
		const client = createDouyuDanmaku({
			roomId: r.roomId,
			onStatus: (status) => {
				if (toggle) toggle.title = status === 'live' ? '这一格的弹幕开关' : '弹幕还没连上（斗鱼有时会无视新连接，会自动重试）';
			},
			onPacket: (packet) => {
				// 只要聊天的。进场/礼物/在线列表（`uenter` / `dgb` / `oul` …）画上去只会更乱。
				if (packet.type === 'chatmsg' && packet.fields.txt) pushDanmaku(overlay, packet.fields.txt);
			},
		});
		return { close: () => client.close(), overlay };
	}

	/** 每格左下角那组控制：静音开关 + 停止 + 当前清晰度。 */
	function douyuControls(index: number, quality: string, muted: boolean): string {
		const btn =
			'flex h-6 items-center justify-center rounded bg-ink/80 px-1.5 text-cream/80 backdrop-blur transition hover:bg-dota hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';
		return `<span class="absolute bottom-2 left-2 z-10 flex items-center gap-1" role="group" aria-label="这一格的声音与播放">
			<button type="button" class="tile-mute ${btn}" data-tile="${index}" aria-pressed="${muted ? 'true' : 'false'}" aria-label="${muted ? '让这一格出声' : '把这一格静音'}">${muted ? '🔇' : '🔊'}</button>
			<button type="button" class="tile-danmaku-toggle ${btn}" data-tile="${index}" aria-pressed="true" aria-label="把这一格的弹幕隐藏">弹</button>
			<button type="button" class="tile-stop ${btn}" data-tile="${index}" aria-label="停掉这一格（房间留在格子里）">■</button>
			<span class="rounded bg-ink/80 px-1.5 py-0.5 text-[10px] text-cream/60 backdrop-blur">${esc(quality)}</span>
		</span>`;
	}

	/**
	 * 斗鱼格子的播放：解析 → 立刻用 `<video>` 播。
	 *
	 * 这里的 `await` 顺序不能动：拿到 `url` 之后**中间不能再插任何请求**（包括探测、预加载、日志上报），
	 * 否则就是在烧那个一次性 token。
	 */
	async function playDouyu(index: number, r: RoomRef): Promise<void> {
		const tile = wallEl!.querySelector<HTMLElement>(`[data-slot="${index}"]`);
		if (!tile) return;
		destroyDouyuTile(index);
		tile.querySelector('.tile-video-controls')?.remove();
		tile.querySelector('.tile-idle')?.remove();
		const body = tile.querySelector<HTMLElement>('.tile-body');
		if (!body) return;
		body.innerHTML = '<div class="tile-loading absolute inset-0 grid place-items-center text-[11px] text-faint">取直链…</div>';

		let payload: { ok?: boolean; url?: string; kind?: string; quality?: string; error?: string };
		try {
			const res = await fetch(`/api/live/stream-url?platform=douyu&room=${encodeURIComponent(r.roomId)}`);
			payload = (await res.json()) as typeof payload;
		} catch (e) {
			payload = { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		// 解析期间用户可能已经把这一格换掉/清掉了。
		if (!tile.isConnected || state.slots[index] !== r.key) return;
		if (!payload.ok || !payload.url) {
			useIframeFallback(index, `斗鱼直链解析失败（${payload.error ?? '未知原因'}），这一格已切回平台页面。`);
			return;
		}

		body.innerHTML = '';
		const video = document.createElement('video');
		// 多路同时出声只会糊成一片，所以默认静音；要哪一路出声点它左下角的喇叭。
		video.muted = true;
		video.autoplay = true;
		video.playsInline = true;
		video.className = 'h-full w-full';
		/*
		 * **整幅显示，不裁画面**（`contain`，不是 `cover`）。
		 *
		 * 格子的长宽比跟着格数走：4/6/9 格时行高被压得比 16:9 矮（见 `wallTargetHeight`），
		 * 宽出来的那一截用 `cover` 就是从左右把画面切掉——比赛里贴边的血条、比分板正好在那儿。
		 * 所以宁可留两条黑边（`.tile-body` 本来就是 `bg-black`），让画面按原始比例完整落在格子里。
		 * 代价是画面比格子小一圈，平台的清晰度不够时更明显。
		 */
		video.style.objectFit = 'contain';
		body.append(video);

		const quality = payload.quality ?? '';
		tile.insertAdjacentHTML('beforeend', `<span class="tile-video-controls contents">${douyuControls(index, quality, true)}</span>`);

		let mpegts: typeof import('mpegts.js').default;
		try {
			// 按需加载：只在真的播斗鱼时才把这 200 多 KB 的库拉下来。
			mpegts = (await import('mpegts.js')).default;
		} catch (e) {
			useIframeFallback(index, `播放器没加载起来（${e instanceof Error ? e.message : String(e)}），这一格已切回平台页面。`);
			return;
		}
		if (!tile.isConnected || state.slots[index] !== r.key) return;

		const retry = (): void => {
			const used = (retries.get(index) ?? 0) + 1;
			retries.set(index, used);
			if (used <= 2) {
				// **重新解析**，绝不重用刚才那条地址。
				void playDouyu(index, r);
			} else {
				useIframeFallback(index, '这一格反复播不起来，已切回平台页面（点「播放这一格」可再试）。');
			}
		};

		const player = mpegts.createPlayer(
			{ type: payload.kind === 'm3u8' ? 'mse' : 'flv', isLive: true, url: payload.url },
			// 直播：别攒缓冲，起播要快。
			{ enableStashBuffer: false, stashInitialSize: 128, liveBufferLatencyChasing: true },
		);
		player.on(mpegts.Events.ERROR, retry);
		// 轮播房间（斗鱼 `videoLoop === 1`）拉到的是一段有限的流，放完就是 ended：自动续一次。
		video.addEventListener('ended', retry);
		player.attachMediaElement(video);
		/*
		 * **先登记，再 load/play。**
		 *
		 * 登记晚于 `play()` 时，下面两条失败分支（ERROR 早于 play 落定、自动播放被拦）里的
		 * `useIframeFallback()` → `destroyDouyuTile()` 会在表里查不到条目、直接 return：
		 * pause / unload / detachMediaElement / destroy 一个都不执行，而 `resetTile()` 已经把这个
		 * `<video>` 换出 DOM。结果是格子上显示兜底页面、后台仍挂着一个 mpegts loader 在拉流，
		 * 它的 ERROR handler 还会再触发一次重新解析，等于多叠一个 player。弹幕连接同理：
		 * 得有人在表里负责关它。
		 */
		douyuTiles.set(index, { player, video, danmaku: startDanmaku(r, video) });
		player.load();
		try {
			await player.play();
			retries.set(index, 0);
			setHint(tile, '');
		} catch (e) {
			// 起播这段时间里用户可能已经把这一格清掉或换成别的房间了，那时别拿「自动播放被拦」
			// 去解释——播放器已经在表里，`resetTile()` 负责销毁它。
			if (!tile.isConnected || state.slots[index] !== r.key) return;
			useIframeFallback(index, `自动播放被拦（${e instanceof Error ? e.message : String(e)}），这一格已切回平台页面。`);
			return;
		}
	}

	/**
	 * 只把一个格子恢复成「未播放」的样子，**不动其它格子**。
	 *
	 * 事件全部委托在 `#wall` 上，所以这里直接换掉那一格的 DOM 是安全的；比重建整面墙好得多
	 * ——后者会把别的格子里正在播的画面一起停掉。
	 */
	function resetTile(index: number): void {
		const tile = wallEl!.querySelector<HTMLElement>(`[data-slot="${index}"]`);
		if (!tile) return;
		destroyDouyuTile(index);
		retries.delete(index);
		const wrapper = document.createElement('div');
		wrapper.innerHTML = tileHtml(index).trim();
		const fresh = wrapper.firstElementChild;
		if (fresh) tile.replaceWith(fresh);
		// 点 ✕ 会把房间移出格子，格数随之变化——只重画这一格，所以这里得自己刷工具栏。
		syncWallStatus();
	}

	/** 真正创建 iframe 只发生在用户点了播放之后。 */
	function playSlot(index: number): void {
		const tile = wallEl!.querySelector<HTMLElement>(`[data-slot="${index}"]`);
		const key = state.slots[index];
		if (!tile || !key) return;
		const r = rooms.get(key) ?? state.manual.find((m) => m.key === key);
		if (!r) return;
		// 斗鱼走直链自己播；用户显式要求「用平台页面」时（解析失败/手动切）才回到 iframe。
		if (r.platform === 'douyu' && !state.iframeKeys.includes(r.key)) {
			void playDouyu(index, r);
			return;
		}
		const body = tile.querySelector('.tile-body');
		if (!body || body.querySelector('iframe')) return;
		tile.querySelector('.tile-idle')?.remove();

		const spec = state.crop ? cropSpecOf(r.platform) : undefined;
		const frame = document.createElement('iframe');
		// 嵌哪一页由 `embedUrl()` 决定：虎牙是官方的纯播放器页，斗鱼是整页（要靠 spec 裁）。
		const url = embedUrl(r.platform, r.roomId);
		// 先按正常地址加载，锚点等页面出来再补（见 scheduleAnchor 的注释）。
		frame.src = url;
		frame.title = `${r.name} 直播间`;
		frame.className = spec ? 'absolute left-0 top-0' : 'h-full w-full';
		// 虎牙那个纯播放器页自己带音量滑杆；`autoplay` 交给平台页自己判断，
		// 父页面读不到它的音量，但用户可以在格子里单独拖。
		frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
		frame.setAttribute('loading', 'lazy');
		if (spec) {
			frame.dataset.crop = '1';
			frame.dataset.platform = r.platform;
			frame.dataset.key = r.key;
			frame.style.width = `${CROP_VIEW.w}px`;
			frame.style.height = `${CROP_VIEW.h}px`;
			frame.style.transformOrigin = '0 0';
			scheduleAnchor(frame, url, spec.anchor);
			// 父容器得先有尺寸才能算缩放。
			body.prepend(frame);
			fitCrop(frame, spec, r.key);
			return;
		}
		body.prepend(frame);
	}

	/**
	 * 只改 transform，**不重渲染**——renderWall 会重建 innerHTML 把已经加载的 iframe 全冲掉，
	 * 那等于"一微调就把画面停了"。中间那个数字按钮就地改文本即可。
	 */
	function shiftCrop(index: number, delta: number): void {
		const key = state.slots[index];
		if (!key) return;
		const next = Math.max(-600, Math.min(600, (state.cropOffsets[key] ?? 0) + delta));
		if (next === 0) delete state.cropOffsets[key];
		else state.cropOffsets[key] = next;
		save();
		refitCrops();
		const label = wallEl!.querySelector(`.tile-crop-reset[data-tile="${index}"]`);
		if (label) label.textContent = next > 0 ? `+${next}` : String(next);
	}

	function resetCrop(index: number): void {
		const key = state.slots[index];
		if (key) delete state.cropOffsets[key];
		save();
		refitCrops();
		const label = wallEl!.querySelector(`.tile-crop-reset[data-tile="${index}"]`);
		if (label) label.textContent = '0';
	}

	/** 切换取景方式后把已经在播的格子重新加载，省得用户再点一遍。 */
	function reloadPlayers(): void {
		const playing = [...wallEl!.querySelectorAll<HTMLElement>('[data-slot]')]
			// 斗鱼是 `<video>`（在 `douyuTiles` 里），虎牙与兜底是 `<iframe>`，两边都要捞。
			.filter((tile) => tile.querySelector('iframe') || douyuTiles.has(Number(tile.dataset.slot)))
			.map((tile) => Number(tile.dataset.slot))
			.filter((n) => Number.isInteger(n));
		renderWall();
		for (const index of playing) playSlot(index);
	}

	function stopAll(): void {
		destroyAllDouyuTiles();
		wallEl!.querySelectorAll('iframe').forEach((f) => f.remove());
		renderWall();
	}

	// ------------------------------------------------------------ 全屏

	function immersive(): boolean {
		return pageFull || browserFull;
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
	 * 只切类名与轨道尺寸，**绝不重渲染**：renderWall 会重建 innerHTML，把已经加载的 iframe 全部冲掉，
	 * 那就成了"一全屏就把画面停了"。行高由 applyTracks 按当前是否沉浸重算（px ↔ fr），
	 * 只是改样式，已加载的播放器不受影响。
	 */
	function applyImmersive(): void {
		panelEl?.classList.toggle('wall-immersive', immersive());
		// 网页全屏时面板盖住了整页，底下的滚动要锁住。
		document.body.classList.toggle('wall-immersive-lock', pageFull);
		applyTracks();
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

	document.getElementById('wall-crop')?.addEventListener('click', () => {
		state.crop = !state.crop;
		save();
		reloadPlayers();
		setNote(
			state.crop
				? '只显示画面（只在「嵌平台整页」的兜底路上生效）：裁到播放器区域，页面其余部分不显示。切换会重新加载画面；某一格位置偏了，用它左下角的上下按钮对齐。正常走直链的斗鱼格子和虎牙格子用不到这个开关。'
				: '',
		);
	});

	/** 均分：删掉当前格数的自定义比例，回到默认。 */
	document.getElementById('wall-even')?.addEventListener('click', () => {
		delete state.ratios[String(state.layout)];
		save();
		applyTracks();
		setNote('已把每列宽度与每行高度恢复成等分。');
	});

	// 格子尺寸变了就要重算（换格数、进全屏、拉窗口）：列宽变化要重写轨道，行高变化要挪分隔条，
	// 取景还要跟着重算。宽度没变时不重写轨道——非沉浸模式下行高是我们自己写上去的 px，
	// 重写会再触发一次观察回调，容易和观察器来回打转。只改 transform 不影响布局，也不会成环。
	if (typeof ResizeObserver !== 'undefined') {
		let lastWidth = wallEl!.clientWidth;
		new ResizeObserver(() => {
			const width = wallEl!.clientWidth;
			if (width !== lastWidth) {
				lastWidth = width;
				applyTracks();
			} else {
				const { cols, rows } = arrangement(state.layout);
				drawSplitters(cols, rows);
			}
			refitCrops();
		}).observe(wallEl!);
	}

	/*
	 * 只改窗口高度时（拖窗口下沿、手机上地址栏收起）`ResizeObserver` 那条路不会重写轨道——
	 * 而墙面现在是要撑满视口的，视口一变行高就得跟着变。所以单独听一次 resize，
	 * 只在高度的确变了时才重算（宽度变化归上面那个观察器管，避免两边同时写轨道）。
	 */
	let lastViewportHeight = window.innerHeight;
	window.addEventListener('resize', () => {
		if (window.innerHeight === lastViewportHeight) return;
		lastViewportHeight = window.innerHeight;
		applyTracks();
	});

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
		const cropUp = target.closest<HTMLElement>('.tile-crop-up');
		if (cropUp?.dataset.tile) {
			shiftCrop(Number(cropUp.dataset.tile), -20);
			return;
		}
		const cropDown = target.closest<HTMLElement>('.tile-crop-down');
		if (cropDown?.dataset.tile) {
			shiftCrop(Number(cropDown.dataset.tile), 20);
			return;
		}
		const cropReset = target.closest<HTMLElement>('.tile-crop-reset');
		if (cropReset?.dataset.tile) {
			resetCrop(Number(cropReset.dataset.tile));
			return;
		}
		// 斗鱼直链播放时的两个控制：静音开关（多路分屏最需要的那件事）与「停掉但留着房间」。
		const mute = target.closest<HTMLButtonElement>('.tile-mute');
		if (mute?.dataset.tile) {
			const entry = douyuTiles.get(Number(mute.dataset.tile));
			if (entry) {
				entry.video.muted = !entry.video.muted;
				mute.textContent = entry.video.muted ? '🔇' : '🔊';
				mute.setAttribute('aria-pressed', String(entry.video.muted));
				mute.setAttribute('aria-label', entry.video.muted ? '让这一格出声' : '把这一格静音');
			}
		return;
	}
	// 弹幕开关：只切这一格的显示，连接照收——关了再开要重连一次，还得重新等 `loginres`。
	const danmakuToggle = target.closest<HTMLButtonElement>('.tile-danmaku-toggle');
	if (danmakuToggle?.dataset.tile) {
		const entry = douyuTiles.get(Number(danmakuToggle.dataset.tile));
		if (entry) {
			const show = entry.danmaku.overlay.style.display === 'none';
			entry.danmaku.overlay.style.display = show ? '' : 'none';
			danmakuToggle.setAttribute('aria-pressed', String(show));
			danmakuToggle.setAttribute('aria-label', show ? '把这一格的弹幕隐藏' : '把这一格的弹幕显示出来');
			danmakuToggle.classList.toggle('opacity-40', !show);
		}
		return;
	}
	const stopTile = target.closest<HTMLElement>('.tile-stop');
		if (stopTile?.dataset.tile) {
			resetTile(Number(stopTile.dataset.tile));
			return;
		}
		// 「直链」：把这一格从「嵌平台整页」切回自己播流。
		const useVideo = target.closest<HTMLElement>('.tile-use-video');
		if (useVideo?.dataset.tile) {
			const index = Number(useVideo.dataset.tile);
			const key = state.slots[index];
			if (key) {
				state.iframeKeys = state.iframeKeys.filter((k) => k !== key);
				save();
				resetTile(index);
				playSlot(index);
			}
			return;
		}
		const remove = target.closest<HTMLElement>('.tile-remove');
		if (remove?.dataset.tile) {
			const index = Number(remove.dataset.tile);
			state.slots[index] = null;
			save();
			// 只重画这一格：重建整面墙会把其它格子里正播的画面一起停掉。
			resetTile(index);
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
