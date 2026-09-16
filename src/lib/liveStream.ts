import { md5Hex } from './md5';

/**
 * 直播**直链**解析（只在服务端跑）。
 *
 * 和 `liveApi.ts` 的区别：那个抓的是「谁在播」，这个拿的是「画面从哪来」——分屏页的斗鱼格子
 * 用它解出的直链自己播 `<video>`，不再嵌平台整页再 `transform` 裁切（见 README 的
 * 「分屏页的画面：斗鱼直链、虎牙官方播放器、兜底取景」）。解析失败时才退回那条取景兜底路。
 *
 * ## 斗鱼这条路是哪来的
 *
 * 现在的流程（streamlink 2026 年重新启用的那条，**不需要跑平台 JS**）：
 *
 * 1. `GET douyu.com/betard/{rid}` 拿房间信息；
 * 2. `GET douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did={did}` 拿 `key` / `rand_str` /
 *    `enc_time` / `enc_data` / `is_special`；
 * 3. 签名是一串 **纯 MD5** 链（见 `douyuAuth()`），不需要 `ub98484234` 那段混淆 JS
 *    —— 这一点很关键：老流程（`swf_api/homeH5Enc` 拿 JS 源码再执行）逼着客户端带一个
 *    JS 运行时（SimpleLive 为此塞了 48KB 的 `douyu_sign.dart` + QuickJS），新流程在
 *    Node / Workers 里几个 `md5Hex()` 就完了，本文件因此可以只依赖 `./md5`。
 * 4. `POST douyu.com/lapi/live/getH5PlayV1/{rid}`（`enc_data`/`tt`/`did`/`auth`/`cdn`/`rate`/
 *    `hevc`/`fa`/`ive`）→ `data.rtmp_url` + `data.rtmp_live` + `data.multirates`。
 *    播放地址就是 `${rtmp_url}/${rtmp_live}`，后缀决定是 flv 还是 m3u8。
 *
 * 老流程没删，是因为新流程可能被斗鱼按房间/分区灰度关掉；真碰上了再补一个
 * `node:vm` 版本（**注意那只在 Node 上可用，Cloudflare Workers 上要换实现**）。
 *
 * ## 直链的三条性质（**都实测过，别再当待验证**）
 *
 * - **一次性**：同一个 token 第一次拉能一直推（实测 6 秒 11MB），第二次只剩约 400KB 就断。
 *   重试、重播、换清晰度都必须重新解析，浏览器在播之前也不能拿它去探测/预加载。
 * - **有效期很短**：解析完等 25 秒再拉就已经断（1 秒内没事），所以只能「点了才解析、解析完立刻播」。
 * - **不绑 IP**：代理出口解析、直连出口拉流照样持续推，所以服务器放哪儿都行；斗鱼 CDN 给
 *   `Access-Control-Allow-Origin: *`，浏览器**直连**即可，视频字节不过我们的服务器。
 *   因此也不再需要「服务端转发视频字节」那条路（`/api/live/proxy` 已删）。
 *
 * 为了验证上面这几条而写的诊断代码（`/api/live/probe` 端点，以及配套的 `probeStreamHeaders()` /
 * `sampleStream()`）已经删掉：它每探一次就消费掉那条一次性 token，且在生产上等于开放一个
 * 「查任意房间直链」的入口。结论都记在 README 的「分屏页的画面」一节。
 */

/** 斗鱼的风控对 UA 敏感，用一个真实的桌面 Chrome。 */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 签名里要带的设备号。streamlink 每次进程起一个随机的，这里照做。 */
const DID = randomDid();

function randomDid(): string {
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function douyuHeaders(roomId: string): Record<string, string> {
	return {
		referer: `https://www.douyu.com/${roomId}`,
		'user-agent': UA,
		accept: 'application/json, text/plain, */*',
	};
}

/** 抓 JSON。**不抛异常**——调用方要的是「哪一步失败了」，不是 500。 */
async function getJson(
	url: string,
	headers: Record<string, string>,
): Promise<{ data?: Record<string, unknown>; error?: string }> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
		const text = await res.text();
		if (!res.ok) return { error: `HTTP ${res.status}：${text.slice(0, 200)}` };
		try {
			return { data: JSON.parse(text) as Record<string, unknown> };
		} catch {
			return { error: `不是 JSON（前 200 字）：${text.slice(0, 200)}` };
		}
	} catch (e) {
		// 本机到 douyu.com 的 TLS 握手会被重置，走到的就是这一支（SSL_ERROR_SYSCALL）。
		return { error: `请求失败：${e instanceof Error ? e.message : String(e)}` };
	}
}

export interface DouyuQuality {
	name: string;
	rate: number;
	bit?: number;
}

export interface DouyuResolve {
	roomId: string;
	/** 平台自己给的开播状态（`betard` 里的 `show_status`）。 */
	live: boolean;
	owner?: string;
	title?: string;
	/** 拿到的播放地址（没拿到就是 undefined）。 */
	url?: string;
	kind?: 'flv' | 'm3u8';
	quality?: string;
	qualities: DouyuQuality[];
	/** 逐步执行的记录，失败时用来定位卡在哪一步。 */
	steps: string[];
	errors: string[];
}

/**
 * 斗鱼的 `auth`：`f = rand_str` 迭代 `enc_time` 次 `md5(f + key)`，最后再挂上房间号与秒级时间戳。
 * `is_special === 1` 时不挂房间号（特殊房间，实测少见）。
 */
function douyuAuth(key: string, randStr: string, encTime: number, isSpecial: number, roomId: string, ts: number): string {
	let f = randStr;
	for (let i = 0; i < encTime; i++) f = md5Hex(f + key);
	return md5Hex(f + key + (isSpecial === 1 ? '' : roomId + ts));
}

/**
 * 解析一个斗鱼房间的播放直链。
 *
 * 参数默认值**照抄斗鱼页面自己那次「真正播放」的调用**（在无头 Chrome 里抓到的）：
 * `cdn=hw-h5&ver=Douyu_new&rate=0&iar=0&ive=0&sov=0&hevc=0&fa=0`。
 * 页面第一次探测用的是 `cdn=&rate=-1`（没有 `iar`/`sov`）——那种「空 cdn」的令牌实测只给
 * 约 420KB 就断流，而播放器自己那条连接能持续推 9.6MB/11 秒，所以这里按播放器那套发。
 *
 * `rate` 可以给多个值逐个试（`0` 是原画）。
 */
export async function resolveDouyu(
	roomId: string,
	opts: { rate?: number[]; cdn?: string; ver?: string } = {},
): Promise<DouyuResolve> {
	const steps: string[] = [];
	const errors: string[] = [];
	const result: DouyuResolve = { roomId, live: false, qualities: [], steps, errors };
	const rates = opts.rate ?? [0, -1];
	const cdn = opts.cdn ?? 'hw-h5';
	const ver = opts.ver ?? 'Douyu_new';

	const betard = await getJson(`https://www.douyu.com/betard/${roomId}`, douyuHeaders(roomId));
	if (betard.error) errors.push(`betard：${betard.error}`);
	const room = (betard.data?.room ?? {}) as Record<string, unknown>;
	if (betard.data) {
		result.live = room.show_status === 1 && room.videoLoop !== 1;
		result.owner = typeof room.owner_name === 'string' ? room.owner_name : undefined;
		result.title = typeof room.room_name === 'string' ? room.room_name : undefined;
		steps.push(
			`betard: show_status=${String(room.show_status)} videoLoop=${String(room.videoLoop)} room_id=${String(room.room_id)}`,
		);
	}

	const enc = await getJson(
		`https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${DID}`,
		douyuHeaders(roomId),
	);
	if (enc.error) {
		errors.push(`getEncryption：${enc.error}`);
		return result;
	}
	const encData = (enc.data?.data ?? enc.data) as Record<string, unknown> | undefined;
	const key = typeof encData?.key === 'string' ? encData.key : '';
	const randStr = typeof encData?.rand_str === 'string' ? encData.rand_str : '';
	const encTime = Number(encData?.enc_time ?? 0);
	const encPayload = typeof encData?.enc_data === 'string' ? encData.enc_data : '';
	const isSpecial = Number(encData?.is_special ?? 0);
	if (!key || !randStr || !encPayload) {
		errors.push(`getEncryption 返回的形状不对：${JSON.stringify(enc.data).slice(0, 300)}`);
		return result;
	}
	steps.push(`getEncryption: enc_time=${encTime} is_special=${isSpecial} key=${key.slice(0, 6)}…`);

	for (const rate of rates) {
		const ts = Math.floor(Date.now() / 1000);
		const auth = douyuAuth(key, randStr, encTime, isSpecial, roomId, ts);
		const body = new URLSearchParams({
			enc_data: encPayload,
			tt: String(ts),
			did: DID,
			auth,
			cdn,
			ver,
			rate: String(rate),
			iar: '0',
			ive: '0',
			sov: '0',
			hevc: '0',
			fa: '0',
		});
		let res: Response;
		try {
			res = await fetch(`https://www.douyu.com/lapi/live/getH5PlayV1/${roomId}`, {
				method: 'POST',
				headers: {
					...douyuHeaders(roomId),
					'content-type': 'application/x-www-form-urlencoded',
					origin: 'https://www.douyu.com',
				},
				body,
				signal: AbortSignal.timeout(15_000),
			});
		} catch (e) {
			errors.push(`getH5PlayV1(rate=${rate})：请求失败：${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		const text = await res.text();
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(text) as Record<string, unknown>;
		} catch {
			errors.push(`getH5PlayV1(rate=${rate})：HTTP ${res.status}，不是 JSON：${text.slice(0, 200)}`);
			continue;
		}
		const data = (json.data ?? {}) as Record<string, unknown>;
		const rtmpUrl = typeof data.rtmp_url === 'string' ? data.rtmp_url : '';
		const rtmpLive = typeof data.rtmp_live === 'string' ? data.rtmp_live : '';
		const rates0 = Array.isArray(data.multirates) ? (data.multirates as Record<string, unknown>[]) : [];
		if (rates0.length > 0 && result.qualities.length === 0) {
			result.qualities = rates0.map((item) => ({
				name: String(item.name ?? ''),
				rate: Number(item.rate ?? 0),
				bit: Number.isFinite(Number(item.bit)) ? Number(item.bit) : undefined,
			}));
		}
		steps.push(`getH5PlayV1(rate=${rate}): HTTP ${res.status} error=${String(json.error ?? '?')} msg=${String(json.msg ?? '')}`);
		if (!rtmpUrl || !rtmpLive) {
			errors.push(`getH5PlayV1(rate=${rate}) 没给地址：${JSON.stringify(json).slice(0, 300)}`);
			continue;
		}
	result.url = `${rtmpUrl.replace(/\/$/, '')}/${rtmpLive}`;
	result.kind = result.url.includes('.m3u8') ? 'm3u8' : 'flv';
	result.quality = result.qualities.find((q) => q.rate === rate)?.name ?? `rate=${rate}`;
	steps.push(`直链：${result.kind} ${result.url.slice(0, 120)}…`);
	return result;
}

	return result;
}
