/**
 * 内联进 `<script>` 的 JSON。
 *
 * `set:html` 对 `<script>` 是**原样输出**（Astro 只给 `define:vars` 那条路加转义，
 * 实测把 payload 写成 `set:html` 时产物里没有任何转义），而 `JSON.stringify` 不碰 `<`：
 * 数据里只要出现 `</script>`，浏览器就提前结束脚本元素，后面的内容当成 HTML 执行。
 *
 * 数据来源都要当不可信看：直播页那份带斗鱼/虎牙的房间标题（主播自己可改），
 * JSON-LD 那份带帖子标题（Reddit / NGA / 虎扑的用户内容）。所以内联 JSON 一律走这里，
 * 把 `<` 转义成 `\u003c`——JSON 与 JSON-LD 解析时都会还原成 `<`，值本身不变。
 *
 * 别自己写 `JSON.stringify`：`scripts/inlineJson.check.ts` 会扫 `src/**` 里的 `set:html`。
 */
export function inlineJson(value: unknown): string {
	return (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');
}
