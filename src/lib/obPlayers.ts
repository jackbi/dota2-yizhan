import path from 'node:path';
import { readCacheJson, writeCacheFile } from './buildCache';
import { reportSource } from './dataHealth';
import { rankInfo } from './dotaLabels';
import type { PlayerHeroPool } from './heroPool';
import { loadPlayerHeroPools } from './playerHeroes';
import { loadPlayerProfile } from './stratzPlayer';
import { stratzRuntimeConfigured } from './stratzRuntime';
import type { ObMember } from '../data/types';

/**
 * OB 成员的天梯与英雄池。
 *
 * 三个来源，各管一段，缺哪一段都只是少显示一块：
 *
 * 1. **账号 id 来自 Liquipedia 选手页的 `|playerid=`**（写死在 `data/ob.ts`，与战队页同一套解析）。
 *    不靠昵称搜：同一个昵称能搜出好几个近期活跃的账号，猜错就是把别人的战绩挂在他头上。
 * 2. **段位来自 STRATZ 的 `steamAccount.seasonRank`**，用站内 `dotaLabels.rankInfo` 翻译成
 *    「冠绝 / 超凡 4 星 / 未定级」。**Valve 不公开 MMR 数字**，所以这里不写分数——
 *    要写只能编，而编一个分数摆在「石佛」头上比空着更糟。
 * 3. **英雄池复用战队页那条线**（`loadPlayerHeroPools`，按版本统计、样本不够退到 90 天，
 *    口径如实标）。同一个人在这里和战队页上不会出现两套数字。
 *
 * 两种情况注定是空的，卡片上照实说，不拿别人的数据顶：
 * - **账号匿名**（LongDD、ZippO）：公开接口拿不到对局；
 * - **长期没打天梯**（Mu 最后一场是 2024 年 10 月）：窗口里没有对局，英雄池为空。
 */

export interface ObPlayerStat {
	accountId: number;
	/** 账号在游戏里的昵称。它常常和页面上的名字差很远（YYF 的账号叫「只打3」），所以要写出来给人核对。 */
	persona: string;
	/** 段位文案，例如「冠绝」「超凡 4 星」「未定级」。 */
	rankLabel: string;
	/** 是不是未定级（`seasonRank` 为 0/空）。 */
	unranked: boolean;
	matchCount: number;
	/** 最近一场的时间（Unix 秒）；没有公开记录时为 null。 */
	lastMatchDate: number | null;
	/** 按版本统计的英雄池；拿不到时为 null。 */
	pool: PlayerHeroPool | null;
}

const CACHE_FILE = path.join(process.cwd(), '.cache', 'stratz', 'ob-players.json');
/**
 * 缓存 24 小时。
 *
 * 这一条是**按额度定的**：`loadPlayerProfile` 走的是 `ssrCache`（内存缓存、10 分钟），
 * 那是给运行时按需渲染用的；OB 页是**构建期预渲染**的静态页，不落磁盘就等于每次重建
 * 都要为这 10 个人各发一次请求。段位与累计场次本来就是按天看的东西，缓存一天足够。
 */
const TTL_SECONDS = 24 * 3600;
/** 缓存形状变了要加一（和攻略、名单那几处同一个规矩）。 */
const CACHE_VERSION = 1;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/** 缓存里存的是**上游给的那几个原始字段**，派生字段（段位文案）每次都现算，避免两套口径。 */
interface CachedProfile {
	persona: string;
	seasonRank: number | null;
	matchCount: number;
	lastMatchDate: number | null;
}

interface ObPlayersCache {
	v?: number;
	at: number;
	players: Record<string, CachedProfile>;
}

async function readProfiles(): Promise<{ cache: ObPlayersCache | null; fresh: boolean }> {
	const hit = await readCacheJson<ObPlayersCache>(CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit || hit.value.v !== CACHE_VERSION) return { cache: null, fresh: false };
	const age = Date.now() - Number(hit.value.at ?? 0);
	// 离线构建照用（哪怕过期）：那时本来也取不到新的，有旧数据比空着强。
	return { cache: hit.value, fresh: age < TTL_SECONDS * 1000 || OFFLINE };
}

/**
 * 取所有带账号的成员。**一个失败不影响别人**：拿不到的那位这里直接不给条目，
 * 页面按「这个账号没有可用的公开对局」处理——与战队页对名单的态度一致。
 */
export async function loadObPlayerStats(members: readonly ObMember[]): Promise<Map<string, ObPlayerStat>> {
	const result = new Map<string, ObPlayerStat>();
	const withAccount = members.filter((member) => typeof member.accountId === 'number' && member.accountId > 0);
	if (withAccount.length === 0) return result;
	if (!stratzRuntimeConfigured()) {
		// 没配 STRATZ 时整块不出：这一块是附加信息，不该让 OB 页出事。
		return result;
	}

	const accountIds = withAccount.map((member) => member.accountId!);
	// 英雄池一次批量取（内部有 24 小时缓存），概览按人取（也各带缓存）。
	const pools = await loadPlayerHeroPools(accountIds).catch(() => new Map<number, PlayerHeroPool>());

	const { cache, fresh } = await readProfiles();
	const profiles: Record<string, CachedProfile> = fresh ? { ...(cache?.players ?? {}) } : {};
	let fetched = 0;
	await Promise.all(
		withAccount.map(async (member) => {
			const accountId = member.accountId!;
			const known = profiles[String(accountId)];
			if (known) return;
			try {
				const profile = await loadPlayerProfile(accountId, 1);
				if (!profile) return;
				fetched += 1;
				profiles[String(accountId)] = {
					persona: profile.name?.trim() ?? '',
					seasonRank: profile.seasonRank,
					matchCount: profile.matchCount,
					lastMatchDate: profile.lastMatchDate,
				};
			} catch {
				// 这一个查不到就跳过：OB 页的主体是这些人本身，不该被一次上游抖动带崩。
			}
		}),
	);

	if (fetched > 0) {
		// 写盘失败不影响这一轮渲染（`writeCacheFile` 自己吞异常）。
		await writeCacheFile(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, at: Date.now(), players: profiles } satisfies ObPlayersCache));
	}

	for (const member of withAccount) {
		const profile = profiles[String(member.accountId)];
		if (!profile) continue;
		const info = rankInfo(profile.seasonRank);
		result.set(member.id, {
			accountId: member.accountId!,
			persona: profile.persona,
			rankLabel: info.label,
			unranked: !profile.seasonRank || profile.seasonRank <= 0,
			matchCount: profile.matchCount,
			lastMatchDate: profile.lastMatchDate,
			pool: pools.get(member.accountId!) ?? null,
		});
	}

	await reportSource(
		'ob-players',
		'OB 成员的段位与英雄池',
		result.size === 0 ? 'empty' : fetched > 0 ? 'fresh' : 'cache',
		`${result.size} / ${members.length} 位有数据；英雄池 ${[...result.values()].filter((stat) => stat.pool).length} 位可用`,
	);
	return result;
}
