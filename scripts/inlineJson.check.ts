import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inlineJson } from '../src/lib/inlineJson.ts';

/**
 * 内联 JSON 的自检。
 *
 * `set:html` 写进 `<script>` 的内容是**原样输出**的（实测编译产物里没有任何转义），
 * 而页面内联的数据带着第三方字符串：直播页的房间标题（主播自己可改）、JSON-LD 里的帖子标题
 * （Reddit / NGA / 虎扑的用户内容）。`JSON.stringify` 不碰 `<`，所以数据里一个 `</script>`
 * 就能提前闭合脚本元素，把后面的内容变成可执行的标记。
 *
 * 两条断言：`inlineJson` 转义之后**值不变**（只是 `<` 变成 `\u003c`，JSON 解析会还原），
 * 以及 `src/**` 里没有 `set:html={…JSON.stringify…}` 这种裸写法。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/inlineJson.check.ts`）。
 */

let cases = 0;

// 1. 值不变：转义只影响字面量写法，不影响解析出来的内容。
{
	const value = {
		title: 'x</script><script>alert(1)</script>',
		nested: ['a<b', { deep: '</script>' }],
		num: 3,
		nil: null,
	};
	const encoded = inlineJson(value);
	assert.ok(!encoded.includes('</script>'), `转义后不该还留着 </script> → ${encoded}`);
	assert.ok(encoded.includes('\\u003c'), '`<` 应当转成 \\u003c');
	assert.deepEqual(JSON.parse(encoded), value, '转义后解析回来必须与原值完全一致');
	cases += 1;
}

// 2. 边界：中文、引号、反斜杠、undefined 都不能把 JSON 写坏。
{
	const value = { 名字: '引号" 与 \\ 反斜杠', n: 0, ok: false };
	assert.deepEqual(JSON.parse(inlineJson(value)), value, '中文与转义字符要走通');
	assert.equal(inlineJson(undefined), 'null', 'undefined 产出合法 JSON 而不是 undefined 字面量');
	assert.deepEqual(JSON.parse(inlineJson(undefined)), null);
	cases += 1;
}

// 3. 扫描：`set:html` 里不许出现裸的 `JSON.stringify`。
{
	const root = path.join(process.cwd(), 'src');
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(?:astro|ts)$/.test(entry.name)) files.push(full);
		}
	};
	walk(root);
	assert.ok(files.length > 50, `应当扫到不少源文件，实际只扫到 ${files.length} 个——先确认目录没走错`);

	const offenders: string[] = [];
	let setHtmlCount = 0;
	for (const file of files) {
		for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
			const at = line.indexOf('set:html={');
			if (at < 0) continue;
			setHtmlCount += 1;
			if (line.slice(at).includes('JSON.stringify')) {
				offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `set:html 内联 JSON 必须走 inlineJson，别用裸 JSON.stringify：\n  ${offenders.join('\n  ')}`);
	// 数量只是防呆：真被删光了说明扫描逻辑失效，那样这条检查会永远绿。
	assert.ok(setHtmlCount >= 10, `set:html 应该还有十几处，实际只找到 ${setHtmlCount} 处`);
	cases += 1;
}

console.log(`inlineJson 全部断言通过（${cases} 组用例）`);
