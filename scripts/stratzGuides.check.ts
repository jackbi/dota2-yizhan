import assert from 'node:assert/strict';
import { branchLit, pickedCount, talentBadge, upgradeGlyph } from '../src/lib/guideIcons.ts';
import {
	firstPurchaseTime,
	formatDuration,
	guideTime,
	hasInventoryTimeline,
	inventoryAtTime,
	keyPurchases,
	levelAtTime,
	neutralTimeline,
	purchasesUpTo,
	skillSteps,
	spreadColumns,
	splitPurchases,
	stepsUpTo,
	summarizeSteps,
	talentTreeRows,
} from '../src/lib/guideBuild.ts';

/**
 * 英雄攻略里「怎么算」这一层的自检。三处会静默算错、页面上看不出来的地方：
 *
 * 1. 开局买装的时间是负的。STRATZ 的时间轴以 0:00 为对线开始，出门装是 `-01:29`
 *    这类负值；按 `Math.max(0, t)` 或直接拼 mm:ss 会把它写成 `00:89` 或 `01:29`，
 *    看着还挺正常，但那件装备的时间就错了。
 * 2. 加点编号不是英雄等级。实测一场 22 级英雄只留 18 条加点记录（技能点可以攒着
 *    不点），按等级编号会出现"第 19 点 = 等级 19"这种与实战不符的暗示。
 * 3. 成型件门槛。装备表里没有品质字段（中文接口 614 件 qual 全为空），只能按单价分；
 *    门槛写错会把 1450 的相位鞋混进「主要装备」，或者把 4200 的神杖漏掉。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/stratzGuides.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// ---- 时间格式：负数是开局买装，不能被夹掉，也不能写成 00:89 ----
{
	assert.equal(formatDuration(-89), '-01:29', '开局买装是负数，要带负号');
	assert.equal(formatDuration(534), '08:54', '常规时间');
	assert.equal(formatDuration(0), '00:00', '对线开始那一刻');
	assert.equal(formatDuration(2243), '37:23', '超过一小时的比赛按分钟继续累加，不折成时:分');
	assert.equal(formatDuration(Number.NaN), '00:00', '脏数据不能渲染出 NaN:NaN');
	ok('时间格式：负数、零、超长局与脏数据');
}

// ---- 加点顺序：按时间排、从第 1 点开始、天赋按 id 判定 ----
{
	// 真实一局（赏金猎人 9003122113）里摘的时间和技能 id：故意打乱数组顺序，验证排序。
	const learns = [
		{ abilityId: 1314, time: 288 },
		{ abilityId: 5286, time: -89 },
		{ abilityId: 7040, time: 1619 },
		{ abilityId: 5286, time: 166 },
		{ abilityId: 5286, time: 392 },
	];
	const steps = skillSteps(learns, (id) => id === 7040);
	assert.deepEqual(
		steps.map((step) => [step.order, step.abilityId, step.time, step.isTalent]),
		[
			[1, 5286, -89, false],
			[2, 5286, 166, false],
			[3, 1314, 288, false],
			[4, 5286, 392, false],
			[5, 7040, 1619, true],
		],
		'按加点时间排序、编号从 1 起、天赋要标出来',
	);

	// 0 / 负数 / 非数字的 abilityId 是解析残渣，留着会在格子里出现一个空白技能。
	assert.equal(skillSteps([{ abilityId: 0, time: 1 }, { abilityId: -3, time: 2 }], () => false).length, 0, '无效技能 id 要丢掉');
	assert.equal(skillSteps([], () => false).length, 0, '空数组不炸');

	// 同一时间点学两个技能（升级瞬间连点两下）不能让 sort 把它们换个位置。
	const sameTime = skillSteps([{ abilityId: 1, time: 10 }, { abilityId: 2, time: 10 }], () => false);
	assert.deepEqual(sameTime.map((step) => step.abilityId), [1, 2], '同一时刻的加点保持原顺序');
	ok('加点顺序：排序、编号、天赋标记与脏数据');
}

// ---- 出装：开局那批（≤ 0）要单独拎出来，整条时间轴也要按时间排 ----
{
	const { starting, timeline } = splitPurchases([
		{ itemId: 108, time: 1129 },
		{ itemId: 44, time: -89 },
		{ itemId: 20, time: -89 },
		{ itemId: 50, time: 534 },
		{ itemId: 0, time: 700 },
	]);
	assert.deepEqual(
		starting.map((entry) => entry.itemId),
		[44, 20],
		'出门装取时间 ≤ 0 的那批，顺序按时间',
	);
	assert.deepEqual(
		timeline.map((entry) => entry.time),
		[-89, -89, 534, 1129],
		'整条时间轴按时间升序，itemId 为 0 的空位丢掉',
	);
	assert.deepEqual(splitPurchases([]), { starting: [], timeline: [] }, '没有购买记录时两个数组都空');
	ok('出装：出门装切分、时间轴排序与空位过滤');
}

// ---- 成型件门槛：1450 的相位鞋不算，2600 的灵匣算 ----
{
	const cost = new Map([
		[108, 4200],
		[1107, 2600],
		[50, 1450],
		[44, 90],
	]);
	const purchases = [
		{ itemId: 44, time: -89 },
		{ itemId: 50, time: 534 },
		{ itemId: 108, time: 1129 },
		{ itemId: 1107, time: 1380 },
		{ itemId: 9999, time: 1600 },
	];
	assert.deepEqual(
		keyPurchases(purchases, (id) => cost.get(id) ?? 0).map((entry) => entry.itemId),
		[108, 1107],
		'只留单价 ≥ 2000 的成型件、保持传入顺序（调用方传的是排好序的时间轴）；查不到的装备按 0 处理，不能算进去',
	);
	ok('主要装备：门槛与未知装备');
}

// ---- 列表时间戳：STRATZ 偶尔不给 createdDateTime，不能渲染成 1970 ----
{
	const now = 1_789_892_000;
	assert.equal(guideTime(0, now), '—', '没有时间就留破折号');
	assert.match(guideTime(now - 3600, now), /^\d{2}\.\d{2} \d{2}:\d{2}$|^今天 \d{2}:\d{2}$/, '有时间的按站点统一格式');
	ok('列表时间戳：缺失时不留 1970');
}

// ---- 等级：列是"几级"，取那一刻之前到过的最高等级 ----
{
	// 真实一局（赏金猎人 9003122113）前 8 次升级
	const levels = [
		{ time: -89, level: 1 },
		{ time: 73, level: 2 },
		{ time: 166, level: 3 },
		{ time: 288, level: 4 },
		{ time: 534, level: 6 },
	];
	assert.equal(levelAtTime(levels, -89), 1, '开局是 1 级');
	assert.equal(levelAtTime(levels, 200), 3, '取那一刻之前最高的那一级');
	assert.equal(levelAtTime(levels, 534), 6, '正好卡在升级那一秒算升上去了');
	assert.equal(levelAtTime(levels, 0), 1, '两次升级之间取前一次的等级');

	// 事件乱序也要给出同一个答案：等级只升不降，最大值就是那一刻的等级。
	assert.equal(levelAtTime([{ time: 534, level: 6 }, { time: 73, level: 2 }], 600), 6, '顺序无关');
	assert.equal(levelAtTime(levels, 9999), 6, '末尾是最高级');

	// 没被解析过的比赛没有等级事件：画面要退化成"第几点"，不能假装 1 级。
	assert.equal(levelAtTime([], 500), null, '没有等级事件时返回 null');
	assert.equal(levelAtTime(levels, null), null, '时间拿不到时同样返回 null');
	ok('等级：取该时刻之前的最高级、乱序与缺失');
}

// ---- 游标：拖到某一刻，看的是"这一刻之前买到的"与"点掉的技能" ----
{
	const timeline = [
		{ itemId: 44, time: -89 },
		{ itemId: 29, time: 179 },
		{ itemId: 108, time: 1129 },
		{ itemId: 1808, time: 1780 },
	];
	assert.deepEqual(
		purchasesUpTo(timeline, 1129).map((entry) => entry.itemId),
		[44, 29, 108],
		'边界时刻算在内（那一秒刚买到手）',
	);
	assert.deepEqual(purchasesUpTo(timeline, -90), [], '拖到开局之前什么都还没买');
	assert.deepEqual(purchasesUpTo(timeline, 9999).length, 4, '拖到末尾是全部');

	const steps = skillSteps(
		[
			{ abilityId: 5286, time: -89 },
			{ abilityId: 1314, time: 288 },
			{ abilityId: 7040, time: 1619 },
		],
		(id) => id === 7040,
	);
	assert.equal(stepsUpTo(steps, 288), 2, '第一点与第二点都算上');
	assert.equal(stepsUpTo(steps, 0), 1, '只点了一点的时候');
	assert.equal(stepsUpTo(steps, 9999), 3, '全部');
	ok('游标：按时刻取已购买与已加点');
}

// ---- 背包快照：游标拖到哪一刻，就取那一刻之前最后一次快照 ----
{
	const inventory = [
		{ time: -89, slots: [20, 44, 16, 20, 16, 16], backpack: [0, 0, 0], teleport: 46, neutral: 0 },
		{ time: 534, slots: [50, 0, 0, 0, 36, 0], backpack: [0, 0, 0], teleport: 46, neutral: 0 },
		{ time: 1129, slots: [50, 108, 0, 0, 36, 0], backpack: [0, 0, 0], teleport: 46, neutral: 1868 },
	];
	assert.deepEqual(inventoryAtTime(inventory, 600)?.slots, [50, 0, 0, 0, 36, 0], '取 534 那一次快照');
	assert.deepEqual(inventoryAtTime(inventory, 1129)?.slots, [50, 108, 0, 0, 36, 0], '正好命中那一刻的快照');
	assert.deepEqual(inventoryAtTime(inventory, -89)?.slots, [20, 44, 16, 20, 16, 16], '开局那一刻是出门装');
	assert.equal(inventoryAtTime(inventory, -90), null, '开局之前没有快照——界面据此退回购买清单');
	assert.equal(inventoryAtTime([], 500), null, '整场没有背包快照（比赛没被解析）时返回 null');
	ok('背包快照：按时刻取、边界与缺失');
}

// ---- 残缺的背包时间线不能当数据用 ----
{
	// 实测 9003853027：等级 27 条齐全，背包只有开局那一条，六格全空
	const stub = [{ time: -89, slots: [0, 0, 0, 0, 0, 0], backpack: [0, 0, 0], teleport: 0, neutral: 0 }];
	assert.equal(hasInventoryTimeline(stub), false, '只有开局那一条时判定为不可用');
	assert.equal(hasInventoryTimeline([]), false, '没有快照时不可用');
	assert.equal(
		hasInventoryTimeline([...stub, { time: 55, slots: [20, 44, 16, 20, 16, 16], backpack: [0, 0, 0], teleport: 46, neutral: 0 }]),
		true,
		'有一条对线之后的快照就算可用',
	);
	ok('背包时间线可用性');
}

// ---- 中立物品来自中立槽的变化，不在购买记录里 ----
{
	const inventory = [
		{ time: -89, slots: [], backpack: [], teleport: 0, neutral: 0 },
		{ time: 914, slots: [], backpack: [], teleport: 0, neutral: 1868 },
		{ time: 1000, slots: [], backpack: [], teleport: 0, neutral: 1868 },
		{ time: 1624, slots: [], backpack: [], teleport: 0, neutral: 1598 },
	];
	assert.deepEqual(
		neutralTimeline(inventory).map((entry) => `${entry.itemId}@${entry.time}`),
		['1868@914', '1598@1624'],
		'只在真正换了一件时记一笔，同一个中立物品持续持有不重复记',
	);
	assert.deepEqual(neutralTimeline([]), [], '没有快照时为空');
	ok('中立物品：从中立槽的变化里拣出来');
}

// ---- 装备行铺格：均匀铺满整行，只有一个时居中 ----
{
	assert.deepEqual(spreadColumns(5, 25), [1, 7, 13, 19, 25], '5 件铺满 25 列');
	assert.deepEqual(spreadColumns(1, 25), [13], '只有一件时居中');
	assert.deepEqual(spreadColumns(3, 25), [1, 13, 25], '3 件是首、中、尾');
	assert.deepEqual(spreadColumns(0, 25), [], '没有装备时不给格子');
	const wide = spreadColumns(12, 25);
	assert.equal(wide.length, 12, '件数多时按件数给格');
	assert.ok(wide.every((col, index) => col >= 1 && col <= 25 && (index === 0 || col > wide[index - 1])), '列号单调不减且落在 1..25 内');
	ok('装备行铺格');
}

// ---- 加点汇总：按名字合并，天赋与同名技能分开算 ----
{
	assert.deepEqual(
		summarizeSteps([
			{ name: '忍术', isTalent: false },
			{ name: '忍术', isTalent: false },
			{ name: '+50 追踪术金钱', isTalent: true },
			{ name: '忍术', isTalent: false },
		]),
		[
			{ name: '忍术', isTalent: false, count: 3 },
			{ name: '+50 追踪术金钱', isTalent: true, count: 1 },
		],
		'按出现先后排；同名同类型的累加',
	);
	assert.deepEqual(summarizeSteps([]), [], '空数组不炸');
	ok('加点汇总');
}
// ---- 天赋树：官方 datafeed 是两两一组、越靠后层级越高，还原成 25 在上的四层 ----
{
	// 赏金猎人的真实顺序（前两项是 10 级、往后每两项升 5 级）
	const talents = [
		{ id: 869, name: '+0.4秒 投掷飞镖减速' },
		{ id: 5939, name: '+30 攻击力' },
		{ id: 959, name: '-30% 暗影步期间承受伤害' },
		{ id: 7040, name: '+50 追踪术金钱' },
		{ id: 6358, name: '+190 投掷飞镖伤害' },
		{ id: 6018, name: '+50 忍术窃取金钱' },
		{ id: 878, name: '追踪术提供共享视野' },
		{ id: 1172, name: '忍术无冷却' },
	];
	const rows = talentTreeRows(talents, new Set([869, 7040, 6018]));
	assert.deepEqual(
		rows.map((row) => row.level),
		[25, 20, 15, 10],
		'25 在最上面，往下递减',
	);
	assert.deepEqual(
		rows.map((row) => [row.left.id, row.right.id]),
		[
			[878, 1172],
			[6358, 6018],
			[959, 7040],
			[869, 5939],
		],
		'每一层是相邻的两项，左边取偶数位、右边取奇数位',
	);
	assert.deepEqual(
		rows.filter((row) => row.left.picked || row.right.picked).map((row) => `${row.level}:${row.left.picked ? 'L' : 'R'}`),
		['20:R', '15:R', '10:L'],
		'这一局点的三个按 id 标出来，位置也要对',
	);
	assert.deepEqual(talentTreeRows([], new Set()), [], '没有天赋数据时为空');

	// 只有一项时不能凑成一层，否则会渲染出 undefined 的右选项
	assert.deepEqual(talentTreeRows([{ id: 1, name: '孤项' }], new Set()), [], '落单的一项丢掉');
	ok('天赋树：分层、左右配对与已点标记');
}

// ---- 蓝杖/魔晶：取这一局第一次买到的时间，没买是 null ----
{
	const purchases = [
		{ itemId: 46, time: -89 },
		{ itemId: 609, time: 1105 },
		{ itemId: 108, time: 1129 },
		{ itemId: 609, time: 1800 },
	];
	assert.equal(firstPurchaseTime(purchases, [108]), 1129, '只买过一次时取那次');
	assert.equal(firstPurchaseTime(purchases, [609, 725]), 1105, '买过多次时取最早一次（魔晶还能从肉山掉）');
	assert.equal(firstPurchaseTime(purchases, [727]), null, '没买过就是 null——界面据此画成灰的');
	assert.equal(firstPurchaseTime([], [108]), null, '没有购买记录时也是 null');
	ok('蓝杖/魔晶：首次购买时间');
}

// ---- 天赋徽章：八片叶子与天赋树的八个选项一一对应，别有两片指向同一格 ----
{
	const rows = (picked: number[][]): { left: { picked: boolean }; right: { picked: boolean } }[] =>
		[0, 1, 2, 3].map((i) => ({ left: { picked: picked[0]?.includes(i * 2) ?? false }, right: { picked: picked[0]?.includes(i * 2 + 1) ?? false } }));

	// 八片叶子各自落在哪一格：不能重、不能漏，否则点亮时会两片一起亮或永远不亮
	const slots = new Set<string>();
	for (let i = 0; i < 8; i += 1) {
		const lit = branchLit(i, rows([[0], []]));
		const litOnly: number[] = [];
		for (let row = 0; row < 4; row += 1) {
			for (const side of ['left', 'right'] as const) {
				const probe = [0, 1, 2, 3].map((r) => ({
					left: { picked: r === row && side === 'left' },
					right: { picked: r === row && side === 'right' },
				}));
				if (branchLit(i, probe)) litOnly.push(row * 2 + (side === 'right' ? 1 : 0));
			}
		}
		assert.equal(litOnly.length, 1, `第 ${i} 片叶子只对应一个格子`);
		slots.add(String(litOnly[0]));
		assert.equal(typeof lit, 'boolean', '返回布尔');
	}
	assert.equal(slots.size, 8, '八片叶子覆盖八个格子，不重不漏');

	// 真实一局：25 级没点、20 级点右、15 级点右、10 级点左
	const detail = [
		{ left: { picked: false }, right: { picked: false } },
		{ left: { picked: false }, right: { picked: true } },
		{ left: { picked: false }, right: { picked: true } },
		{ left: { picked: true }, right: { picked: false } },
	];
	assert.equal(pickedCount(detail), 3, '这一局点了 3 个');
	assert.equal(pickedCount([]), 0, '没有数据时是 0');
	assert.equal([...Array(8).keys()].filter((i) => branchLit(i, detail)).length, 3, '正好亮三片叶子');
	assert.equal(branchLit(99, detail), false, '越界的下标不炸，返回未点亮');
	ok('天赋徽章：叶子与格子的对应、点亮数量');
}

// ---- 天赋徽章：渐变按徽章自带一份，url(#…) 都得能解析到，且两个徽章之间不撞名 ----
{
	/*
	 * 一个页面里会同时挂好几个徽章（加点行里每一点一个、总结一格、悬停面板一个）。
	 * 固定 id 会撞车：`url(#x)` 永远解析到文档里第一个同名节点，于是"点亮的是这一局的天赋、
	 * 颜色却跟着上一局或另一格走"。这里把两条约束钉在断言里：引用必须落在同一个徽章内，
	 * 且两个徽章的 id 集合不相交。
	 */
	const idsOf = (svg: string): string[] => [...svg.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
	const refsOf = (svg: string): string[] => [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);

	// 真实一局：25 级没点、20 级点右、15 级点右、10 级点左
	const detail = [
		{ left: { picked: false }, right: { picked: false } },
		{ left: { picked: false }, right: { picked: true } },
		{ left: { picked: false }, right: { picked: true } },
		{ left: { picked: true }, right: { picked: false } },
	];
	const litBadge = talentBadge(detail, 'h-6 w-6');
	const emptyBadge = talentBadge([], 'h-6 w-6');

	for (const svg of [litBadge, emptyBadge]) {
		const defined = new Set(idsOf(svg));
		for (const ref of refsOf(svg)) assert.ok(defined.has(ref), `渐变 ${ref} 在同一个徽章里有定义`);
	}
	// 三条叶子渐变 + 一条进度点渐变（三颗点共用同一条，所以去重后是 4）
	assert.equal(new Set(refsOf(litBadge)).size, 3 + 1, '三个点亮的天赋各一条渐变，再加进度点那条');
	assert.equal(refsOf(emptyBadge).length, 0, '没有天赋数据时不带渐变（灰树、灰点都是纯色）');

	/*
	 * 色带与渐变线都按**叶子下标**取，不是按层级：最下面那对叶子是 10 级。配反了不会报错，
	 * 只会把四层的明暗对调，页面上根本看不出来——所以拿"只点一片"的徽章把端点钉死。
	 */
	const only = (row: number, side: 'left' | 'right'): { left: { picked: boolean }; right: { picked: boolean } }[] =>
		[0, 1, 2, 3].map((index) => ({
			left: { picked: index === row && side === 'left' },
			right: { picked: index === row && side === 'right' },
		}));

	const bottomLeft = talentBadge(only(3, 'left'), 'h-6 w-6');
	assert.ok(bottomLeft.includes('x1="4.2358" y1="40.4932" x2="26.9095" y2="63.1668"'), '10 级左叶用最下面那条渐变线');
	assert.ok(bottomLeft.includes('stop offset="0.1257"'), '10 级的色带以 0.1257 起，别的层都是 0.0938');

	const topRight = talentBadge(only(0, 'right'), 'h-6 w-6');
	assert.ok(topRight.includes('x1="46.3174" y1="3.667" x2="15.0698" y2="57.7894"'), '25 级右叶的渐变线在树顶');

	const litIds = new Set(idsOf(litBadge));
	assert.equal(idsOf(emptyBadge).filter((id) => litIds.has(id)).length, 0, '两个徽章的 id 不重名');
	assert.notEqual(litBadge, emptyBadge, '点亮与否画出来不是同一份');
	ok('天赋徽章：渐变的定义与引用');
}

// ---- 蓝杖 / 魔晶的图形：出没出决定颜色，且两件是两套形状 ----
{
	const scepterLit = talentBadge([], 'h-4 w-4'); // 顺手确认空数据不会炸
	assert.ok(scepterLit.includes('<svg'), '空数据也能画出徽章');

	const scepter = upgradeGlyph('scepter', true, 'h-8 w-8');
	const shard = upgradeGlyph('shard', true, 'h-8 w-8');
	assert.notEqual(scepter, shard, '两件图形不是同一份');
	assert.ok(scepter.includes('rgba(255,255,255,0.5)'), '杖身始终是暗的（官方那份也如此）');
	assert.notEqual(scepter, upgradeGlyph('scepter', false, 'h-8 w-8'), '出没出的宝石颜色不同');
	assert.notEqual(shard, upgradeGlyph('shard', false, 'h-8 w-8'), '出没出的翼色不同');
	ok('蓝杖/魔晶：形状与点亮状态');
}

console.log(`stratzGuides 全部断言通过（${cases} 组）`);
