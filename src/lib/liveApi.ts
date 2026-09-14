import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';
import { OB_ROOMS } from '../data/ob';
import type { LiveSnapshot, LiveState, LiveStatus, Platform } from '../data/types';

/**
 * 直播间开播状态层。
 *
 * 斗鱼/虎牙的房间页都是客户端渲染、且禁止被 iframe 嵌套，开播状态只能问平台自己的接口：
 * - 斗鱼 https://open.douyucdn.cn/api/RoomApi/room/{id}
 * - 虎牙 https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid={id}
 *
 * 两条注意：
 * 1. 这两个接口都没有 CORS 头，浏览器里拿不到，只能在构建期由 Node 抓。
 *    所以静态站上显示的是**构建那一刻的快照**，页面必须把抓取时间写出来。
 * 2. 部分网络（本机就是）到 douyu/huya 的 TLS 握手会被直接重置。这时退回到
 *    `r.jina.ai` 读取代理——它能把原始 JSON 原样取回。可用 `LIVE_PROXY` 控制：
 *    `auto`（默认，直连优先）/ `jina`（只走代理）/ `off`（只直连）。
 *
 * 拿不到就如实标 unknown，绝不猜——这个仓库之前就因为硬编码的假「正在直播」和
 * 假人气值被坑过一次。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'live');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const PROXY_MODE = (process.env.LIVE_PROXY ?? 'auto').toLowerCase();
const JINA_PREFIX = 'https://r.jina.ai/';

/** 开播状态变化很快，缓存只用来省掉同一轮构建里的重复请求。 */
const TTL_SECONDS = 5 * 60;
const DIRECT_TIMEOUT_MS = 8000;
const PROXY_TIMEOUT_MS = 30_000;
/** 代理是第三方服务，别把它打爆。 */
const CONCURRENCY = 3;
/** 两条路都失败时整轮重试的次数（含首次）。 */
const ATTEMPTS = 2;
const ATTEMPT_DELAY_MS = 600;

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const LIVE_STATE_LABEL: Record<LiveState, string> = {
	live: '直播中',
	replay: '轮播中',
	offline: '未开播',
	unknown: '状态未知',
};

// ---------------------------------------------------------------- 解析

interface ParsedRoom {
	state: LiveState;
	ownerName?: string;
	roomName?: string;
	category?: string;
	popularity?: number;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/** 从纯 JSON 或 r.jina.ai 的 "Markdown Content:" 包裹里取出 JSON 对象。 */
function extractJson(text: string): unknown {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function parseDouyu(json: unknown): ParsedRoom | null {
	const root = json as { error?: unknown; data?: Record<string, unknown> } | null;
	if (!root || Number(root.error) !== 0 || !root.data) return null;
	const d = root.data;
	const status = String(d.room_status ?? '');
	return {
		state: status === '1' ? 'live' : status === '2' ? 'offline' : 'unknown',
		ownerName: str(d.owner_name),
		roomName: str(d.room_name),
		category: str(d.cate_name),
		popularity: num(d.online),
	};
}

function parseHuya(json: unknown): ParsedRoom | null {
	const root = json as { status?: unknown; data?: Record<string, unknown> } | null;
	if (!root || Number(root.status) !== 200 || !root.data) return null;
	const d = root.data;
	const liveData = (d.liveData ?? {}) as Record<string, unknown>;
	const profile = (d.profileInfo ?? {}) as Record<string, unknown>;
	const live = String(d.liveStatus ?? '');
	return {
		state: live === 'ON' ? 'live' : live === 'REPLAY' ? 'replay' : live === 'OFF' ? 'offline' : 'unknown',
		ownerName: str(profile.nick),
		roomName: str(liveData.roomName),
		category: str(liveData.gameFullName),
		popularity: num(liveData.totalCount),
	};
}

function apiUrl(platform: Platform, roomId: string): string | null {
	if (platform === 'douyu') return `https://open.douyucdn.cn/api/RoomApi/room/${roomId}`;
	if (platform === 'huya') return `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${roomId}`;
	return null;
}

function parseByPlatform(platform: Platform, json: unknown): ParsedRoom | null {
	if (platform === 'douyu') return parseDouyu(json);
	if (platform === 'huya') return parseHuya(json);
	return null;
}

// ---------------------------------------------------------------- 抓取

let networkFetches = 0;
let viaProxy = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 直连，被网络重置时返回 null。 */
async function tryDirect(url: string): Promise<{ json: unknown; proxied: boolean } | null> {
	if (PROXY_MODE === 'jina') return null;
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
			signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const json = extractJson(await res.text());
		if (!json) return null;
		networkFetches += 1;
		return { json, proxied: false };
	} catch {
		// 直连被重置（本机到 douyu/huya 就是这样），换代理。
		return null;
	}
}

async function tryProxy(url: string): Promise<{ json: unknown; proxied: boolean } | null> {
	if (PROXY_MODE === 'off') return null;
	try {
		// 不要给 r.jina.ai 带 User-Agent：带上浏览器 UA 反而会触发它的 Cloudflare
		// 人机验证（403 "Just a moment..."），不带才会正常返回内容。
		// 这和 STRATZ 那边"UA 必须是 STRATZ_API"是同一类坑。
		const res = await fetch(`${JINA_PREFIX}${url}`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
		if (!res.ok) return null;
		const json = extractJson(await res.text());
		if (!json) return null;
		networkFetches += 1;
		viaProxy += 1;
		return { json, proxied: true };
	} catch {
		// 代理也不通。
		return null;
	}
}

/**
 * 直连优先，被网络重置时退回读取代理。
 *
 * 代理是第三方服务，偶发失败很正常（实测 11 个房间里有 1 个会掉），所以两条路都重试一次；
 * 重试仍拿不到就如实返回 null，由调用方标成「状态未知」。
 */
async function fetchRoomJson(url: string): Promise<{ json: unknown; proxied: boolean } | null> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const result = (await tryDirect(url)) ?? (await tryProxy(url));
		if (result) return result;
		if (attempt < ATTEMPTS - 1) await sleep(ATTEMPT_DELAY_MS);
	}
	return null;
}

// ---------------------------------------------------------------- 缓存

async function readCache(file: string, ttlSeconds: number): Promise<LiveStatus | null> {
	try {
		const stat = await fs.stat(file);
		if (Date.now() - stat.mtimeMs >= ttlSeconds * 1000) return null;
		return JSON.parse(await fs.readFile(file, 'utf8')) as LiveStatus;
	} catch {
		return null;
	}
}

async function readStale(file: string): Promise<LiveStatus | null> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as LiveStatus;
	} catch {
		return null;
	}
}

async function writeCache(file: string, status: LiveStatus): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(file, JSON.stringify(status), 'utf8');
	} catch {
		// 缓存写不进去不影响构建。
	}
}

// ---------------------------------------------------------------- 单个房间

/** 平台没给昵称时不判定为易主——不能凭缺失的信息下结论。 */
function ownerMatches(ownerName: string | undefined, keys: string[]): boolean {
	if (!ownerName) return true;
	const lower = ownerName.toLowerCase();
	return keys.some((key) => lower.includes(key.toLowerCase()));
}

async function loadRoom(room: (typeof OB_ROOMS)[number]): Promise<LiveStatus> {
	const file = path.join(CACHE_DIR, `${room.platform}-${room.roomId}.json`);
	const cached = await readCache(file, TTL_SECONDS);
	if (cached) return cached;

	const stale = OFFLINE ? await readStale(file) : null;
	if (stale) return stale;

	const url = apiUrl(room.platform, room.roomId);
	if (!url) {
		return { state: 'unknown', ownerMismatch: false, fetchedAt: new Date().toISOString(), note: '暂不支持该平台' };
	}
	if (OFFLINE) {
		return { state: 'unknown', ownerMismatch: false, fetchedAt: new Date().toISOString(), note: '离线构建且没有缓存' };
	}

	const result = await fetchRoomJson(url);
	const parsed = result ? parseByPlatform(room.platform, result.json) : null;

	if (!parsed) {
		const fallback = await readStale(file);
		if (fallback) return fallback;
		return {
			state: 'unknown',
			ownerMismatch: false,
			fetchedAt: new Date().toISOString(),
			note: '平台接口没有响应',
		};
	}

	const mismatch = !ownerMatches(parsed.ownerName, room.ownerMatch);
	const status: LiveStatus = {
		...parsed,
		ownerMismatch: mismatch,
		fetchedAt: new Date().toISOString(),
		note: mismatch
			? parsed.ownerName === '用户已注销'
				? '房间已注销'
				: `房间现房主为「${parsed.ownerName}」`
			: undefined,
	};
	await writeCache(file, status);
	return status;
}

// ---------------------------------------------------------------- 对外接口

let snapshotPromise: Promise<LiveSnapshot> | null = null;

/**
 * 构建期抓取全部房间的开播状态。页面、首页与分屏页共用同一份结果，一次构建只抓一轮。
 */
export function fetchLiveSnapshot(): Promise<LiveSnapshot> {
	if (!snapshotPromise) snapshotPromise = loadAll();
	return snapshotPromise;
}

async function loadAll(): Promise<LiveSnapshot> {
	const statuses: Record<string, LiveStatus> = {};
	await mapLimit(OB_ROOMS, CONCURRENCY, async (room) => {
		statuses[room.key] = await loadRoom(room);
	});

	const counts = new Map<LiveState, number>();
	let mismatched = 0;
	for (const status of Object.values(statuses)) {
		counts.set(status.state, (counts.get(status.state) ?? 0) + 1);
		if (status.ownerMismatch) mismatched += 1;
	}

	const parts = (['live', 'replay', 'offline', 'unknown'] as LiveState[])
		.filter((state) => counts.has(state))
		.map((state) => `${LIVE_STATE_LABEL[state]} ${counts.get(state)}`);
	if (mismatched > 0) parts.push(`房间已失效 ${mismatched}`);

	const usable = (counts.get('live') ?? 0) + (counts.get('replay') ?? 0) + (counts.get('offline') ?? 0);
	const fetchNote = networkFetches > 0 ? `，联网抓取 ${networkFetches} 次${viaProxy > 0 ? `（代理 ${viaProxy}）` : ''}` : '';

	await reportSource(
		'live',
		'直播开播状态',
		networkFetches > 0 ? 'fresh' : usable > 0 ? 'cache' : 'empty',
		`${OB_ROOMS.length} 个房间：${parts.join('、') || '无数据'}${fetchNote}`,
	);

	return { at: new Date().toISOString(), statuses };
}
