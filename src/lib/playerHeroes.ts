import path from 'node:path';
import { readCacheJson, writeCacheFile } from './buildCache';
import { reportSource, sourceState } from './dataHealth';
import type { PlayerHeroPool, PlayerMatchRow } from './heroPool';
import { summarizeHeroPool } from './heroPool';
import { fetchPatchUpdates } from './patchesApi';
import { stratzGql, stratzRuntimeConfigured } from './stratzRuntime';

/**
 * 选手的招牌英雄，**按版本统计**。
 *
 * ## 为什么非要带着版本
 *
 * 「擅长英雄」是跟版本走的：7.41 强势的是这几只，7.40 是那几只，跨版本平均出来的名单
 * 既不是他现在的水平，也不是他上个版本的——一个数字都不代表。所以这里的口径是
 * **当前版本内的比赛**，界面上的标签也是这么写的；样本不够才回退，而且回退之后标签跟着改
 * （和 `stratzTeamForm.ts` 那边对窗口的处理是同一条规矩：把窗口写进数据里，不假装还是窄窗口）。
 *
 * ## 数据从哪来
 *
 * STRATZ 的 `player.matches`。**它只给正式比赛**（`PRACTICE` + `CAPTAINS_MODE`），
 * 天梯对局不对外开放——显式要 `lobbyTypeIds: [7]` 会返回 0 场。所以样本比 dota2protracker
 * 那种「职业选手近 8 天天梯 + 官方赛」的做法薄，一位现役选手一个版本大约 20–50 场。
 *
 * 也因此**窗口不能只看本版本**：版本刚开两周、或者这支队这几周没打官方赛（实测 Team Liquid
 * 的选手最后一场官方赛是 8 月 22 日、Team Spirit 是 8 月 23 日），只看本版本就一个人都列不出来。
 * 回退到 90 天并如实标注，比空着或假装是本版本的数据都强。
 *
 * ## 为什么不用 `heroesPerformance`
 *
 * 那个字段只有 `take` 一个参数（问过 schema），**没有时间维度**，拿到的是职业生涯累计——
 * 正是这个功能要避开的东西。
 */

/** 一次取多少场。STRATZ 的 `take` 上限是 100（见 docs/player-profile.md）。 */
const POOL_TAKE = 100;
/** 回退窗口：本版本样本不够时看这么久的比赛。 */
const FALLBACK_WINDOW_DAYS = 90;
const CACHE_FILE = path.join(process.cwd(), '.cache', 'stratz', 'player-heroes.json');
/** 对局数据一直在涨，缓存给 6 小时；站点每 30 分钟重建，绝大多数轮次命中缓存。 */
const TTL_SECONDS = 6 * 3600;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/** 缓存格式版本。**给 `PlayerHeroPool` 加字段就要加一**（理由见 `roomList.ts` 那段）。 */
const CACHE_VERSION = 1;

const POOL_DOCUMENT = `query PlayerHeroPool($id: Long!, $from: Long!) {
	player(steamAccountId: $id) {
		matches(request: { startDateTime: $from, take: ${POOL_TAKE}, playerList: SINGLE }) {
			startDateTime
			didRadiantWin
			players {
				steamAccountId
				isRadiant
				heroId
			}
		}
	}
}`;

interface RawPoolPlayer {
	steamAccountId?: number | null;
	isRadiant?: boolean | null;
	heroId?: number | null;
}

interface RawPoolMatch {
	startDateTime?: number | null;
	didRadiantWin?: boolean | null;
	players?: RawPoolPlayer[] | null;
}

interface PoolCacheEntry {
	v?: number;
	at: number;
	pool?: PlayerHeroPool;
}

type PoolCache = Record<string, PoolCacheEntry>;

async function readPoolCache(): Promise<PoolCache> {
	const hit = await readCacheJson<PoolCache>(CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit) return {};
	return Object.fromEntries(Object.entries(hit.value).filter(([, entry]) => entry?.v === CACHE_VERSION));
}

function writePoolCache(cache: PoolCache): Promise<void> {
	return writeCacheFile(CACHE_FILE, JSON.stringify(cache));
}

/**
 * 当前版本：官方更新日志里最新的那一条。
 *
 * 拿不到就是**空版本 + 0 起点**——那不表示"版本从 1970 年开始"，而是"这一轮没有版本信息"：
 * 取数只取回退窗口，统计口径标成跨版本（`summarizeHeroPool` 里那条判据），页面上于是写
 * 「近 90 天」，而不是拼出一个空的「 版本」。
 */
async function currentPatch(): Promise<{ version: string; startTime: number }> {
	const updates = await fetchPatchUpdates().catch(() => []);
	const latest = updates[0];
	const startTime = latest ? Math.floor(Date.parse(`${latest.date}T00:00:00Z`) / 1000) : Number.NaN;
	return { version: latest?.version ?? '', startTime: Number.isFinite(startTime) ? startTime : 0 };
}

/** 把一场比赛的原始结构压成「这位选手的那一行」。 */
function toRow(match: RawPoolMatch, accountId: number): PlayerMatchRow | null {
	const startTime = Number(match.startDateTime) || 0;
	const me = match.players?.find((player) => player?.steamAccountId === accountId);
	if (!startTime || typeof me?.heroId !== 'number') return null;
	return { heroId: me.heroId, startTime, win: Boolean(me.isRadiant) === Boolean(match.didRadiantWin) };
}

/**
 * 一批选手的招牌英雄，键是账号 id。
 *
 * 一位选手一个请求（STRATZ 没有按名字批量查选手的字段，`players()` 一次又只让带 5 个），
 * 所以这里靠缓存把成本压下来：一轮构建里真正联网的只有缓存过期的那几位。
 * 单个选手失败只跳过他自己——一个账号查不到不该让整页没有招牌英雄。
 */
export async function loadPlayerHeroPools(accountIds: number[]): Promise<Map<number, PlayerHeroPool>> {
	const wanted = [...new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0))];
	const out = new Map<number, PlayerHeroPool>();
	if (wanted.length === 0) return out;
	if (!stratzRuntimeConfigured()) {
		await reportSource('player-heroes', '选手招牌英雄', 'empty', '没有配置 STRATZ token 或中转，这一块不展示');
		return out;
	}

	const patch = await currentPatch();
	const nowSec = Math.floor(Date.now() / 1000);
	/*
	 * 一次取够：既覆盖本版本，也覆盖回退窗口。版本比窗口还老时按版本起点取。
	 *
	 * 没有版本信息时（`patch.startTime` 是 0）只取窗口——照 `Math.min` 一路取下去会取到
	 * 1970 年，而那种情况本来就会被标成「近 90 天」（见 `summarizeHeroPool`），
	 * 取多了只是白拿一批用不上的对局。
	 */
	const windowStart = nowSec - FALLBACK_WINDOW_DAYS * 24 * 3600;
	const since = patch.startTime > 0 ? Math.min(patch.startTime, windowStart) : windowStart;

	const cache = await readPoolCache();
	const next: PoolCache = {};
	let fetched = 0;
	let failed = 0;

	for (const accountId of wanted) {
		const key = String(accountId);
		const hit = cache[key];
		const carry = (): void => {
			if (!hit) return;
			next[key] = hit;
			if (hit.pool) out.set(accountId, hit.pool);
		};

		if (hit && Date.now() - hit.at < TTL_SECONDS * 1000) {
			carry();
			continue;
		}
		if (OFFLINE) {
			carry();
			continue;
		}

		try {
			const data = await stratzGql<{ player: { matches?: RawPoolMatch[] | null } | null }>(POOL_DOCUMENT, {
				id: accountId,
				from: since,
			});
			fetched += 1;
			const rows = (data.player?.matches ?? [])
				.map((match) => toRow(match, accountId))
				.filter((row): row is PlayerMatchRow => row !== null);
			const pool = summarizeHeroPool(rows, { patchStart: patch.startTime, version: patch.version });
			next[key] = { v: CACHE_VERSION, at: Date.now(), pool };
			if (pool) out.set(accountId, pool);
		} catch {
			// 上游抖动：这一位退旧缓存，没有就这轮空着；不写缓存，下一轮重试。
			failed += 1;
			carry();
		}
	}

	await writePoolCache(next);
	const suffix = failed > 0 ? `，${failed} 位这轮没取到` : '';
	await reportSource(
		'player-heroes',
		'选手招牌英雄',
		sourceState(fetched > 0, out.size),
		`${out.size} / ${wanted.length} 位选手，口径 ${patch.version || '未知版本'}${suffix}`,
	);
	return out;
}
