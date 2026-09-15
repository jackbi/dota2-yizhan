import type { ImageChannel } from './localImages';
import { localizeImages } from './localImages';

/**
 * B站视频封面：构建期取回字节换成本站路径。
 *
 * ## 为什么值得单独做
 *
 * 这是站点里最后一处把浏览器直接指向第三方 CDN 的图片，而本机到 `i0/i1/i2.hdslb.com`
 * 的 TLS 握手会被**间歇性重置**：同一批封面，一次加载可能挂掉 20 张，下一次只挂 7 张。
 * 访客看到的就是「刚打开一排破图，刷几次又慢慢出来」——刷出来的那几张只是碰上了
 * 运气好的那条连接。`avatars.ts` 那边早就因为同样的原因（斗鱼 `douyucdn`、虎牙
 * `huyaimg`）改成本地化了，封面是漏网的一处。
 *
 * 顺带的好处：封面统一裁到 16:9、体积也可控，而热链原图实测从 4KB 到 187KB 不等。
 *
 * 拿不到字节时 `localizeCovers()` 不会返回那个地址，页面退回热链原图——跟以前一样，
 * 不会比现在更差。字节存在 `.cache/covers/`，构建末尾由 `astro.config.mjs` 发布到 `dist/covers/`。
 *
 * ## 尺寸
 *
 * 按能用到的最大尺寸取：专题墙在 1280px 容器里三列，一格约 397px，2x 屏就是 794，
 * 于是取 800。成员卡里的缩略图只有 112px，会多下一两百字节，但它们本来热链的就是原图，
 * 统一到 800x450 反而更省。
 */
export const COVER_CHANNEL: ImageChannel = {
	dir: 'covers',
	width: 800,
	height: 450,
	maxBytes: 1024 * 1024,
	concurrency: 4,
};

/**
 * 把一批视频封面下载到本地，返回 `BV 号 → /covers/xxx.jpg`。
 *
 * 用 BV 号而不是封面地址当键：地址变了（B站 换 CDN、加查询串）文件名照样换，
 * 调用方却不用跟着改查询方式。同一个 BV 只下一张。
 */
export function localizeCovers(videos: { bv: string; cover: string }[]): Promise<Map<string, string>> {
	const unique = new Map<string, string>();
	for (const v of videos) if (v.cover && !unique.has(v.bv)) unique.set(v.bv, v.cover);

	return localizeImages(
		COVER_CHANNEL,
		[...unique].map(([bv, cover]) => ({ key: bv, url: cover, slug: bv })),
	);
}
