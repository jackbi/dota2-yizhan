import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `/party` 的静态可见性自检。
 *
 * 起因：一次改动里同一个错误连犯三处——房间区、提示条、Steam ID 折叠块都被静态地藏起来了，
 * 而脚本以为自己能显示它们。表现是最难查的那种：**页面上什么都没有，也不报错**。
 *
 * 两条规则都来自实际踩到的坑，都在 `src/pages/party.astro` 上检查：
 *
 * 1. **不许用 `hidden` 属性或 `hidden` 类来藏东西。** Tailwind 的 preflight 是
 *    `[hidden]:where(...) { display: none !important }`（v4 带 `!important`），
 *    `hidden` 类同样是 utility 层；而脚本里的 `setVisible()` 只摘 `hidden` 属性 + 写内联
 *    `display`。这两种手法都会让元素**永远露不出来**。初值一律用 `style="display:none"`。
 * 2. **凡是静态藏起来的元素，脚本里必须能找到负责显示它的代码。** 按 id 或 `data-*`
 *    在 partyRoom.ts 里搜一遍即可：搜不到就说明没有任何一行代码会让它出现，
 *    那它就是死代码（`steamid-box` 当初就是这么变成隐形功能的）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/partyVisibility.check.ts`）。
 */

const page = readFileSync(new URL('../src/pages/party.astro', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/scripts/partyRoom.ts', import.meta.url), 'utf8');

/** 取出所有开标签。属性值里的 `>` 我们不关心，够用即可。 */
const tags = page.match(/<[a-z][^>]*>/gi) ?? [];
assert.ok(tags.length > 20, `party.astro 里只解析出 ${tags.length} 个标签，解析多半坏了`);

// 规则 0：`setVisible` 是唯一的显隐出口，它必须同时摘掉 `hidden` 属性并写内联 `display`。
// 这是规则 1 能成立的前提——只写 `style.display` 是露不出带 `hidden` 属性的元素的。
const setVisibleBody = /function setVisible[^{]*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? '';
assert.match(setVisibleBody, /\.hidden\s*=/, 'setVisible 必须设置 node.hidden');
assert.match(setVisibleBody, /style\.display/, 'setVisible 必须设置 node.style.display');

const failures: string[] = [];

for (const tag of tags) {
	// 先把 class 属性的值挖掉，否则 `class="mt-3 hidden ..."` 会被误判成 hidden 属性。
	const withoutClass = tag.replace(/class="[^"]*"/gi, 'class=""');
	// `hidden` 属性；`hidden="until-found"` 是另一回事，不在此列。
	if (/\shidden(\s|=|>|\/)/i.test(withoutClass) && !/hidden\s*=\s*"until-found"/i.test(tag)) {
		failures.push(`用了 hidden 属性（脚本摘不掉它，元素永远露不出来）：${tag.slice(0, 100)}`);
	}
	// 独立的 `hidden` 类。`hidden sm:inline` 是响应式变体、`overflow-hidden` 是另一个词，都放过。
	const classAttr = /class="([^"]*)"/i.exec(tag)?.[1] ?? '';
	if (classAttr.split(/\s+/).some((token) => token === 'hidden')) {
		failures.push(`用了独立的 hidden 类（setVisible 清不掉）：${tag.slice(0, 100)}`);
	}
}

// 规则 2：静态藏起来的元素，脚本里得有人负责显示它。
const hiddenNodes = tags.filter((tag) => /style="[^"]*display:\s*none/i.test(tag));
assert.ok(hiddenNodes.length > 0, '一个静态隐藏的元素都没有，规则 2 等于没检查，确认一下解析');

for (const tag of hiddenNodes) {
	const id = /\sid="([^"]+)"/i.exec(tag)?.[1];
	const dataAttrs = [...tag.matchAll(/\s(data-[a-z-]+)=/gi)].map((m) => m[1]);
	const hooks = [id, ...dataAttrs].filter((value): value is string => Boolean(value));
	if (hooks.length === 0) continue; // 没有 id / data-* 的节点由父级或结构控制，这里管不到。

	const mentioned = hooks.some((hook) => script.includes(hook));
	if (!mentioned) {
		failures.push(`静态藏起来，但脚本里没有任何地方引用它（没有任何代码会显示它）：${tag.slice(0, 100)}`);
	}
}

if (failures.length > 0) {
	console.error('party 可见性自检不通过：');
	for (const line of failures) console.error(`  - ${line}`);
	process.exit(1);
}

console.log(`party 可见性断言通过（${tags.length} 个标签、${hiddenNodes.length} 个静态隐藏元素）`);
