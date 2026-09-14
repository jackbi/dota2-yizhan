import { promises as fs } from 'node:fs';
import path from 'node:path';
import { reportSource } from './dataHealth';
import { extractJson, fetchNote, fetchText } from './fetchText';
import type { RoomRef } from '../data/types';

/**
 * 热门 DOTA2 直播间列表（构建期抓取）。
 *
 * 两个来源都是平台自己给分区页用的那份数据：
 *
 * - 斗鱼 `https://www.douyu.com/g_DOTA2`。分区页把房间列表以 JSON 内嵌在 HTML 里
 *   （`{"cateInfo":…,"list":[{"authInfo":…,"rid":9999,"nn":"yyfyyf",…}]}`），所以
 *   必须按 **原始 HTML** 取，不能让它转成 markdown——本机直连被重置时走代理，
 *   就得给 `r.jina.ai` 带上 `x-respond-with: html`，否则拿不到这段 JSON。
 *   页面里写的 `pagePath: /gapi/rknc/directory/mixListV1/2_3/` 直接请求是 404，
 *   别去试。
 * - 虎牙 `https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=7`。
 *   `gameId=7` 是 DOTA2（`m=Game&do=getGameList` 里查到的；1 是英雄联盟、6 是 DOTA1）。
 *
 * **房间号要取对**：虎牙列表里 `privateHost` 是 `longdd` 这种靓号字符串，
 * 开播接口只认 `profileRoom`（LongDD 是 678555），所以这里用 `profileRoom`。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'roomlist');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
/** 热门榜变化不快，而且拉一次要过代理，缓存给长一点。 */
const TTL_SECONDS = 30 * 60;

const DOUYU_PAGE = 'https://www.douyu.com/g_DOTA2';
const HUYA_LIST = 'https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=7&page=1';

/** 内嵌 JSON 里的字符串是转义过的，借 JSON.parse 还原。 */
function jsonStr(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	try {
		const s = JSON.parse(`"${raw}"`) as string;
		return s.trim() === '' ? undefined : s.trim();
	} catch {
		return raw.trim() === '' ? undefined : raw;
	}
}

/**
 * 斗鱼分区页解析。
 *
 * 房间对象都以 `{"authInfo"` 开头，按它切块后在块内取字段——比整段正则安全，
 * 不会跨对象误匹配（房间里还嵌着 icv3、rs_ext 这些含花括号的子对象）。
 */
export function parseDouyuCategory(html: string): Omit<RoomRef, 'key' | 'source'>[] {
	const start = html.indexOf('"cateInfo"');
	const region = start >= 0 ? html.slice(start) : html;
	const rooms: Omit<RoomRef, 'key' | 'source'>[] = [];
	const seen = new Set<string>();

	for (const chunk of region.split('{"authInfo"').slice(1)) {
		const pick = (re: RegExp) => re.exec(chunk)?.[1];
		const roomId = pick(/"rid":(\d+)/);
		if (!roomId || seen.has(roomId)) continue;
		const labelRaw = pick(/"roomLabel":\[(.*?)\]/);
		const labels = labelRaw
			? [...labelRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => jsonStr(m[1])).filter((v): v is string => !!v)
			: [];
		const name = jsonStr(pick(/"nn":"((?:[^"\\]|\\.)*)"/));
		if (!name) continue;
		seen.add(roomId);
		rooms.push({
			platform: 'douyu',
			roomId,
			name,
			title: jsonStr(pick(/"rn":"((?:[^"\\]|\\.)*)"/)),
			hot: Number(pick(/"ol":(\d+)/) ?? 0) || undefined,
			labels: labels.length ? labels : undefined,
		});
	}
	return rooms;
}

/** 虎牙分区列表解析。`profileRoom` 才是接口认的房间号。 */
export function parseHuyaCategory(json: unknown): Omit<RoomRef, 'key' | 'source'>[] {
	const root = json as { status?: unknown; data?: { datas?: Record<string, unknown>[] } } | null;
	if (!root || Number(root.status) !== 200) return [];
	const rooms: Omit<RoomRef, 'key' | 'source'>[] = [];
	for (const row of root.data?.datas ?? []) {
		const roomId = String(row.profileRoom ?? '').trim();
		const name = String(row.nick ?? '').trim();
		if (!roomId || !name) continue;
		const title = String(row.roomName ?? '').trim();
		const hot = Number(String(row.totalCount ?? '').replace(/\D/g, '')) || undefined;
		rooms.push({ platform: 'huya', roomId, name, title: title || undefined, hot });
	}
	return rooms;
}

function toRefs(rows: Omit<RoomRef, 'key' | 'source'>[]): RoomRef[] {
	return rows.map((r) => ({ ...r, key: `${r.platform}:${r.roomId}`, source: 'popular' as const }));
}

async function readCache(file: string, ttlSeconds: number): Promise<RoomRef[] | null> {
	try {
		const stat = await fs.stat(file);
		if (Date.now() - stat.mtimeMs >= ttlSeconds * 1000) return null;
		return JSON.parse(await fs.readFile(file, 'utf8')) as RoomRef[];
	} catch {
		return null;
	}
}

async function writeCache(file: string, rooms: RoomRef[]): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(file, JSON.stringify(rooms), 'utf8');
	} catch {
		// 缓存写不进去不影响构建。
	}
}

async function loadOne(file: string, url: string, html: boolean, parse: (text: string) => Omit<RoomRef, 'key' | 'source'>[]): Promise<RoomRef[]> {
	const cached = await readCache(file, TTL_SECONDS);
	if (cached) return cached;

	const stale = OFFLINE ? await readCache(file, Number.POSITIVE_INFINITY) : null;
	if (stale) return stale;

	if (OFFLINE) return [];

	const text = await fetchText(url, { html });
	if (!text) return (await readCache(file, Number.POSITIVE_INFINITY)) ?? [];

	const rows = parse(text);
	if (rows.length === 0) return (await readCache(file, Number.POSITIVE_INFINITY)) ?? [];

	const rooms = toRefs(rows);
	await writeCache(file, rooms);
	return rooms;
}

let listPromise: Promise<RoomRef[]> | null = null;

/**
 * 构建期抓取热门房间列表。返回的每一项都可能被页面上任何组件复用，
 * 所以用单飞把它压成一次抓取。
 */
export function fetchPopularRooms(): Promise<RoomRef[]> {
	if (!listPromise) listPromise = loadAll();
	return listPromise;
}

async function loadAll(): Promise<RoomRef[]> {
	const [douyu, huya] = await Promise.all([
		loadOne(path.join(CACHE_DIR, 'douyu.json'), DOUYU_PAGE, true, parseDouyuCategory),
		loadOne(path.join(CACHE_DIR, 'huya.json'), HUYA_LIST, false, (text) => parseHuyaCategory(extractJson(text))),
	]);

	const note = fetchNote();
	const usable = douyu.length + huya.length;
	await reportSource(
		'roomlist',
		'热门直播间',
		note ? 'fresh' : usable > 0 ? 'cache' : 'empty',
		usable > 0 ? `斗鱼 ${douyu.length} 个、虎牙 ${huya.length} 个${note}` : '没有取到热门列表',
	);

	return [...douyu, ...huya];
}
