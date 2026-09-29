import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OFFLINE_STALE_MAX_MS, STALE_MAX_MS, readCachedStatus, usableStale } from '../src/lib/liveApi.ts';

/**
 * `src/lib/liveApi.ts` 旧缓存兜底那一段的自检（只碰文件，不联网）。
 *
 * 这段的行为曾经连着错两次，而且两次都**不会报错**：先是见到缓存文件就用（几天前的「直播中」
 * 照样画绿点），改出年龄上限之后又被 `waitForPeerCache` 用宽门槛绕过（2 小时那档把上一轮
 * 构建的旧文件当成"同伴刚写的"，顺带跳过"这是旧快照"的提示）。所以这里把两档门槛与提示文案
 * 都喂真文件验一遍，不再只靠源码里的字面量断言。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/liveApi.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const HOUR = 3600_000;
const live: import('../src/data/types.ts').LiveStatus = { state: 'live', ownerUnrecognized: false, fetchedAt: 'x' };

// 1. 两档门槛：网络兜底只兜短暂故障，离线构建要真的用起缓存
{
	assert.ok(OFFLINE_STALE_MAX_MS > STALE_MAX_MS, '离线那档必须比网络兜底宽：否则"只用 .cache 构建"等于没用上');
	assert.ok(STALE_MAX_MS > 5 * 60_000, '网络兜底的门槛要比 TTL 宽，否则它永远兜不住任何东西');

	assert.ok(usableStale({ status: live, ageMs: 10 * 60_000 }, STALE_MAX_MS), '10 分钟前的快照要能顶用');
	assert.equal(
		usableStale({ status: live, ageMs: 3 * HOUR }, STALE_MAX_MS),
		null,
		'3 小时前的快照不该拿来当"直播中"：上游挂着时它只会更旧',
	);
	assert.ok(
		usableStale({ status: live, ageMs: 3 * HOUR }, OFFLINE_STALE_MAX_MS),
		'同一份缓存在离线构建里应当能用（离线构建的承诺就是用缓存）',
	);
	assert.equal(usableStale(null, OFFLINE_STALE_MAX_MS), null, '没有缓存就是没有');
	ok('两档门槛：网络 2 小时、离线 7 天');
}

// 2. 顶用时要说出它有多旧，而且不能把原有的说明吃掉
{
	const fresh = usableStale({ status: live, ageMs: 10 * 60_000 }, STALE_MAX_MS);
	assert.match(String(fresh?.note), /10 分钟前/, `提示要写清快照有多旧，实际：${fresh?.note}`);
	assert.match(String(fresh?.note), /本次没取到开播状态/, '要说清这是兜底来的，不是刚抓的');

	const closed = { ...live, state: 'closed' as const, note: '斗鱼已关闭该房间的播放' };
	const merged = usableStale({ status: closed, ageMs: 2 * HOUR }, STALE_MAX_MS);
	assert.match(String(merged?.note), /斗鱼已关闭该房间的播放/, '原有的说明要留着');
	assert.match(String(merged?.note), /2 小时前/, '新旧两条要接在一起，不是互相覆盖');
	ok('提示：说出有多旧，且不吃掉原有说明');
}

// 3. 真文件：能读出年龄；坏 JSON 与不存在的文件都当没有缓存
{
	const dir = mkdtempSync(path.join(tmpdir(), 'live-cache-'));
	const file = path.join(dir, 'douyu-1.json');
	writeFileSync(file, JSON.stringify(live));
	const threeHoursAgo = new Date(Date.now() - 3 * HOUR);
	utimesSync(file, threeHoursAgo, threeHoursAgo);

	const hit = await readCachedStatus(file);
	assert.equal(hit?.status.state, 'live');
	assert.ok(hit && Math.abs(hit.ageMs - 3 * HOUR) < 60_000, `年龄要按文件时间算，实际 ${hit?.ageMs}`);
	assert.equal(usableStale(hit, STALE_MAX_MS), null, '3 小时前的那份在网络兜底里不该顶用');
	assert.ok(usableStale(hit, OFFLINE_STALE_MAX_MS), '离线构建里同一份能用');

	const broken = path.join(dir, 'broken.json');
	writeFileSync(broken, '{"state":');
	assert.equal(await readCachedStatus(broken), null, '半截 JSON 当没有缓存，不能让整轮构建挂在这里');
	assert.equal(await readCachedStatus(path.join(dir, 'nope.json')), null, '文件不存在也一样');
	ok('真文件：按 mtime 算年龄，坏文件与缺失都当没有');
}

console.log(`liveApi 全部断言通过（${cases} 组）`);
