import assert from 'node:assert/strict';
import {
	BARRACKS_PER_SIDE,
	GRID_SIZE,
	LANE_PATHS,
	MAP_BUILDINGS,
	PLAYFIELD,
	ROSHAN_PITS,
	TOWERS_PER_SIDE,
	buildingLabel,
	toCanvas,
} from '../src/lib/dotaMap.ts';
import { laneOutcomeLabel } from '../src/lib/dotaLabels.ts';
import { formatElapsed } from '../src/lib/format.ts';
import { buildLeadChart, buildRateChart, formatLead, minuteTicks, niceMaxAbs, plotX, plotY } from '../src/lib/replayChart.ts';
import { barWidth, compact, maxAbs, maxValue, signedBarWidth, signedInt, teamTotals, type ScoreRow } from '../src/lib/scoreboard.ts';
import { ownerOfSlot, summarizeWards, type WardEventRaw, type WardOwner } from '../src/lib/wardStats.ts';

/**
 * 复盘面板与地图回放的自检。
 *
 * 钉的都是「错了不会抛异常、只会安静地展示错东西」的地方：
 *
 * 1. 坐标翻转——漏了 y 翻转整张地图会上下颠倒，但代码照样跑；
 * 2. 建筑表——npcId 与「哪座塔」的对应、以及层数与到基地距离的单调关系。层数是按几何排的，
 *    排错了就会出现「天辉上路一塔」标在了二塔的位置上，读者从地图上看不出来，从文案上看不出来；
 * 3. 曲线几何——空序列、全零序列、单点序列要产出可画但不越界的结果，
 *    否则是一张空白图或者一条冲出画布的线；
 * 4. 标签兜底——上游给个没见过的枚举值时不能显示 undefined；
 * 5. 眼位归属——`fromPlayer` 是 Valve 槽位（夜魇从 128 起）而不是数组下标，按错就会把
 *    天辉的眼记到夜魇头上；「到期」与「被反」也必须分开，否则反眼数会虚高；
 * 6. 对抗明细——合计的口径（GPM / XPM 是相加不是平均）与条形宽度（负数不能当宽度）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/matchReview.check.ts`）。
 */

// ---------------------------------------------------------------- 坐标

// 天辉基地在数据坐标里靠左下（80,86），翻到画布上应该落到底部。
assert.deepEqual(toCanvas(80, 86), [80, GRID_SIZE - 86], 'y 轴要翻：数据向上为 y 正，画布向下为 y 正');
assert.deepEqual(toCanvas(170, 166), [170, GRID_SIZE - 166], '夜魇基地翻过来在上方');
assert.ok(toCanvas(80, 86)[1] > toCanvas(170, 166)[1], '天辉基地要比夜魇基地更靠画布下方');

// ---------------------------------------------------------------- 建筑表

const npcIds = MAP_BUILDINGS.map((building) => building.npcId);
assert.equal(new Set(npcIds).size, npcIds.length, 'npcId 不能重复，否则事件会被挂到两座建筑上');

const towers = MAP_BUILDINGS.filter((building) => building.kind === 'tower');
assert.equal(towers.filter((tower) => tower.side === 0).length, 10, '天辉塔位表里有 10 座（第 11 座是没记到坐标的基地塔）');
assert.equal(towers.filter((tower) => tower.side === 1).length, 10, '夜魇同理');
assert.equal(TOWERS_PER_SIDE, 11, '每方塔的总数来自上游位掩码宽度');
assert.equal(BARRACKS_PER_SIDE, 6, '每方 6 座兵营，同样来自位掩码');

for (const tower of towers) {
	const fort = MAP_BUILDINGS.find((building) => building.side === tower.side && building.kind === 'fort');
	assert.ok(fort, '每方都要有一条基地记录');
	if (tower.lane === null || tower.tier === null) continue;
	// 另存一份：下面的 filter 回调里 TS 不保留外层的收窄结果（回调可能晚跑）。
	const lane = tower.lane;
	const tier = tower.tier;
	const distance = Math.hypot(tower.x - fort.x, tower.y - fort.y);
	// 同侧同路的塔按到基地的距离应当与层数反着走：一塔最远、三塔最近。
	const siblings = towers.filter(
		(other) => other.side === tower.side && other.lane === lane && other.tier !== null && other.tier < tier,
	);
	for (const farther of siblings) {
		const otherDistance = Math.hypot(farther.x - fort.x, farther.y - fort.y);
		assert.ok(otherDistance > distance, `${buildingLabel(tower.npcId)} 应当比 ${buildingLabel(farther.npcId)} 更靠近本方基地`);
	}
	assert.ok(
		tower.x >= PLAYFIELD.x0 && tower.x <= PLAYFIELD.x1 && tower.y >= PLAYFIELD.y0 && tower.y <= PLAYFIELD.y1,
		`${buildingLabel(tower.npcId)} 落在可行走区域之外了`,
	);
}

for (const building of MAP_BUILDINGS) {
	const label = buildingLabel(building.npcId);
	assert.ok(label, '表里的每座建筑都要有中文名');
	assert.ok(label?.includes(building.side === 0 ? '天辉' : '夜魇'), '建筑名要带上阵营，不然「上路一塔」不知道是谁的');
}

// 36 / 37 在推塔事件里出现过，但查不出是什么（从未出现在建筑事件里、同一场能出现 6 次），
// 所以一律不给名字——编一个名字会印出 8 条「夜魇基地塔倒塌」这种一眼假的东西。
assert.equal(buildingLabel(36), null, '认不出的建筑不编名字');
assert.equal(buildingLabel(37), null, '同一个 37 能在一场里出现 6 次，更不该叫基地塔');
assert.equal(buildingLabel(9999), null, '认不出的 npcId 交回调用方兜底，不能编一个名字');
assert.equal(buildingLabel(16), '天辉上路一塔', '中英混排的标签示例');
assert.equal(buildingLabel(28), '夜魇下路一塔', '夜魇下路要沿着右边那条路归位');

// 三路折线都要落在可行走区域里，并经过本方基地——它是画底图用的骨架。
for (const [lane, path] of Object.entries(LANE_PATHS)) {
	assert.ok(path.length >= 4, `${lane} 的折线太短了`);
	for (const [x, y] of path) {
		assert.ok(
			x >= PLAYFIELD.x0 && x <= PLAYFIELD.x1 && y >= PLAYFIELD.y0 && y <= PLAYFIELD.y1,
			`${lane} 的折线点 (${x}, ${y}) 跑到地图外了`,
		);
	}
}
assert.equal(ROSHAN_PITS.length, 2, '7.33 起肉山有两个坑，两个都要画出来');

// ---------------------------------------------------------------- 曲线

assert.equal(niceMaxAbs([]), 1000, '没有数据时纵轴也要有个最小刻度，不要缩到 0');
assert.equal(niceMaxAbs([0, 0, 0]), 1000, '全程零领先不能被放大成剧烈波动');
assert.equal(niceMaxAbs([1200, -900]), 2000, '半幅按「好看的刻度」向上取整');
assert.ok(niceMaxAbs([12345, -300]) >= 12345, '半幅不能小于实际最大值，否则曲线会被裁平');
assert.equal(formatLead(0), '0', '零就写 0');
assert.equal(formatLead(12345), '+12k', '上万时用 k 位');
assert.equal(formatLead(-8300), '-8.3k', '负号保留，一位小数');
assert.equal(formatLead(430), '+430', '千以内按整数写');

assert.deepEqual(minuteTicks(3), [], '分钟数太少就不标刻度，免得挤在一起');
assert.deepEqual(minuteTicks(12, 10), [0, 10, 11], '刻度含首尾');

const box = { width: 100, height: 50, padX: 10, padY: 5 };
assert.equal(plotX(0, 5, box), 10, '第一个点贴左内边');
assert.equal(plotX(4, 5, box), 90, '最后一个点贴右内边');
assert.equal(plotX(0, 1, box), 50, '只有一个点时居中，不要除零');
assert.equal(plotY(0, 100, box), 25, '零值在纵轴中央');
assert.equal(plotY(100, 100, box), 5, '正半幅在上边');
assert.equal(plotY(-100, 100, box), 45, '负半幅在下边');
assert.equal(plotY(999999, 100, box), 5, '超出半幅的值要被裁到边界内，不能画出画布');

const single = buildLeadChart([{ networthLead: 500, experienceLead: -200 }]);
assert.ok(single, '一个点也要能出图');
assert.ok(single?.networth.startsWith('M'), '单点折线仍然是一条合法路径');
assert.equal(single?.networthPositive, '', '单点没有面积可填，交给调用方不画');
assert.equal(single?.finalNetworth, 500, '结束值取最后一个点');

const flat = buildLeadChart([
	{ networthLead: 0, experienceLead: 0 },
	{ networthLead: 0, experienceLead: 0 },
]);
assert.equal(flat?.maxAbs, 1000, '全零序列也用最小半幅');
assert.equal(flat?.zeroY, plotY(0, 1000, flat.box), '零轴与实际零值同高');
assert.ok(!/NaN|Infinity/.test(flat?.networth ?? ''), '路径里不能出现 NaN');
assert.ok(!/NaN|Infinity/.test(flat?.experience ?? ''), '经验曲线同理');

const swing = buildLeadChart([
	{ networthLead: -4000, experienceLead: -2000 },
	{ networthLead: 6000, experienceLead: 3000 },
	{ networthLead: 12000, experienceLead: 8000 },
]);
assert.equal(swing?.finalNetworth, 12000, '结束值取最后一点');
for (const path of [swing?.networth, swing?.experience, swing?.networthPositive, swing?.networthNegative]) {
	for (const coordinate of (path ?? '').match(/-?\d+(\.\d+)?/g) ?? []) {
		const value = Number(coordinate);
		assert.ok(value >= 0 && value <= Math.max(swing?.box.width ?? 0, swing?.box.height ?? 0), `坐标 ${value} 越界`);
	}
}

assert.equal(buildRateChart([{ winRate: null }]), null, '只有一个空值的序列画不出曲线');
const rate = buildRateChart([
	{ winRate: null },
	{ winRate: 0.25 },
	{ winRate: 0.75 },
	{ winRate: 1 },
]);
assert.ok(rate, '有两个以上有效点就能画');
assert.equal(rate?.start, 0.25, '开头的空值不参与，起点取第一个有效值');
assert.equal(rate?.end, 1, '终点取最后一个有效值');
assert.equal(rate?.line.startsWith('M'), true, '胜率曲线是一条开口折线，不闭合');
// 100% 要点在图表顶端、0% 在底端：反过来读的人会得到完全相反的结论。
assert.equal(rate?.levels[0]?.y, rate?.box.padY, '100% 在最上边');
assert.equal(rate?.levels[2]?.y, (rate?.box.padY ?? 0) + (rate?.box.height ?? 0) - (rate?.box.padY ?? 0) * 2, '0% 在最下边');

// ---------------------------------------------------------------- 文案

assert.equal(formatElapsed(0), '0:00', '零秒');
assert.equal(formatElapsed(65), '1:05', '分钟与秒都要补位');
assert.equal(formatElapsed(3900), '1:05:00', '超过一小时带上小时位');
assert.equal(formatElapsed(-30), '0:00', '上游给负数时间时按 0 处理');

assert.equal(laneOutcomeLabel('RADIANT_STOMP'), '天辉碾压', '枚举要有中文');
assert.equal(laneOutcomeLabel('TIE'), '均势', '均势不能写成「天辉小胜」');
assert.equal(laneOutcomeLabel(null), '未记录', '缺值时给个说法');
assert.equal(laneOutcomeLabel('SOMETHING_NEW'), 'SOMETHING_NEW', '没见过的枚举照原样透出，别编');

// ---------------------------------------------------------------- 眼位

const owners: WardOwner[] = [
	{ slot: 0, isRadiant: true, heroId: 85, name: 'A' },
	{ slot: 4, isRadiant: true, heroId: 56, name: 'B' },
	{ slot: 128, isRadiant: false, heroId: 30, name: 'C' },
	{ slot: 131, isRadiant: false, heroId: 21, name: 'D' },
];
const ownerMap = new Map(owners.map((owner) => [owner.slot, owner]));

assert.equal(ownerOfSlot(128, ownerMap)?.side, 1, '128 是夜魇的第一个槽位，不能当成第 128 个选手');
assert.equal(ownerOfSlot(0, ownerMap)?.side, 0, '0–4 是天辉');
assert.equal(ownerOfSlot(999, ownerMap), null, '对不上槽位就不算，别硬塞给人');
assert.equal(ownerOfSlot(null, ownerMap), null, '缺槽位同样不算');

const wardEvents: WardEventRaw[] = [
	// 天辉 A 插了一只假眼，6 分钟后自然到期。
	{ indexId: 1, wardType: 'OBSERVER', action: 'SPAWN', fromPlayer: 0 },
	{ indexId: 1, wardType: 'OBSERVER', action: 'DESPAWN', playerDestroyed: null },
	// 天辉 B 插了一只真眼，被夜魇 C 排掉。
	{ indexId: 2, wardType: 'SENTRY', action: 'SPAWN', fromPlayer: 4 },
	{ indexId: 2, wardType: 'SENTRY', action: 'DESPAWN', playerDestroyed: 128 },
	// 夜魇 C 插了一只假眼，被天辉 A 排掉。
	{ indexId: 3, wardType: 'OBSERVER', action: 'SPAWN', fromPlayer: 128 },
	{ indexId: 3, wardType: 'OBSERVER', action: 'DESPAWN', playerDestroyed: 0 },
	// 只有消失、没有插下记录的眼（开局前插下的）：算不清归属，进 unknown。
	{ indexId: 4, wardType: 'OBSERVER', action: 'DESPAWN', playerDestroyed: 4 },
	// 插眼者槽位对不上任何人。
	{ indexId: 5, wardType: 'SENTRY', action: 'SPAWN', fromPlayer: 77 },
];

const summary = summarizeWards(wardEvents, owners);
assert.ok(summary, '有事件就要出统计');
assert.equal(summary?.sides[0].placed, 2, '天辉插 2 只（假眼 1 + 真眼 1）');
assert.equal(summary?.sides[1].placed, 1, '夜魇插 1 只');
assert.equal(summary?.sides[0].observer, 1, '假眼与真眼分开数');
assert.equal(summary?.sides[1].sentry, 0, '夜魇只插了假眼');
assert.equal(summary?.sides[0].taken, 1, '天辉排掉 1 只');
assert.equal(summary?.sides[0].lost, 1, '天辉被排掉 1 只');
assert.equal(summary?.sides[1].lost, 1, '夜魇被排掉 1 只');
assert.equal(summary?.sides[0].expired, 1, '自然到期要单独一列，不能并进被反');
// 本方眼位的去向（被反 + 到期）不会超过插眼数，差额是打完还没到期的那些。
// `taken` 是本方排掉**对方**的眼，属于另一侧的账，混进这个等式就会得到
// 「反眼越多、插眼越少」的荒唐结论。
assert.ok((summary?.sides[0].lost ?? 0) + (summary?.sides[0].expired ?? 0) <= (summary?.sides[0].placed ?? 0), '本方眼位去向不超过插眼数');
assert.equal((summary?.sides[1].lost ?? 0) + (summary?.sides[1].expired ?? 0), 1, '夜魇插的那只眼被排掉了');
assert.equal(summary?.unknown, 2, '认不出的（只有消失、槽位对不上）都要计入 unknown');

const rows = summary?.rows ?? [];
assert.equal(rows.find((row) => row.name === 'A')?.observer, 1, '插眼归属到人');
assert.equal(rows.find((row) => row.name === 'A')?.taken, 1, '反眼也归属到人');
assert.equal(rows.find((row) => row.name === 'B')?.lost, 1, '被反要记在被排者的账上');
assert.equal(rows.find((row) => row.name === 'C')?.taken, 1, '夜魇的反眼同样归属到人');
assert.equal(summarizeWards([], owners), null, '没有眼位事件时返回 null，页面据此不显示这一块');

// ---------------------------------------------------------------- 对抗明细

const scoreRow = (over: Partial<ScoreRow>): ScoreRow => ({
	kills: 0,
	deaths: 0,
	assists: 0,
	networth: 0,
	gpm: 0,
	xpm: 0,
	lastHits: 0,
	denies: 0,
	heroDamage: 0,
	towerDamage: 0,
	heroHealing: 0,
	imp: 0,
	...over,
});

const radiantRows = [
	scoreRow({ kills: 11, deaths: 1, assists: 9, networth: 39_400, gpm: 887, xpm: 894, lastHits: 674, denies: 22, heroDamage: 37_600, towerDamage: 18_100, imp: -10 }),
	scoreRow({ kills: 9, deaths: 3, assists: 14, networth: 23_600, gpm: 612, xpm: 997, lastHits: 399, denies: 2, heroDamage: 30_000, towerDamage: 463, heroHealing: 320, imp: -17 }),
	// IMP 缺值（未解析完整的行）：合计按 0 算，不能让整行变成 NaN。
	scoreRow({ kills: 2, networth: 9_600, gpm: 267, heroDamage: 5_300, imp: null }),
];

const totals = teamTotals(radiantRows);
assert.equal(totals.kills, 22, '击杀相加');
assert.equal(totals.gpm, 1766, 'GPM 相加 = 全队每分钟的金币；算平均会得到「全队 588」这种比单核还低的假数字');
assert.equal(totals.xpm, 1891, 'XPM 同理');
assert.equal(totals.imp, -27, 'IMP 是加减分，缺值按 0 计');
assert.equal(totals.heroDamage, 72_900, '伤害相加');
assert.equal(teamTotals([]).networth, 0, '空队伍给 0，不要 NaN');
assert.equal(teamTotals([]).imp, 0, '空队伍的 IMP 同样是 0');

assert.equal(barWidth(50, 100), 50, '条形按比例');
assert.equal(barWidth(120, 100), 100, '超出定标要裁到 100%，不能画到框外');
assert.equal(barWidth(-30, 100), 0, '负值不能画成负宽度');
assert.equal(barWidth(10, 0), 0, '定标为 0 时返回 0，避免除零');
assert.equal(signedBarWidth(-80, 100), 80, '带符号量按绝对值取宽度');
assert.equal(maxAbs([3, -17, null, 9]), 17, 'IMP 定标取最大绝对值，null 跳过');
assert.equal(maxAbs([]), 0, '空集合为 0');
assert.equal(maxValue([1200, 39_400, 0]), 39_400, 'NW 定标取最大值');

assert.equal(compact(940), '940', '千以内写原值');
assert.equal(compact(39_400), '39.4千', '成千的数字用「千」，与社区口径一致');
assert.equal(compact(112_700), '112.7千', '十万级也保留一位小数，列宽稳定');
assert.equal(compact(-1500), '-1.5千', '负值同样处理');
assert.equal(signedInt(11), '+11', '正向 IMP 要带加号');
assert.equal(signedInt(-10), '-10', '负向保留负号');
assert.equal(signedInt(0), '0', '零不加符号');

console.log('matchReview 全部断言通过');
