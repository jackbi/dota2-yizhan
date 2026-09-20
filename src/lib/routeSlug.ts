/**
 * 站内 id 只保留字母、数字与汉字，其余一律折叠成连字符。
 *
 * 这些 id 会变成 `/tournaments/[id]`、`/teams/[id]` 的**路径段**。队名里只要有 `/`，
 * Astro 就会把路径当成两段、直接抛 `Missing parameter: id` 打断整个构建——
 * 不是这一个页面少生成，是**整站构建失败**，线上只能停在上一份构建产物上。
 *
 * 吃过两次同款：Liquipedia 的赛事路径（`lp-...`，见 `liquipediaApi` 的注释），
 * 以及 OpenDota `/api/live` 的队名——实测出现过 `team yosi/vape`，还有一个队名就是
 * 一个 `?`。所以凡是拿外部字符串拼路径段的地方都得过这一层。
 */
export function routeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * 这个 id 能不能安全地当一个路径段：非空、不含 `/` `\` `?` `#` `%` 与控制字符。
 *
 * 给 `getStaticPaths` 当兜底用——万一将来又有一条线把外部字符串直接拼进 id，
 * 也只是少一个队伍页并打印一行警告，不会再让整站构建失败。
 */
export function isPathSegment(value: string): boolean {
	return value.length > 0 && value.length <= 120 && !/[/\\?#%\u0000-\u001f]/.test(value);
}
