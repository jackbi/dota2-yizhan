/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import { LANE_PATHS, ROSHAN_PITS } from './dotaMap.ts';
import type { MatchPlayback, PlaybackWard } from './matchReview.ts';

/**
 * 从地图回放的逐秒位置里还原「怎么打的」。
 *
 * 复盘面板那份数据只有结果与读数（经济差、建筑、账单），回答不了「15 分钟后为什么领先」——
 * 那要靠打法本身。而打法就藏在回放里：十个人每一秒在哪。这一层只做一件事：把这 2 万个点
 * **聚成能给模型读的几行**——什么时候哪一方聚在哪、什么时候双方撞在一起、眼布在哪片。
 *
 * 两条边界（都写进提示词，不靠模型自己猜）：
 * - 位置推得出「双方 24 分钟在中路河道撞上了」，推不出「谁先手、谁被秒」——没有击杀与施法事件；
 * - `roshan` 那份只是**位置采样**，不是击杀时间，所以只能当「他这段时间还活着」的弱信号。
 *
 * 纯函数、不联网：调用方（浏览器）负责取 `/api/replay/<id>`，这一层负责算。
 */

export interface PlaybackEvent {
	from: number;
	to: number;
	/** `fight` = 双方都来了足够多人；`assemble` = 只有一方抱团（多半是推塔或打野区的仗）。 */
	kind: 'fight' | 'assemble';
	/** 抱团的是哪一方；交战为 null（两边都算）。 */
	side: '天辉' | '夜魇' | null;
	region: string;
	/** 该区域里这一方最多有几个人。 */
	heroes: number;
	foeHeroes: number;
}

/** 肉山在某段时间里出现在某个坑（位置采样，不是击杀）。 */
export interface RoshanWindow {
	pit: string;
	from: number;
	to: number;
}

export interface PlaybackSummary {
	/** 采样间隔（秒）。 */
	stepSeconds: number;
	/** 参与采样的英雄位置点数，用来让模型知道这份轨迹有多全。 */
	heroSamples: number;
	/** 按重要性挑出来的事件，已按时间排好。 */
	events: PlaybackEvent[];
	roshan: RoshanWindow[];
	/** 插眼落在哪片区域：进攻视野还是自家野区，一眼能看出。 */
	wards: { side: '天辉' | '夜魇'; region: string; count: number }[];
}

/** 采样间隔。15 秒足够看出集结与转向，逐秒会把事件切得太碎。 */
const STEP_SECONDS = 15;
/** 双方在这一带各有 3 人以上，算撞上了。 */
const FIGHT_MIN = 3;
/** 一方 4 人以上、对面最多 1 人，算抱团推进 / 抓野区。 */
const ASSEMBLE_MIN = 4;
/** 给模型的事件条数上限：多了变成流水账，读者也读不过来。 */
const MAX_EVENTS = 16;
/** 位置多久没更新就当这一秒没有他的位置（死亡、录像缺段）。 */
const STALE_SECONDS = 30;

const LANE_TEXT: Record<string, string> = { top: '上路', mid: '中路', bottom: '下路' };
/** 河道线：`RIVER_PATH` 的两端点连起来就是 `x + y = 250`。 */
const RIVER_SUM = 250;
/** 距河道线多近算「河道」（格）。 */
const RIVER_HALF_WIDTH = 14;
/** 距某条路线多近算「在这条路上」，更远就是野区。 */
const LANE_NEAR = 24;

interface Point {
	t: number;
	x: number;
	y: number;
}

/** 扁平三元组 → 点。丢掉时间或坐标不完整的那些。 */
function toPoints(flat: number[]): Point[] {
	const points: Point[] = [];
	for (let index = 0; index + 2 < flat.length; index += 3) {
		const t = flat[index];
		const x = flat[index + 1];
		const y = flat[index + 2];
		if (typeof t !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
		points.push({ t, x, y });
	}
	return points;
}

/** 点到线段的距离。 */
function pointToSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(x - x1, y - y1);
	const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
	return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function distanceToPath(x: number, y: number, path: [number, number][]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 1; index < path.length; index += 1) {
		const from = path[index - 1];
		const to = path[index];
		if (!from || !to) continue;
		best = Math.min(best, pointToSegment(x, y, from[0], from[1], to[0], to[1]));
	}
	return best;
}

function nearestLane(x: number, y: number): { lane: string; distance: number } {
	let best = { lane: '中路', distance: Number.POSITIVE_INFINITY };
	for (const [key, path] of Object.entries(LANE_PATHS)) {
		const distance = distanceToPath(x, y, path);
		if (distance < best.distance) best = { lane: LANE_TEXT[key] ?? key, distance };
	}
	return best;
}

/**
 * 坐标 → 区域名。名字要能直接读给模型听：「夜魇下路」「中路河道」「天辉野区」。
 *
 * 河道那一档先判：线就是 `x + y = 250`，除以 √2 换成垂直距离。剩下的按最近的路线分三路，
 * 离三条路都远的就是野区，再按河道线分出天辉/夜魇半区。
 */
export function regionOf(x: number, y: number): string {
	const lane = nearestLane(x, y);
	if (Math.abs(x + y - RIVER_SUM) / Math.SQRT2 <= RIVER_HALF_WIDTH) return `${lane.lane}河道`;
	const side = x + y < RIVER_SUM ? '天辉' : '夜魇';
	return lane.distance <= LANE_NEAR ? `${side}${lane.lane}` : `${side}野区`;
}

/** 相邻两步同一类、同一区域就并成一段。中间允许断一步（15 秒的采样会漏格）。 */
function mergeEvents(raw: PlaybackEvent[], step: number): PlaybackEvent[] {
	const merged: PlaybackEvent[] = [];
	for (const event of raw) {
		const last = merged[merged.length - 1];
		if (last && last.kind === event.kind && last.side === event.side && last.region === event.region && event.from - last.to <= step * 2) {
			last.to = event.to;
			last.heroes = Math.max(last.heroes, event.heroes);
			last.foeHeroes = Math.max(last.foeHeroes, event.foeHeroes);
			continue;
		}
		merged.push({ ...event });
	}
	return merged;
}

/** 交战国模最重，其次看人数与持续时长——排序只为了挑选，不改变输出顺序。 */
function weight(event: PlaybackEvent): number {
	const duration = event.to - event.from;
	return (event.kind === 'fight' ? 1000 : 0) + (event.heroes + event.foeHeroes) * 10 + duration;
}

/**
 * 肉山位置采样 → 时间段。
 *
 * 只报「他在这段时间出现在这个坑」，**不报击杀**：这份数据里没有击杀事件，硬推会变成编。
 * 相邻采样间隔超过 2 分钟就断开（中间那段要么他在别处、要么数据缺）。
 */
function summariseRoshan(flat: number[]): RoshanWindow[] {
	const windows: RoshanWindow[] = [];
	for (const point of toPoints(flat)) {
		let pitIndex = 0;
		let best = Number.POSITIVE_INFINITY;
		ROSHAN_PITS.forEach(([px, py], index) => {
			const distance = Math.hypot(point.x - px, point.y - py);
			if (distance < best) {
				best = distance;
				pitIndex = index;
			}
		});
		const pit = pitIndex === 0 ? '近端坑' : '远端坑';
		const last = windows[windows.length - 1];
		if (last && last.pit === pit && point.t - last.to <= 120) {
			last.to = point.t;
			continue;
		}
		windows.push({ pit, from: point.t, to: point.t });
	}
	return windows.sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 5).sort((a, b) => a.from - b.from);
}

/** 插眼落在哪片区域。认不出阵营的（槽位对不上）直接跳过，与 `wardStats` 同一条口径。 */
function summariseWards(wards: PlaybackWard[]): { side: '天辉' | '夜魇'; region: string; count: number }[] {
	const counts = new Map<string, { side: '天辉' | '夜魇'; region: string; count: number }>();
	for (const ward of wards) {
		if (ward.side === null) continue;
		const side = ward.side === 0 ? '天辉' : '夜魇';
		const region = regionOf(ward.x, ward.y);
		const key = `${side}:${region}`;
		const row = counts.get(key) ?? { side, region, count: 0 };
		row.count += 1;
		counts.set(key, row);
	}
	// 每方只留最多的三片：一页里排十几行区域分布，读者也看不出重点。
	return ['天辉', '夜魇']
		.flatMap((side) =>
			[...counts.values()]
				.filter((row) => row.side === side)
				.sort((a, b) => b.count - a.count)
				.slice(0, 3),
		);
}

/**
 * 一局回放 → 打法摘要。没有位置数据时返回 null（调用方按「这局没有轨迹」处理）。
 */
export function summarizePlayback(playback: MatchPlayback): PlaybackSummary | null {
	const heroes = playback.players
		.map((player) => ({ isRadiant: player.isRadiant, points: toPoints(player.points) }))
		.filter((hero) => hero.points.length > 0);
	if (heroes.length === 0) return null;

	const lastTimes = heroes.map((hero) => hero.points[hero.points.length - 1]?.t ?? 0);
	const duration = playback.durationSeconds > 0 ? playback.durationSeconds : Math.max(...lastTimes);
	const cursor = heroes.map(() => 0);
	const raw: PlaybackEvent[] = [];

	for (let t = 0; t <= duration; t += STEP_SECONDS) {
		const groups = new Map<string, { radiant: number; dire: number }>();
		for (let index = 0; index < heroes.length; index += 1) {
			const hero = heroes[index]!;
			let at = cursor[index]!;
			while (at + 1 < hero.points.length && hero.points[at + 1]!.t <= t) at += 1;
			cursor[index] = at;
			const point = hero.points[at];
			// 开局前没有位置；长时间没更新（阵亡）也不算他在场——否则会凭空多出一堆「抱团」。
			if (!point || point.t > t || t - point.t > STALE_SECONDS) continue;
			const region = regionOf(point.x, point.y);
			const bucket = groups.get(region) ?? { radiant: 0, dire: 0 };
			if (hero.isRadiant) bucket.radiant += 1;
			else bucket.dire += 1;
			groups.set(region, bucket);
		}

		for (const [region, bucket] of groups) {
			if (bucket.radiant >= FIGHT_MIN && bucket.dire >= FIGHT_MIN) {
				raw.push({ from: t, to: t + STEP_SECONDS, kind: 'fight', side: null, region, heroes: bucket.radiant, foeHeroes: bucket.dire });
			} else if (bucket.radiant >= ASSEMBLE_MIN && bucket.dire <= 1) {
				raw.push({ from: t, to: t + STEP_SECONDS, kind: 'assemble', side: '天辉', region, heroes: bucket.radiant, foeHeroes: bucket.dire });
			} else if (bucket.dire >= ASSEMBLE_MIN && bucket.radiant <= 1) {
				raw.push({ from: t, to: t + STEP_SECONDS, kind: 'assemble', side: '夜魇', region, heroes: bucket.dire, foeHeroes: bucket.radiant });
			}
		}
	}

	const events = [...mergeEvents(raw, STEP_SECONDS)]
		.sort((a, b) => weight(b) - weight(a))
		.slice(0, MAX_EVENTS)
		.sort((a, b) => a.from - b.from);

	return {
		stepSeconds: STEP_SECONDS,
		heroSamples: heroes.reduce((total, hero) => total + hero.points.length, 0),
		events,
		roshan: summariseRoshan(playback.roshan),
		wards: summariseWards(playback.wards),
	};
}
