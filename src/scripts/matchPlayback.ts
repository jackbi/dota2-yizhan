import {
	GRID_SIZE,
	LANE_PATHS,
	MAP_BUILDINGS,
	PLAYFIELD,
	RIVER_PATH,
	ROSHAN_PITS,
	SIDE_COLOR,
	toCanvas,
	wardKindColor,
} from '../lib/dotaMap';
import { formatElapsed } from '../lib/format';

/**
 * 地图回放的客户端渲染。
 *
 * 画布用 2D canvas 而不是引地图库：底图是几十条固定折线，动态层是十个点加几条尾迹，
 * 这个体量上手写的代码比任何库的初始化都短，也不必为 SSR 下的水合做处理。
 *
 * 坐标：备份存储固定 1024×1024，数据坐标是 Valve 的 0–255 网格（`dotaMap` 里有全部说明）。
 * 换算全部走 `project()`，尺寸统一以「格」为单位乘 `UNIT`——这样调缩放时不用逐个改魔数。
 *
 * 时间轴上的三件事各有来源：英雄位置来自 `playerUpdatePositionEvents`（逐秒），
 * 眼位的生效区间来自 `wardEvents` 的 SPAWN / DESPAWN 配对，建筑倒塌来自 `towerDeaths`。
 */

const SIZE = 1024;
/** 尾迹长度（秒）。整局轨迹都画会糊成一团，只留最近半分钟。 */
const TRAIL_SECONDS = 30;
/** 画布四周留白（像素）。 */
const VIEW_PAD = 34;
/** 可行走区域在数据坐标里的边长：58–197。 */
const FIELD_SPAN = PLAYFIELD.x1 - PLAYFIELD.x0;
/** 一格数据坐标对应多少画布像素。整张底图只画可行走区域，所以比「255 格铺满画布」放大了约 75%。 */
const UNIT = (SIZE - VIEW_PAD * 2) / FIELD_SPAN;

/**
 * 数据坐标 → 画布像素。
 *
 * 先把可行走区域的左上角（数据坐标里是 (x0, y1)）对齐到画布留白处，再按 `UNIT` 放大——
 * 直接拿 0–255 铺满画布的话，地图只占中间五成，英雄点会小到看不清。
 */
function project(x: number, y: number): [number, number] {
	const [cx, cy] = toCanvas(x, y);
	return [(cx - PLAYFIELD.x0) * UNIT + VIEW_PAD, (cy - (GRID_SIZE - PLAYFIELD.y1)) * UNIT + VIEW_PAD];
}

interface MetaPlayer {
	heroId: number;
	name: string;
	accountName: string;
	isRadiant: boolean;
	color: string;
}

interface Meta {
	matchId: number;
	duration: number;
	players: MetaPlayer[];
}

interface PlaybackPlayer {
	heroId: number;
	isRadiant: boolean;
	/** 扁平三元组 `[t, x, y, …]`。 */
	points: number[];
}

interface PlaybackWard {
	t: number;
	x: number;
	y: number;
	kind: string;
	/** 插眼方阵营（0 天辉 / 1 夜魇），对不上槽位时为 null。 */
	side: 0 | 1 | null;
	end: number | null;
}

interface Playback {
	matchId: number;
	durationSeconds: number;
	players: PlaybackPlayer[];
	wards: PlaybackWard[];
	roshan: number[];
	falls: { t: number; npcId: number; side: number }[];
}

const meta = readMeta();
const root = document.getElementById('replay-root');
const canvas = document.getElementById('replay-canvas') as HTMLCanvasElement | null;

if (meta && root && canvas) setup(meta, root, canvas);

function readMeta(): Meta | null {
	const element = document.getElementById('replay-meta');
	if (!element?.textContent) return null;
	try {
		return JSON.parse(element.textContent) as Meta;
	} catch {
		return null;
	}
}

function setup(meta: Meta, root: HTMLElement, canvas: HTMLCanvasElement): void {
	const context = canvas.getContext('2d');
	if (!context) return;
	// 另存一份非空引用：下面几个渲染函数是函数声明（会被提升），TS 不对它们保留收窄结果。
	const ctx: CanvasRenderingContext2D = context;

	const gate = document.getElementById('replay-gate');
	const hint = document.getElementById('replay-hint');
	const controls = document.getElementById('replay-controls');
	const loadButton = document.getElementById('replay-load') as HTMLButtonElement | null;
	const toggle = document.getElementById('replay-toggle');
	const range = document.getElementById('replay-range') as HTMLInputElement | null;
	const timeLabel = document.getElementById('replay-time');
	const speeds = [...document.querySelectorAll<HTMLButtonElement>('#replay-speeds [data-speed]')];
	const legend = [...document.querySelectorAll<HTMLLIElement>('#replay-legend [data-hero]')];
	const wardToggle = document.getElementById('replay-wards') as HTMLInputElement | null;

	/** 建筑倒塌时间，画塔时按当前时刻决定明暗。 */
	const fallTime = new Map<number, number>();
	/** 英雄 id → 配色 / 名字，来自服务端内联的那份表。 */
	const metaByHero = new Map(meta.players.map((player) => [player.heroId, player]));

	let playback: Playback | null = null;
	let time = 0;
	let playing = false;
	let speed = 1;
	let highlight: number | null = null;
	let showWards = wardToggle?.checked ?? true;
	let frame = 0;
	let lastFrameAt = 0;

	const duration = meta.duration;

	// 先把只有底图的画面画出来：没载入轨迹也看得出这是哪张地图、塔在哪。
	renderField(ctx);
	renderStaticLayer(ctx, 0, fallTime);
	renderTime();

	loadButton?.addEventListener('click', () => {
		if (hint) hint.textContent = '正在向 STRATZ 取轨迹，约几秒…';
		loadButton.disabled = true;
		void load();
	});

	async function load(): Promise<void> {
		try {
			const response = await fetch(root.dataset.api ?? '');
			const body = (await response.json()) as { ok: boolean; playback?: Playback; reason?: string };
			if (!body.ok || !body.playback) {
				if (hint) hint.textContent = body.reason ?? '取轨迹失败';
				if (loadButton) loadButton.disabled = false;
				return;
			}
			playback = body.playback;
			for (const fall of playback.falls) fallTime.set(fall.npcId, fall.t);
			gate?.remove();
			if (controls) controls.hidden = false;
			render();
		} catch {
			if (hint) hint.textContent = '网络请求失败，稍后再试';
			if (loadButton) loadButton.disabled = false;
		}
	}

	function render(): void {
		renderField(ctx);
		renderStaticLayer(ctx, time, fallTime);
		renderActors(ctx);
		renderTime();
	}

	function renderTime(): void {
		if (range) range.value = String(Math.floor(time));
		if (timeLabel) timeLabel.textContent = `${formatElapsed(time)} / ${formatElapsed(duration)}`;
	}

	function renderActors(ctx: CanvasRenderingContext2D): void {
		if (!playback) return;

		// 眼位：SPAWN 到 DESPAWN 之间才算「当时看得见」。没被反掉的眼一直画到结束。
		// 画成一只眼睛：**填充色分真假眼**（绿 = 假眼、蓝 = 真眼），**描边色分插眼方**
		// （天辉绿、夜魇红）。两个信息都留着——「这是真眼还是假眼」和「谁插的」是复盘时
		// 最常问的两句，挤在一个点上也只能靠颜色和描边各表一边。
		if (showWards) {
			for (const ward of playback.wards) {
				if (time < ward.t) continue;
				if (ward.end !== null && time >= ward.end) continue;
				const [x, y] = project(ward.x, ward.y);
				drawEye(ctx, x, y, wardKindColor(ward.kind), ward.side === null ? 'rgba(21,8,6,0.85)' : SIDE_COLOR[ward.side]);
			}
		}

		// 肉山：位置取最后一个不晚于当前时刻的采样点。上游大量事件只有时间没有坐标，那些已经丢掉。
		const roshan = positionAt(playback.roshan, time);
		if (roshan) {
			const [x, y] = project(roshan[0], roshan[1]);
			ctx.beginPath();
			ctx.arc(x, y, 1.1 * UNIT, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(217,160,94,0.9)';
			ctx.fill();
			ctx.lineWidth = 0.3 * UNIT;
			ctx.strokeStyle = 'rgba(21,8,6,0.9)';
			ctx.stroke();
		}

		playback.players.forEach((player, index) => {
			const info = metaByHero.get(player.heroId);
			const color = info?.color ?? '#f4ebe3';
			const dim = highlight !== null && highlight !== player.heroId;
			ctx.globalAlpha = dim ? 0.25 : 1;

			// 尾迹
			const trail: [number, number][] = [];
			const start = indexAtOrBefore(player.points, time - TRAIL_SECONDS);
			const end = indexAtOrBefore(player.points, time);
			for (let index = Math.max(0, start); index <= end; index += 1) {
				trail.push([player.points[index * 3 + 1] ?? 0, player.points[index * 3 + 2] ?? 0]);
			}
			if (trail.length > 1) {
				ctx.beginPath();
				trail.forEach(([x, y], index) => {
					const [cx, cy] = project(x, y);
					if (index === 0) ctx.moveTo(cx, cy);
					else ctx.lineTo(cx, cy);
				});
				ctx.strokeStyle = color;
				ctx.globalAlpha = dim ? 0.12 : 0.45;
				ctx.lineWidth = 0.7 * UNIT;
				ctx.lineJoin = 'round';
				ctx.stroke();
				ctx.globalAlpha = dim ? 0.25 : 1;
			}

			const position = positionAt(player.points, time);
			if (!position) return;
			const [px, py] = project(position[0], position[1]);

			if (highlight === player.heroId) {
				ctx.beginPath();
				ctx.arc(px, py, 2.1 * UNIT, 0, Math.PI * 2);
				ctx.strokeStyle = 'rgba(244,235,227,0.7)';
				ctx.lineWidth = 0.3 * UNIT;
				ctx.stroke();
			}

			ctx.beginPath();
			ctx.arc(px, py, 1.25 * UNIT, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.lineWidth = 0.32 * UNIT;
			ctx.strokeStyle = 'rgba(21,8,6,0.9)';
			ctx.stroke();

			const name = info?.name ?? `英雄 #${player.heroId}`;
			ctx.font = `600 ${Math.round(2.3 * UNIT)}px ui-sans-serif, system-ui, sans-serif`;
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			ctx.lineWidth = 0.45 * UNIT;
			ctx.strokeStyle = 'rgba(21,8,6,0.85)';
			// 十个人挤在肉山坑或高地时会完全重叠，按编号给个纵向错位——不是排版技巧，
			// 而是「团战里谁站哪儿」本身就要能读出来。
			const stagger = ((index % 3) - 1) * 1.1 * UNIT;
			ctx.strokeText(name, px + 1.5 * UNIT, py + stagger);
			ctx.fillStyle = '#f4ebe3';
			ctx.fillText(name, px + 1.5 * UNIT, py + stagger);
		});
		ctx.globalAlpha = 1;
	}

	// ---------------------------------------------------------------- 交互

	toggle?.addEventListener('click', () => {
		playing = !playing;
		toggle.textContent = playing ? '暂停' : '播放';
		if (playing) {
			// 播到底之后再按播放，从头开始，省得读者手动把滑块拖回去。
			if (time >= duration - 0.5) time = 0;
			lastFrameAt = 0;
			frame = requestAnimationFrame(advance);
		} else {
			cancelAnimationFrame(frame);
		}
	});

	range?.addEventListener('input', () => {
		time = Number(range.value);
		render();
	});

	for (const button of speeds) {
		button.addEventListener('click', () => {
			speed = Number(button.dataset.speed) || 1;
			for (const other of speeds) other.setAttribute('aria-pressed', String(other === button));
		});
	}

	for (const item of legend) {
		const heroId = Number(item.dataset.hero);
		item.addEventListener('mouseenter', () => {
			highlight = heroId;
			render();
		});
		item.addEventListener('mouseleave', () => {
			highlight = null;
			render();
		});
	}

	wardToggle?.addEventListener('change', () => {
		showWards = wardToggle.checked;
		render();
	});

	function advance(now: number): void {
		const elapsed = lastFrameAt === 0 ? 0 : (now - lastFrameAt) / 1000;
		lastFrameAt = now;
		time = Math.min(duration, time + elapsed * speed);
		render();
		if (time >= duration) {
			playing = false;
			if (toggle) toggle.textContent = '播放';
			return;
		}
		frame = requestAnimationFrame(advance);
	}
}

/** 扁平静态层：可行走区域、河与肉山坑、三条路、建筑。 */
function renderField(ctx: CanvasRenderingContext2D): void {
	ctx.clearRect(0, 0, SIZE, SIZE);

	const { x0, y0, x1, y1, radius } = PLAYFIELD;
	const [left, top] = project(x0, y1);
	const [right, bottom] = project(x1, y0);
	roundedRect(ctx, left, top, right - left, bottom - top, radius * UNIT);
	ctx.fillStyle = 'rgba(244,235,227,0.05)';
	ctx.fill();
	ctx.strokeStyle = 'rgba(244,235,227,0.18)';
	ctx.lineWidth = 0.4 * UNIT;
	ctx.stroke();

	// 两个角落标出阵营。地图上「哪边是天辉」靠颜色也能看出来，但十个小圆点里认颜色容易走神，
	// 一句「天辉」把这件事从推测变成事实。
	ctx.font = `600 ${Math.round(2.2 * UNIT)}px ui-sans-serif, system-ui, sans-serif`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'left';
	ctx.fillStyle = SIDE_COLOR[0];
	ctx.fillText('天辉', left + 0.4 * UNIT, bottom - 1.6 * UNIT);
	ctx.textAlign = 'right';
	ctx.fillStyle = SIDE_COLOR[1];
	ctx.fillText('夜魇', right - 0.4 * UNIT, top + 1.6 * UNIT);
	ctx.textAlign = 'left';
}

function renderStaticLayer(ctx: CanvasRenderingContext2D, time: number, fallTime: Map<number, number>): void {
	// 三条路：先铺一层略亮的底，再画中心虚线，读起来像小地图上的路。
	for (const path of Object.values(LANE_PATHS)) {
		strokePath(ctx, path, 'rgba(244,235,227,0.06)', 4.2 * UNIT);
		strokePath(ctx, path, 'rgba(244,235,227,0.14)', 0.45 * UNIT, [1.6 * UNIT, 1.9 * UNIT]);
	}

	// 河与两个肉山坑。7.33 起肉山在两坑之间来回走，所以两处都要画。
	strokePath(ctx, RIVER_PATH, 'rgba(120,170,190,0.26)', 5.6 * UNIT);
	for (const [x, y] of ROSHAN_PITS) {
		const [cx, cy] = project(x, y);
		ctx.beginPath();
		ctx.arc(cx, cy, 5.4 * UNIT, 0, Math.PI * 2);
		ctx.fillStyle = 'rgba(120,170,190,0.20)';
		ctx.fill();
		ctx.strokeStyle = 'rgba(120,170,190,0.38)';
		ctx.lineWidth = 0.3 * UNIT;
		ctx.stroke();
	}

	for (const building of MAP_BUILDINGS) {
		const fallen = (fallTime.get(building.npcId) ?? Number.POSITIVE_INFINITY) <= time;
		const [cx, cy] = project(building.x, building.y);
		const size = (building.kind === 'fort' ? 3.4 : building.kind === 'barracks' ? 1.9 : 2.6) * UNIT;
		ctx.globalAlpha = fallen ? 0.22 : 1;
		ctx.beginPath();
		ctx.rect(cx - size / 2, cy - size / 2, size, size);
		ctx.fillStyle = SIDE_COLOR[building.side];
		ctx.fill();
		ctx.lineWidth = 0.3 * UNIT;
		ctx.strokeStyle = 'rgba(21,8,6,0.85)';
		ctx.stroke();
		if (fallen) {
			// 被推掉的建筑打一个叉，而不是直接消失——读者要看的是「这里原来有座塔」。
			ctx.beginPath();
			ctx.moveTo(cx - size / 2, cy - size / 2);
			ctx.lineTo(cx + size / 2, cy + size / 2);
			ctx.moveTo(cx + size / 2, cy - size / 2);
			ctx.lineTo(cx - size / 2, cy + size / 2);
			ctx.strokeStyle = 'rgba(21,8,6,0.9)';
			ctx.lineWidth = 0.3 * UNIT;
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	}
}

function strokePath(ctx: CanvasRenderingContext2D, path: [number, number][], color: string, width: number, dash: number[] = []): void {
	ctx.beginPath();
	path.forEach(([x, y], index) => {
		const [cx, cy] = project(x, y);
		if (index === 0) ctx.moveTo(cx, cy);
		else ctx.lineTo(cx, cy);
	});
	ctx.strokeStyle = color;
	ctx.lineWidth = width;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.setLineDash(dash);
	ctx.stroke();
	ctx.setLineDash([]);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + width - r, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + r);
	ctx.lineTo(x + width, y + height - r);
	ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
	ctx.lineTo(x + r, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

/**
 * 眼位标记：一只眼睛（柳叶形轮廓 + 瞳孔）。
 *
 * 两条二次曲线合成上下眼睑——`(w/2, h)` 这类尺寸都以「格」为单位，随 `UNIT` 缩放，
 * 将来改地图缩放时不用逐个改魔数。
 */
function drawEye(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, stroke: string): void {
	const width = 2.7 * UNIT;
	const lid = 1.15 * UNIT;
	ctx.globalAlpha = 0.92;
	ctx.beginPath();
	ctx.moveTo(x - width / 2, y);
	ctx.quadraticCurveTo(x, y - lid * 2, x + width / 2, y);
	ctx.quadraticCurveTo(x, y + lid * 2, x - width / 2, y);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
	ctx.lineWidth = 0.34 * UNIT;
	ctx.strokeStyle = stroke;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(x, y, 0.55 * UNIT, 0, Math.PI * 2);
	ctx.fillStyle = 'rgba(21,8,6,0.9)';
	ctx.fill();
	ctx.globalAlpha = 1;
}

/** 最后一个不晚于 `t` 的采样点下标；全都在 `t` 之后时返回 -1。 */
function indexAtOrBefore(points: number[], t: number): number {
	let low = 0;
	let high = points.length / 3 - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if ((points[mid * 3] ?? 0) <= t) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found;
}

function positionAt(points: number[], t: number): [number, number] | null {
	const index = indexAtOrBefore(points, t);
	if (index < 0) return null;
	return [points[index * 3 + 1] ?? 0, points[index * 3 + 2] ?? 0];
}
