import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PlayerMatchRow } from '../src/lib/heroPool.ts';
import { summarizeHeroPool } from '../src/lib/heroPool.ts';
import { batchStopReason, collectHeroPools } from '../src/lib/heroPoolBatch.ts';

/**
 * 「选手招牌英雄」的挑选规则。
 *
 * 这块最容易悄悄错的是**版本口径**：本版本样本不够时要回退到更长的窗口，而回退之后
 * 必须如实标成跨版本——标错了页面上照样显示得好好的，只是那个名单其实不是本版本的。
 * 第二条是英雄门槛：只打过一场的英雄上榜就是噪音，而这个错读者是能感觉到的（"这也算擅长？"）。
 * 第三条是「没有版本信息」那一档——它同样只表现为页面上多一个「 版本」的空标签。
 * 最后钉一下页面接线：战队页只该本地化它真正要画的那几个图标（多取会把整套图标拷进 `dist/`）。
 *
 * 后半段是**取数策略**：谁能不问（TTL 之内）、谁失败不该牵连别人、什么时候整批停下。
 * 这条流一位选手一个请求，额度是全站共用的——停下来晚一个账号，就是多花一次（还要算重试）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/playerHeroes.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const PATCH_START = 1_000_000;
const OPTIONS = { patchStart: PATCH_START, version: '7.41f' };

/** 造几场「这位选手用某英雄、结果某」的比赛。`beforePatch` 决定它算不算本版本。 */
function games(heroId: number, count: number, wins: number, beforePatch = false): PlayerMatchRow[] {
	return Array.from({ length: count }, (_, index) => ({
		heroId,
		win: index < wins,
		startTime: (beforePatch ? PATCH_START - 100 : PATCH_START + 100) + index,
	}));
}

// 1. 本版本样本够（≥5 场，且能凑出 ≥5 个英雄）就用本版本，且不掺版本之前的场次
{
	const pool = summarizeHeroPool(
		[
			...games(1, 3, 2),
			...games(2, 2, 2),
			...games(3, 1, 0),
			// 门槛是"能凑出几个英雄"，所以本版本要有足够多打满两场的英雄才走这条路。
			...games(4, 2, 2),
			...games(5, 2, 1),
			...games(6, 2, 1),
			...games(7, 2, 0),
			// 上一个版本打了 5 场同一个英雄——回退时它会是第一名，本版本够用就不该出现
			...games(9, 5, 5, true),
		],
		OPTIONS,
	);
	assert.ok(pool, '本版本样本够，应当有结果');
	assert.equal(pool.scope, 'patch', '样本全在本版本内，口径就是 patch');
	assert.equal(pool.version, '7.41f');
	assert.equal(pool.games, 14, '只统计本版本的 14 场');
	assert.deepEqual(
		pool.heroes.map((h) => [h.heroId, h.games, h.wins]),
		[
			[1, 3, 2],
			[2, 2, 2],
			[4, 2, 2],
			[5, 2, 1],
			[6, 2, 1],
			[7, 2, 0],
		],
		'场次多的在前；只打一场的英雄（3）不进榜；上版本的英雄（9）在这条路上不出现',
	);
	assert.equal(pool.since, PATCH_START + 100, '窗口起点是选中样本的第一场');
	ok('本版本够用：只用本版本、只留打满门槛的英雄');
}

// 2. 本版本不够（<5 场）才回退，而且必须标成跨版本
{
	const pool = summarizeHeroPool([...games(1, 2, 1), ...games(2, 4, 2, true), ...games(3, 3, 3, true)], OPTIONS);
	assert.ok(pool);
	assert.equal(pool.scope, 'window', '回退之后样本里有版本之前的场次，口径必须写 window');
	assert.equal(pool.games, 9, '回退时统计整个窗口');
	assert.equal(pool.heroes[0]?.heroId, 2, '回退后按整个窗口排，场次最多的那个在前');
	assert.equal(pool.since, PATCH_START - 100, '窗口起点跟着回退');
	ok('本版本不够：回退整个窗口，并把口径改成跨版本');
}

// 3. 门槛：一个英雄只打过一场就不算「擅长」；全都只打过一场时宁可不给结果
/*
 * 2b. **本版本场次够、但英雄凑不满**时要退到窗口。
 *
 * 这条是被一个真实的界面误读逼出来的：Ame 的池子在页面上只剩一个英雄，看起来像
 * "这位职业选手只会一个英雄"。原因是判据只看场次——6 场打 6 个英雄也算"样本够"，
 * 于是本版本那条路上一个达标的英雄都没有。现在再加一条"至少凑出 5 个英雄"，
 * 凑不满就退到 90 天，并**照实标成「近 90 天」**（口径宽一点没关系，别摆个空池子）。
 */
{
	const pool = summarizeHeroPool(
		[
			...games(1, 3, 2),
			...games(2, 2, 1),
			// 本版本 6 场，但只有上面两个英雄打满两场——凑不出 5 个
			...games(3, 1, 0),
			// 窗口里的老样本这时要顶上来
			...games(9, 6, 4, true),
			...games(10, 5, 3, true),
		],
		OPTIONS,
	);
	assert.ok(pool);
	assert.equal(pool.scope, 'window', '本版本凑不出池子时要退到窗口，并把口径标成 window');
	assert.equal(pool.games, 17, '退到窗口就统计整个窗口的场次');
	assert.equal(pool.heroes[0]?.heroId, 9, '退到窗口后按整个窗口排，场次最多的在前');
	ok('本版本场次够但英雄凑不满：退到窗口，标签跟着改成「近 90 天」');
}

{
	const oneEach = summarizeHeroPool([1, 2, 3, 4, 5, 6].map((heroId) => ({ heroId, win: true, startTime: PATCH_START + heroId })), OPTIONS);
	assert.equal(oneEach, null, '每个英雄都只打一场，等于没有招牌英雄，返回 null 而不是硬凑一组');

	const withTwo = summarizeHeroPool([...games(7, 2, 1), ...games(8, 1, 1), ...games(9, 1, 0), ...games(10, 1, 0)], OPTIONS);
	assert.deepEqual(
		withTwo?.heroes.map((h) => h.heroId),
		[7],
		'只留打满两场的那个，其余单场的丢掉',
	);
	ok('英雄门槛：至少两场才算擅长');
}

// 4. 没有对局就没有结论（新版本刚开、或者这支队这几周没打官方赛）
{
	assert.equal(summarizeHeroPool([], OPTIONS), null);
	ok('一场都没有：返回 null，页面不显示这一块');
}

// 5. 没有版本信息（更新日志那一源没取到）时，不能装作是本版本
{
	const pool = summarizeHeroPool([...games(1, 3, 2), ...games(2, 3, 1)], { patchStart: 0, version: '' });
	assert.ok(pool);
	assert.equal(pool.scope, 'window', '`patchStart` 为 0 是"没有版本信息"，不是"版本从 1970 年开始"');
	assert.equal(pool.games, 6, '没有版本边界时样本全算窗口');
	// 页面上「7.41f 版本」/「近 90 天」这两个标签是照 `scope` 写的：
	// 标成 patch 而版本号是空串，渲染出来就是「 版本」。
	ok('没有版本信息：口径标成跨版本，标签才写得准');
}

// 6. 接线：`/teams/<队>` 只本地化这一页真要画的图标
{
	const page = readFileSync(new URL('../src/pages/teams/[id].astro', import.meta.url), 'utf8');
	assert.doesNotMatch(
		page,
		/heroes:\s*\[\.\.\.heroById\.values\(\)\]/,
		'不能把整份英雄列表交给 localizePatchIcons：那会把 127 张图标全量拉回来、并拷进 dist',
	);
	assert.match(page, /localizePatchIcons\(\{[^}]*poolHeroes/s, '图标要按名单里实际出现的英雄取');
	assert.match(page, /poolHeroes\.length > 0/, '守卫要看"这一页有没有英雄"，不是"英雄列表拿没拿到"');
	// 图标 key 必须来自名字表：127 个英雄里 5 个的图片文件名不是 `npc_dota_hero_<key>.png`
	// （凯/瑪西/獸 是 UUID、琼英碧灵是 muerta_hphover），从文件名反推的那 4 个永远是破图。
	assert.doesNotMatch(page, /hero\.img\.split/, '不能从英雄列表的图片文件名反推图标 key');
	assert.match(page, /fetchPatchNames\(\)/, '图标 key 与英雄名都取自更新日志那条线的名字表');
	ok('接线：战队页只取本页用到的英雄图标');
}

/*
 * ---- 取数策略（`heroPoolBatch.ts`）--------------------------------------------------
 *
 * 这三条对应构建汇总里能看到的三种结果：命中缓存、某一位没取到、整批停下。
 * 用假的 `loadRows` 驱动，不碰网络。
 */

/** 一个能直接放进缓存的样本结论。 */
const SAMPLE_POOL = summarizeHeroPool(games(7, 5, 3), OPTIONS);
assert.ok(SAMPLE_POOL, '样本本身要能算出结论，否则下面几组断言失去意义');
const DAY = 24 * 3600 * 1000;

// 7. TTL 之内命中缓存：一次请求都不发
{
	const asked: number[] = [];
	const result = await collectHeroPools({
		accountIds: [11, 12],
		cache: {
			'11': { v: 1, at: DAY - 1000, pool: SAMPLE_POOL },
			'12': { v: 1, at: DAY - 1000, pool: SAMPLE_POOL },
		},
		ttlMs: DAY,
		now: DAY,
		offline: false,
		patch: OPTIONS,
		stopReason: () => '不该走到这里',
		loadRows: async (accountId) => {
			asked.push(accountId);
			return games(1, 5, 1);
		},
	});
	assert.deepEqual(asked, [], 'TTL 之内就该直接用缓存，一分额度都不花');
	assert.equal(result.fetched, 0);
	assert.equal(result.pools.size, 2);
	ok('新鲜缓存：不问上游');
}

// 8. 单个选手失败不算整批的错：剩下的人照问，失败的那位不写缓存
{
	const asked: number[] = [];
	const result = await collectHeroPools({
		accountIds: [21, 22, 23],
		cache: {},
		ttlMs: DAY,
		now: DAY,
		offline: false,
		patch: OPTIONS,
		stopReason: () => null,
		loadRows: async (accountId) => {
			asked.push(accountId);
			if (accountId === 22) throw new Error('这个账号查不到');
			return games(1, 6, 2);
		},
	});
	assert.deepEqual(asked, [21, 22, 23], '一位失败不该让后面的人不问了');
	assert.equal(result.failed, 1);
	assert.equal(result.skipped, 0);
	assert.equal(result.stoppedBy, undefined);
	assert.equal(result.pools.size, 2);
	assert.deepEqual(Object.keys(result.cache), ['21', '23'], '失败的那位不写缓存，下一轮重试');
	ok('单个失败：只跳过他自己');
}

// 9. 撞到额度限制就整批停下：剩下的退旧缓存、一次都不问
{
	const asked: number[] = [];
	const stale = { v: 1, at: 0, pool: SAMPLE_POOL };
	const result = await collectHeroPools({
		accountIds: [31, 32, 33, 34],
		cache: { '31': stale, '32': stale, '33': stale, '34': stale },
		ttlMs: DAY,
		now: DAY,
		offline: false,
		patch: OPTIONS,
		stopReason: batchStopReason,
		loadRows: async (accountId) => {
			asked.push(accountId);
			if (accountId === 32) throw { systemic: true, rateLimited: true, message: 'STRATZ 请求失败：HTTP 429' };
			return games(1, 6, 2);
		},
	});
	assert.deepEqual(asked, [31, 32], '第二个撞到 429 之后，剩下两个不该再问——那只会把额度打得更空');
	assert.equal(result.skipped, 2);
	assert.equal(result.stoppedBy, 'STRATZ 额度或频率限制（429）');
	assert.equal(result.pools.size, 4, '没问的人退旧缓存，页面上仍然有东西看');
	assert.deepEqual(Object.keys(result.cache).sort(), ['31', '32', '33', '34'], '旧缓存要带过去，不能因为停下就丢');
	ok('额度限制：整批停下，剩下的只退旧缓存');
}

// 10. 请求级的错不该牵连别人：GraphQL 报错只算这一位失败，后面继续问
{
	const asked: number[] = [];
	const result = await collectHeroPools({
		accountIds: [41, 42, 43],
		cache: {},
		ttlMs: DAY,
		now: DAY,
		offline: false,
		patch: OPTIONS,
		stopReason: batchStopReason,
		loadRows: async (accountId) => {
			asked.push(accountId);
			if (accountId === 42) throw { systemic: false, message: 'GraphQL 报错：invalid steamAccountId' };
			return games(1, 6, 2);
		},
	});
	assert.deepEqual(asked, [41, 42, 43], '一位的参数不对，不能让剩下的人这一轮全不刷新');
	assert.equal(result.failed, 1);
	assert.equal(result.skipped, 0);
	assert.equal(result.stoppedBy, undefined);
	ok('请求级错误：只跳过这一位');
}

// 11. 分级判据本身：认 `systemic` 标记，认不出就当"不停"
{
	assert.equal(
		batchStopReason({ systemic: true, rateLimited: true, message: 'HTTP 429' }),
		'STRATZ 额度或频率限制（429）',
		'额度限制要单独说清楚，运维才知道去看哪一头',
	);
	assert.equal(batchStopReason({ systemic: true, message: 'STRATZ 拒绝了这个出口 IP' }), 'STRATZ 拒绝了这个出口 IP');
	assert.equal(batchStopReason({ systemic: false, message: 'GraphQL 报错' }), null, '请求级的错不停批');
	assert.equal(batchStopReason(new Error('别的错')), null, '认不出来的错按"这一位失败"处理，不牵连整批');
	assert.equal(batchStopReason(undefined), null);
	ok('分级：只有整批级的错才停');
}

// 12. 接线：TTL 是「按额度定的」那一档，429 要能被认出来
{
	const flow = readFileSync(new URL('../src/lib/playerHeroes.ts', import.meta.url), 'utf8');
	const runtime = readFileSync(new URL('../src/lib/stratzRuntime.ts', import.meta.url), 'utf8');
	assert.match(
		flow,
		/TTL_SECONDS\s*=\s*24 \* 3600/,
		'招牌英雄的 TTL 取 24 小时：一位选手一个请求，缩短 TTL 等于把名单人数乘上刷新次数',
	);
	assert.match(flow, /stopReason: batchStopReason/, '熔断判据要接线，不能只写在注释里');
	assert.match(runtime, /lastRateLimited = res\.status === 429;/, '429 必须标成额度限制，否则熔断认不出来');
	assert.match(runtime, /systemic: false/, 'GraphQL 报错要标成非整批级，否则会误停整批');
	assert.match(runtime, /\{ rateLimited: lastRateLimited \}/, '按**最后一次**尝试分类，别把前一次的 429 带进结论');
	ok('接线：TTL 与 429 标记都还在');
}

console.log(`playerHeroes 全部断言通过（${cases} 组）`);
