import type { ImageChannel, LocalImageSource } from './localImages';
import { localizeImages } from './localImages';

/**
 * 主播头像：构建期把平台 CDN 上的图取回来，换成本站路径。
 *
 * 通用逻辑（直连 → `wsrv.nl` 代理 → `.cache/` → 构建末尾发布到 `dist/`）在
 * `localImages.ts`，这里只剩「头像这个频道长什么样」。
 *
 * 头像地址本来就跟着房间数据一起取回来了，**不需要额外请求元数据**：
 * 斗鱼 `betard` 的 `room.owner_avatar`（OB 成员）、虎牙 `profileInfo.avatar180`、
 * 斗鱼分区页的 `av`、虎牙榜单里的 `avatar180`（热门榜）。多出来的工作只有下载图片本身。
 *
 * 卡片最大 56px，2x 屏幕 112px，128 够用且裁成正方形——两家原图的比例并不一样。
 */
export const AVATAR_CHANNEL: ImageChannel = {
	dir: 'avatars',
	width: 128,
	height: 128,
	maxBytes: 512 * 1024,
	concurrency: 4,
};

/** 一个待本地化的头像来源。`avatar` 是平台 CDN 地址。 */
export interface AvatarSource {
	/** 稳定标识，用来生成文件名，例如 `douyu:9999` */
	key: string;
	avatar?: string;
}

/**
 * 把所有房间的头像下载到本地，返回 `key → /avatars/xxx.jpg`。
 *
 * 拿不到的房间不会出现在返回值里——调用方据此退回首字母占位，不渲染 `<img>`，
 * 所以不存在「文件没拷过去、页面上留一堆破图」的情况。
 */
export function localizeAvatars(sources: AvatarSource[]): Promise<Map<string, string>> {
	return localizeImages(
		AVATAR_CHANNEL,
		sources.map((s): LocalImageSource => ({ key: s.key, url: s.avatar })),
	);
}
