/**
 * Liquipedia 门户的地区 → 中文标签。
 *
 * 键是 `parseTeamPortal()` 从门户的 `<h4 id="...">` 归一化出来的那串（`eastern-europe-cis`），
 * 不是我们编的——门户加一个地区，这里对不上就会退回门户原文（`Eastern Europe & CIS`），
 * 页面照常渲染，只是没中文。`scripts/teamPortal.check.ts` 钉住已知的六个都有标签。
 *
 * 单独一个纯模块（不引 `node:fs`）：自检要直接 import 它。
 */

/** 地区键 → 页面上的中文标题。顺序也按门户上的顺序走，这里只负责翻译。 */
const LABELS: Record<string, string> = {
	'north-america': '北美',
	'south-america': '南美',
	'western-europe': '西欧',
	'eastern-europe-cis': '东欧与独联体',
	china: '中国',
	'southeast-asia': '东南亚',
};

/** 认得的地区用中文，认不得的原样显示门户给的名字（别编一个"其他"把两个地区混在一起）。 */
export function teamRegionLabel(key: string, fallback: string): string {
	return LABELS[key] ?? fallback;
}

/** 门户里出现过、而这里没有标签的地区键——自检用。 */
export function unknownRegionKeys(keys: string[]): string[] {
	return keys.filter((key) => !(key in LABELS));
}
