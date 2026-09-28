import assert from 'node:assert/strict';
import { seedEvents } from '../src/data/tournaments.ts';

/**
 * `src/data/tournaments.ts` 兜底数据的自检。
 *
 * 这是一条**只在所有数据源都挂掉时才走到**的路：赛事页平时用不上它，所以它错了也发现不了——
 * 等到真用上的那天（上游集体抽风那次），页面才把错误展示给读者。这就是"只在极端情况下执行的
 * 代码"必须自检的理由。
 *
 * 三条口径都来自这个文件的注释与 `docs/`：
 *
 * 1. 日期按**东八区**解析（写成 `2026-10-12` 指的是北京时间那天零点）；
 * 2. 兜底数据**不编造对阵与比分**，所以 `matches` / `teams` 必须是空数组；
 * 3. 状态由时间算出来：开赛当天算进行中，结束后还会多留一天（跨时区打完的最后一场）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/tournamentsSeed.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const events = seedEvents();

// 1. 形状：能渲染、id 唯一、时间有效、不编造对阵
{
	assert.ok(events.length > 0, '兜底数据不能是空的：那样赛事页就真的一片空白了');
	assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'id 要唯一（Astro 的 key 与页面路由都用它）');
	for (const event of events) {
		assert.ok(event.id.startsWith('seed-'), `${event.id} 要有 seed- 前缀，免得跟真实抓来的赛事撞上`);
		assert.equal(event.source, 'seed');
		assert.ok(event.name.trim().length > 0, '赛事名不能是空的');
		assert.ok(Number.isFinite(event.startTime) && event.startTime > 0, `${event.name} 的开赛时间无效`);
		assert.ok(event.endTime > event.startTime, `${event.name} 的结束时间要晚于开赛时间`);
		assert.deepEqual(event.matches, [], `${event.name} 不该编造对阵`);
		assert.deepEqual(event.teams, [], `${event.name} 不该编造参赛队伍`);
		assert.ok(['upcoming', 'live', 'completed'].includes(event.status), `${event.name} 的状态是 ${event.status}`);
	}
	ok('兜底赛事：形状与"不编造对阵"');
}

// 2. 日期按东八区解析：北京时间零点在 UTC 是前一天 16:00
{
	const zones = new Set(events.map((e) => new Date(e.startTime * 1000).getUTCHours()));
	assert.deepEqual([...zones], [16], '写日期指的是北京时间零点，不是 UTC 零点——差 8 小时会让"今天是哪天"整个错位');
	ok('日期按东八区解析');
}

// 3. 状态按时间算：开赛当天算进行中，结束后多留一天
{
	// 边界值全部由这个赛事自己的时间算出来，所以改赛程数据不必改这里。
	const event = events[0];
	assert.ok(event);
	const at = (seconds: number): string => seedEvents(seconds * 1000).find((e) => e.id === event.id)?.status ?? 'missing';

	assert.equal(at(event.startTime - 1), 'upcoming');
	assert.equal(at(event.startTime), 'live', '开赛那一秒就是进行中');
	assert.equal(at(event.startTime + 3600), 'live');
	assert.equal(at(event.endTime), 'live');
	assert.equal(at(event.endTime + 86_400), 'live', '结束之后还留一天：最后一场常常按别的时区算到今天');
	assert.equal(at(event.endTime + 86_400 + 1), 'completed');
	ok('状态：开赛即进行中，结束后多留一天');
}

// 4. 同一个时刻算出来的状态对每个赛事都成立（不是只有挑出来那个对）
{
	const now = Date.now();
	for (const event of seedEvents(now)) {
		const expected =
			now / 1000 < event.startTime ? 'upcoming' : now / 1000 > event.endTime + 86_400 ? 'completed' : 'live';
		assert.equal(event.status, expected, `${event.name} 在"现在"应当算 ${expected}`);
	}
	ok('每个赛事都按同一条规则算状态');
}

console.log(`tournamentsSeed 全部断言通过（${cases} 组）`);
