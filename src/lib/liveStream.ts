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
 *   因此也不再需要「服务端转发视频字节」那条路（`/api/live/proxy` 已删），
 *   `openDouyuStream()` 现在只服务于 `sampleStream()`。
 *
 * `probeStreamHeaders()` 同样只留给临时诊断端点 `/api/live/probe`（得显式 `&headers=1`）——
 * 它每探一次就消费掉那条一次性 token，所以默认不开。
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
	/** `getH5PlayV1` 的原始 data，排查用（不返回给普通用户）。 */
	raw?: Record<string, unknown>;
	/**
	 * `enc_data` 解出来的 op 字段。
	 *
	 * 这里藏着**斗鱼眼里的客户端 IP**（`op.ip`）与 `did`/`ts`/`ua`，签名时它们被一起签进去。
	 * 如果直链的 token 最终是按这个 IP 绑的，那「服务端解析、浏览器播放」就是天生不成立的
	 * ——两边 IP 不同。详见 `sampleStream()` 的注释。
	 */
	encInfo?: { did?: string; ip?: string; ts?: number; ua?: string; expireAt?: number };
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
	result.encInfo = decodeEncData(encPayload);

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
		result.raw = data;
		steps.push(`直链：${result.kind} ${result.url.slice(0, 120)}…`);
		return result;
	}

	return result;
}

/**
 * `enc_data` 是 base64 的 JSON，里面除了密钥信息还有 `op`（did / **客户端 IP** / ts / ua）。
 * 用 `atob`，不碰 `Buffer`——SSR 侧保持 Web 标准 API，换运行时不用重写。
 */
function decodeEncData(payload: string): DouyuResolve['encInfo'] {
	try {
		const json = JSON.parse(atob(payload)) as Record<string, unknown>;
		const op = (json.op ?? {}) as Record<string, unknown>;
		return {
			did: typeof op.did === 'string' ? op.did : undefined,
			ip: typeof op.ip === 'string' ? op.ip : undefined,
			ts: typeof op.ts === 'number' ? op.ts : undefined,
			ua: typeof op.ua === 'string' ? op.ua : undefined,
			expireAt: typeof json.expire_at === 'number' ? json.expire_at : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * 带着「平台自己那套头」去拉流，返回上游响应本体（不读 body）。
 *
 * 只给 `sampleStream()` 用，省得两处各写一份头——斗鱼对 `Referer`/`Origin`/UA 这一组很敏感，
 * 散开写迟早会漂。（原同源转发路由 `/api/live/proxy` 已删：直链不绑 IP，浏览器直连就够。）
 */
export async function openDouyuStream(url: string, signal?: AbortSignal): Promise<Response> {
	return fetch(url, {
		headers: {
			'user-agent': UA,
			referer: 'https://www.douyu.com/',
			origin: 'https://www.douyu.com',
		},
		redirect: 'follow',
		signal,
	});
}

export interface StreamSample {
	status: number;
	contentType?: string;
	allowOrigin?: string | null;
	finalHost?: string;
	/** 采样窗口内收到的字节数。 */
	bytes: number;
	chunks: number;
	/** 采样窗口还没走完、流就被服务端关掉了。 */
	ended: boolean;
	ms: number;
	error?: string;
}

/**
 * 把一条直链真拉一段时间，看它**能不能持续推**——这是「试看」和「真流」的唯一区分办法。
 *
 * 起因：斗鱼那条直链曾无论从 Node 还是浏览器、无论带什么 Referer/Origin/参数，都只给约
 * 400KB（一秒左右）就断；而斗鱼页面自己的播放器在**同一条地址**上能连续推 9.6MB/11 秒。
 * 当时的假设是「token 绑了 `enc_data` 里那个 IP」（见 `encInfo`），于是写了这个函数，
 * **在同一个进程里解析并采样**，用来验证这个假设。
 *
 * 假设已被推翻：实测在代理出口解析、再从另一个出口（直连）拉流照样持续推，直链**不绑 IP**；
 * 那批「只推一秒」的真正原因是**同一条地址被前面的诊断请求提前消费掉了**。它现在只服务于临时
 * 诊断端点 `/api/live/probe?sample=8000`：量一条地址到底能推多久。
 */
export async function sampleStream(url: string, ms = 8000): Promise<StreamSample> {
	const started = Date.now();
	try {
		const res = await openDouyuStream(url, AbortSignal.timeout(ms + 15_000));
		let bytes = 0;
		let chunks = 0;
		let ended = false;
		if (res.body) {
			const reader = res.body.getReader();
			while (Date.now() - started < ms) {
				const { value, done } = await Promise.race([
					reader.read(),
					new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 2000)),
				]);
				if (done) {
					ended = true;
					break;
				}
				if (value) {
					bytes += value.byteLength;
					chunks += 1;
				}
			}
			try {
				await reader.cancel();
			} catch {
				// cancel 失败无所谓，采样窗口已经到了。
			}
		}
		return {
			status: res.status,
			contentType: res.headers.get('content-type') ?? undefined,
			allowOrigin: res.headers.get('access-control-allow-origin'),
			finalHost: new URL(res.url).host,
			bytes,
			chunks,
			ended,
			ms: Date.now() - started,
		};
	} catch (e) {
		return {
			status: 0,
			bytes: 0,
			chunks: 0,
			ended: false,
			ms: Date.now() - started,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** 探针用：本进程看到的公网出口 IP（走代理时它和「直连」不是一个地址）。失败就算了。 */
export async function exitIp(): Promise<string | null> {
	for (const url of ['https://api.ipify.org/?format=json', 'https://ifconfig.me/ip']) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) continue;
			const text = (await res.text()).trim();
			const match = /"ip":"([^"]+)"/.exec(text) ?? [null, text];
			return match[1] ?? null;
		} catch {
			// 换下一个。
		}
	}
	return null;
}

export interface HeaderProbe {
	label: string;
	referer: string | null;
	status?: number;
	contentType?: string;
	/** 跨域能不能拉，全看这个头。 */
	allowOrigin?: string | null;
	contentRange?: string | null;
	/** 实测：斗鱼 CDN 第一跳是 302，得跟到最后一跳才算数（`finalHost` 会变）。 */
	finalHost?: string;
	redirected?: boolean;
	/** 真读回来的字节数——状态码 200 但 0 字节是另一回事。 */
	bytes?: number;
	error?: string;
}

/**
 * 拿真实直链去问 CDN 三个问题：**认不认别的 Referer、认不认空 Referer、给不给 CORS**。
 *
 * 三条变体各请求一次（只取 1KB，`Range` 头），把状态码和响应头原样带回来。
 * 这是「浏览器能不能直连」唯一的判据——`Access-Control-Allow-Origin` 存在且能匹配我们的源，
 * 浏览器直连才成立；否则只剩服务端转发（吃带宽）。
 *
 * 顺带一提：浏览器里这些头只有 `Origin`/`Referer` 相关能影响，而 `Referer` 属于禁用头
 * （改不了也伪造不了，只能靠 `referrerPolicy` 完全不发），所以这里模拟的就是
 * 「浏览器会发什么」：我们的源 + 正常 Referer、空 Referer（`no-referrer` 的效果），
 * 以及平台自己的 Referer（答「CDN 是否只认斗鱼」）。
 *
 * **必须跟完重定向**：实测斗鱼返回的第一跳是 302（`huos3.douyucdn2.cn` → 另一个 CDN 节点），
 * 只看第一跳会误判成「没给 206」。所以这里 `redirect: 'follow'`，并把最后一跳的 host 也报出来。
 */
export async function probeStreamHeaders(url: string, selfOrigin: string): Promise<HeaderProbe[]> {
	const variants: { label: string; referer: string | null }[] = [
		{ label: '平台 Referer（斗鱼自己）', referer: 'https://www.douyu.com/' },
		{ label: '我们的源 Referer（浏览器默认行为）', referer: `${selfOrigin}/` },
		{ label: '不带 Referer（no-referrer）', referer: null },
	];
	const out: HeaderProbe[] = [];
	for (const variant of variants) {
		const headers: Record<string, string> = {
			'user-agent': UA,
			origin: selfOrigin,
			range: 'bytes=0-1023',
		};
		if (variant.referer) headers.referer = variant.referer;
		try {
			const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
			const bytes = await res.arrayBuffer();
			out.push({
				label: variant.label,
				referer: variant.referer,
				status: res.status,
				contentType: res.headers.get('content-type') ?? undefined,
				allowOrigin: res.headers.get('access-control-allow-origin'),
				contentRange: res.headers.get('content-range'),
				finalHost: new URL(res.url).host,
				redirected: res.redirected,
				bytes: bytes.byteLength,
			});
		} catch (e) {
			out.push({
				label: variant.label,
				referer: variant.referer,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return out;
}
