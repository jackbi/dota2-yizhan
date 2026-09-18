/**
 * 虎牙 `profileRoom` 响应的解析（纯函数，自检见 `scripts/liveStream.check.ts`）。
 *
 * 单独成文件是因为它要能被 `pnpm check` 直接 import——检查脚本跑在裸 Node 的
 * `--experimental-strip-types` 下，那个解析器不认无扩展名的相对引用，所以这里不引用任何
 * 兄弟模块（`liveStream.ts` 引着 `./md5` 就不行）。
 */

/** 虎牙给的候选线路里的一条。 */
export interface HuyaLine {
	/** CDN 代号，即接口里的 `cdnType`（AL / TX / HS…），只用在日志与自检里。 */
	cdn: string;
	url: string;
	/** 接口给的线路偏好（`webPriorityRate`），越大越靠前。 */
	priority: number;
}

export interface HuyaStreamInfo {
	/** `liveStatus` 是不是 `ON`。轮播与未开播的房间一个地址都不给。 */
	live: boolean;
	owner?: string;
	title?: string;
	lines: HuyaLine[];
}

/**
 * 解析 `mp.huya.com/cache.php?m=Live&do=profileRoom` 的响应。
 *
 * ## 为什么虎牙也要走直链
 *
 * 原先虎牙格子嵌的是它官方的纯播放器页 `liveshare.huya.com/iframe/{房间号}`：没有导航、
 * 没有广告、自带音量滑杆，看着正合适。实测的问题是**只给约 10 分钟试看**，之后画面上盖一层
 * 「试看结束，到虎牙直播接着看吧～」。分屏墙要的正是长时间挂着，这条限制直接把它废掉，
 * 于是改成和斗鱼一样的自解析；那页只留作兜底，并且要带 `?inPc=1` 把试看关掉
 * （开关的来历与实测写在 `data/site.ts` 的 `embedUrl()`）。
 *
 * ## 直链的性质（**都实测过，别再当待验证**）
 *
 * - **签名有效 24 小时**：`wsTime` 等于解析时刻的秒级时间戳 +86400，不是斗鱼那种「25 秒后
 *   就断」的一次性令牌，所以算完先放着、断了再重播都没问题。
 * - **可以反复拉**：同一个地址连拉 5 次全部 200（斗鱼那条第二次就只剩试看量级）。
 * - **不绑 IP、不绑 UA**：本机（代理出口）解析、新加坡那台机器拉流，5 秒拿到 7.8MB；不带
 *   UA 头也照样给流。
 * - **CDN 给 `Access-Control-Allow-Origin: *`**：浏览器直连即可，视频字节不过我们的服务器。
 * - **单条线路会抽风**：实测同一条 AL 线 8 次里 3 次 403、2 次连不上，同一时刻 HS 线 8/8 通。
 *   所以这里把接口给的线路**全带回去**，让播放器一条播不动就换下一条。
 */
export function parseHuyaStream(raw: unknown): HuyaStreamInfo | null {
	const root = raw as { status?: unknown; data?: Record<string, unknown> } | null;
	if (!root || Number(root.status) !== 200 || !root.data) return null;
	const data = root.data;
	const profile = (data.profileInfo ?? {}) as Record<string, unknown>;
	const liveData = (data.liveData ?? {}) as Record<string, unknown>;
	const flv = (((data.stream ?? {}) as Record<string, unknown>).flv ?? {}) as Record<string, unknown>;
	const multi = Array.isArray(flv.multiLine) ? (flv.multiLine as Record<string, unknown>[]) : [];
	const lines: HuyaLine[] = [];
	for (const item of multi) {
		const url = typeof item.url === 'string' ? item.url.trim() : '';
		if (!url) continue;
		lines.push({
			cdn: String(item.cdnType ?? ''),
			// 接口给的是 http://，在 https 页面上会被浏览器按混合内容拦掉，统一抬成 https。
			url: url.replace(/^http:\/\//i, 'https://'),
			priority: Number(item.webPriorityRate ?? 0) || 0,
		});
	}
	// 按接口自己的偏好排：虎牙网页播放器取的就是这个值最大的那条线。
	lines.sort((a, b) => b.priority - a.priority);
	return {
		live: String(data.liveStatus ?? '') === 'ON',
		owner: typeof profile.nick === 'string' ? profile.nick : undefined,
		title: typeof liveData.roomName === 'string' ? liveData.roomName : undefined,
		lines,
	};
}
