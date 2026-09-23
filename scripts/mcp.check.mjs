/**
 * MCP 的自检。
 *
 * 只钉两类最容易悄悄坏掉、而且坏了很难发现的东西：
 *
 * 1. **俗称表的歧义**。一个俗称挂到两个英雄上时，解析结果取决于遍历顺序——同样一句
 *    「小牛」这次给撼地者、下次给大地之灵，还不报错。这种必须离线挡住。
 * 2. **BP 记录重建**。`suggest_pick` 不要求用户排 24 手，而是按顺序表反推当前手号；
 *    反推错一手，后面所有建议都建立在错误的手号上，但输出看起来完全正常。
 *
 * 另有一条软检查：俗称表的键能不能对上真实英雄（英雄改名会落到这里）。它要联网，
 * 拿不到就跳过并提示，不当失败——CI 的 `pnpm check` 跑在构建之前，不该依赖外网。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const root = fileURLToPath(ROOT);

let failed = 0;
const ok = (message) => console.log(`  ✓ ${message}`);
const bad = (message) => {
	failed += 1;
	console.error(`  ✗ ${message}`);
};

// ---------------------------------------------------------------- 1. 俗称表

console.log('俗称表');

const { HERO_ALIASES } = await import(new URL('../mcp/heroAliases.mjs', import.meta.url));
const aliasOwner = new Map();
let aliasCount = 0;

for (const [officialName, aliases] of Object.entries(HERO_ALIASES)) {
	if (!Array.isArray(aliases) || aliases.length === 0) {
		bad(`${officialName} 的俗称不是非空数组`);
		continue;
	}
	for (const alias of aliases) {
		if (typeof alias !== 'string' || alias.trim() === '') {
			bad(`${officialName} 里有一个空俗称`);
			continue;
		}
		aliasCount += 1;
		const key = alias.trim().toLowerCase();
		const owner = aliasOwner.get(key);
		if (owner && owner !== officialName) {
			bad(`俗称「${alias}」同时挂在 ${owner} 和 ${officialName} 上，解析结果会随遍历顺序变`);
		} else {
			aliasOwner.set(key, officialName);
		}
	}
}

// 俗称不能撞上别人的官方名，否则「官方名优先」这条规则会让人以为俗称失效了。
for (const [officialName, aliases] of Object.entries(HERO_ALIASES)) {
	for (const alias of aliases) {
		const key = alias.trim().toLowerCase();
		for (const other of Object.keys(HERO_ALIASES)) {
			if (other !== officialName && other.toLowerCase() === key) {
				bad(`「${alias}」是 ${officialName} 的俗称，但它同时也是 ${other} 的官方名`);
			}
		}
	}
}

ok(`${Object.keys(HERO_ALIASES).length} 个英雄、${aliasCount} 条俗称，没有互相抢的`);

// ---------------------------------------------------------------- 2. 版本号

console.log('版本号');

const rootPkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
const mcpPkg = JSON.parse(readFileSync(new URL('mcp/package.json', ROOT), 'utf8'));
if (rootPkg.version === mcpPkg.version) ok(`两边都是 ${rootPkg.version}`);
else bad(`根 package.json 是 ${rootPkg.version}，mcp/package.json 是 ${mcpPkg.version}，要一起改`);

// ---------------------------------------------------------------- 3. BP 记录重建

/*
 * `tools.mjs` 依赖 `mcp/dist/engine.mjs`（构建产物，不进 git），所以先打一次包。
 * 顺带把「改了引擎忘了重新打包」这件事挡在发布之前——包里带的是旧口径、但代码看起来是新的，
 * 是这类工具最难查的一种坏法。
 */
const before = readFileSync(new URL('mcp/dist/engine.mjs', ROOT), { throwIfNoEntry: false })?.length ?? 0;
execFileSync(process.execPath, ['scripts/build-mcp.mjs'], { cwd: root, stdio: 'pipe' });
const after = readFileSync(new URL('mcp/dist/engine.mjs', ROOT)).length;

console.log('引擎打包');
ok(before === after ? `产物与源码一致（${(after / 1024).toFixed(1)}KB）` : `产物已重新生成（${(before / 1024).toFixed(1)}KB → ${(after / 1024).toFixed(1)}KB）`);

console.log('BP 记录重建');

const { reconstructRecord } = await import(new URL('../mcp/tools.mjs', import.meta.url));
const { CM_STEPS, snapshot } = await import(new URL('../mcp/dist/engine.mjs', import.meta.url));

const assertStep = (label, input, expectedCursor) => {
	const { recorded, leftover } = reconstructRecord(input);
	if (leftover.length) bad(`${label}：多出 ${leftover.length} 个排不进去的英雄`);
	else if (recorded.length !== expectedCursor) bad(`${label}：期望停在第 ${expectedCursor} 手，实际 ${recorded.length}`);
	else ok(label);
};

// 一手都没录：停在起点。
assertStep('空记录停在起点', { ourSide: 'radiant', firstPicker: 'radiant', ourBans: [], ourPicks: [], theirBans: [], theirPicks: [] }, 0);

/*
 * 第一禁用阶段（1-7：F F S S F S S）之后、首抢之前：先选方 3 禁、后选方 4 禁，共 7 手。
 * 顺序表里第 8 手是「先选方挑选」，所以停在第 7 手。
 */
assertStep(
	'第一禁用阶段走完停在第 7 手',
	{ ourSide: 'radiant', firstPicker: 'radiant', ourBans: ['a', 'b', 'c'], ourPicks: [], theirBans: ['d', 'e', 'f', 'g'], theirPicks: [] },
	7,
);

/*
 * 先选方首抢（第 8 手）之后停在第 8 手——这时轮到后选方挑选。
 * 顺便覆盖「我方是后选方」这条分支：`ourSide` 与 `firstPicker` 是两件事。
 */
assertStep(
	'首抢之后轮到后选方',
	{
		ourSide: 'dire',
		firstPicker: 'radiant',
		ourBans: ['d', 'e', 'f', 'g'],
		ourPicks: [],
		theirBans: ['a', 'b', 'c'],
		theirPicks: ['h'],
	},
	8,
);

/*
 * 顺序对不上的输入必须报出来，而不是硬排。
 * 「先选方在第一手之前就有两次禁用之外的东西」——这里给后选方 2 禁，但第 1、2 手都是先选方的。
 */
{
	const { leftover } = reconstructRecord({ ourSide: 'radiant', firstPicker: 'radiant', ourBans: [], ourPicks: [], theirBans: ['a', 'b'], theirPicks: [] });
	if (leftover.length === 2) ok('排不进去的英雄会被报出来');
	else bad(`顺序对不上时应该报出 2 个多余人手，实际 ${leftover.length}`);
}

// 顺序表本身：24 手、7 禁 5 选、首手是先选方禁用。
if (CM_STEPS.length === 24 && snapshot([]).nextStep === 1) ok('顺序表 24 手，起点正确');
else bad(`顺序表异常（${CM_STEPS.length} 手）`);

// ---------------------------------------------------------------- 4. 俗称表对账（软检查）

console.log('俗称表与真实英雄对账');

try {
	const response = await fetch('https://dota2.hiwenbin.com/draft-data.json', { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = await response.json();
	const names = new Set(data.heroes.map((hero) => hero.name));
	const unmatched = Object.keys(HERO_ALIASES).filter((name) => !names.has(name));
	if (unmatched.length) bad(`这些键在英雄表里找不到：${unmatched.join('、')}`);
	else ok(`${data.heroes.length} 个英雄全部对上`);
} catch (error) {
	console.log(`  · 跳过（拿不到线上英雄表：${error.message}）`);
}

// ----------------------------------------------------------------

if (failed > 0) {
	console.error(`\nmcp.check：${failed} 项不通过`);
	process.exit(1);
}
console.log('\nmcp.check 全部通过');
