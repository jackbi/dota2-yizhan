/**
 * Steam OpenID 2.0 登录。
 *
 * 只需要 OpenID，**不需要 Steam Web API Key**：登录拿到的 SteamID64 已经足够，
 * 昵称与头像由 STRATZ 的 `steamAccount` 一并返回，少一个密钥要管。
 *
 * 流程：跳去 Steam 的 checkid_setup → Steam 带 openid.* 参数跳回本站回调 →
 * 本站把这些参数原样 POST 回 Steam 的 check_authentication 换一个 `is_valid:true`。
 * 关键点是**必须回 Steam 反查**：回调参数是用户可控的，光看 claimed_id 就直接
 * 发会话等于任何人都能伪造登录。
 */

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

/** identifier_select：让 Steam 自己决定用哪个身份，也是唯一被支持的取值。 */
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/** SteamID64 的固定偏移：之前是账号创建序号，之后才是 32 位账号 id。 */
const STEAM_ID64_BASE = 76561197960265728n;

export interface SteamIdentity {
	/** SteamID64，字符串：超过 Number.MAX_SAFE_INTEGER。 */
	steamId: string;
	/** Valve 账号 id，STRATZ / OpenDota 都用它。 */
	accountId: number;
}

export function buildLoginUrl(returnTo: string, realm: string): string {
	const url = new URL(STEAM_OPENID_ENDPOINT);
	url.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
	url.searchParams.set('openid.mode', 'checkid_setup');
	url.searchParams.set('openid.return_to', returnTo);
	url.searchParams.set('openid.realm', realm);
	url.searchParams.set('openid.identity', IDENTIFIER_SELECT);
	url.searchParams.set('openid.claimed_id', IDENTIFIER_SELECT);
	return url.toString();
}

/**
 * 把回调参数交回 Steam 反查。
 *
 * 逐条校验而不只看 Steam 的回复：
 * - `op_endpoint` 必须是真 Steam，否则可能是别的 OpenID 提供方伪造的断言；
 * - `return_to` 必须与本机生成的完全一致，避免把针对别的站点的断言拿来用；
 * - `claimed_id` 必须匹配 Steam 的 id URL 形状，才能安全地抽出数字。
 */
export async function verifySteamAssertion(params: URLSearchParams, expectedReturnTo: string): Promise<SteamIdentity | null> {
	if (params.get('openid.mode') !== 'id_res') return null;
	if (params.get('openid.op_endpoint') !== STEAM_OPENID_ENDPOINT) return null;
	if (params.get('openid.return_to') !== expectedReturnTo) return null;

	const claimedId = params.get('openid.claimed_id') ?? '';
	const matched = CLAIMED_ID_RE.exec(claimedId);
	if (!matched) return null;

	// 回查的 body 就是原样带回的 openid.* 参数，只把 mode 换成 check_authentication。
	const body = new URLSearchParams();
	for (const [key, value] of params) {
		if (key.startsWith('openid.')) body.set(key, value);
	}
	body.set('openid.mode', 'check_authentication');

	try {
		const res = await fetch(STEAM_OPENID_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
			body: body.toString(),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		// 正常回复形如 "ns:...\nis_valid:true\n"，逐行比对而不是 includes，
		// 免得 "is_valid:false" 里的子串把结果带偏。
		const valid = (await res.text())
			.split('\n')
			.some((line) => line.trim().toLowerCase() === 'is_valid:true');
		if (!valid) return null;
	} catch {
		// 网络问题按「验证不通过」处理：宁可不给会话，也不能放进来路不明的人。
		return null;
	}

	const steamId = matched[1];
	return { steamId, accountId: steamId64ToAccountId(steamId) };
}

export function steamId64ToAccountId(steamId: string): number {
	return Number(BigInt(steamId) - STEAM_ID64_BASE);
}

export function accountIdToSteamId64(accountId: number): string {
	return (BigInt(accountId) + STEAM_ID64_BASE).toString();
}

// ---------------------------------------------------------------- 用户手填的 ID

/**
 * 用户手填的 Steam 标识解析。
 *
 * 开黑房间允许「不登录、只填自己的 Steam ID」来换取昵称和头像。用户手上那串东西
 * 形式很杂，这里统一收口成 accountId：
 *
 * - **SteamID64**：17 位、以 7656119 开头（个人资料页地址栏里 `/profiles/` 后面那串）；
 * - **账号 id**：32 位整数，也是 Steam 新版好友码（8～10 位数字）本身；
 * - **`STEAM_X:Y:Z`**：老格式，accountId = `Z × 2 + Y`；
 * - **`[U:1:Z]`**：SteamID3，Z 就是 accountId。
 *
 * **不支持 `/id/<自定义短名>`**：把短名换算成 SteamID64 要走 Steam Web API 的
 * `ResolveVanityURL`，那需要一个 API Key——本站登录只用 OpenID，刻意没有引入这个密钥，
 * 为了一个头像再加一个密钥不划算。所以那种链接直接告诉用户去哪儿复制。
 */
export type SteamIdParse = { ok: true; accountId: number; steamId: string } | { ok: false; error: string };

const STEAMID64_RE = /^7656119\d{10}$/;
/** accountId 是 32 位无符号整数，SteamID64 的第 33 位起才是账号创建序号。 */
const ACCOUNT_ID_MAX = 0xffff_ffff;

function fromAccountId(accountId: number): SteamIdParse {
	if (!Number.isSafeInteger(accountId) || accountId <= 0 || accountId > ACCOUNT_ID_MAX) {
		return { ok: false, error: '这个账号 ID 超出范围了（应该是 32 位以内的整数）' };
	}
	return { ok: true, accountId, steamId: accountIdToSteamId64(accountId) };
}

function fromSteamId64(steamId: string): SteamIdParse {
	try {
		const parsed = fromAccountId(steamId64ToAccountId(steamId));
		return parsed.ok ? { ...parsed, steamId } : parsed;
	} catch {
		return { ok: false, error: '这串 SteamID64 不合法' };
	}
}

export function parseSteamIdInput(raw: string): SteamIdParse {
	const input = raw.trim();
	if (!input) return { ok: false, error: '请填写 Steam ID 或个人资料链接' };

	const profileUrl = /steamcommunity\.com\/profiles\/(\d{17})/i.exec(input);
	if (profileUrl) return fromSteamId64(profileUrl[1]);
	if (/steamcommunity\.com\/id\//i.test(input)) {
		return {
			ok: false,
			error: '自定义短名链接换算不出 Steam ID：打开个人资料页，复制地址栏里 /profiles/ 后面那串 17 位数字',
		};
	}

	const legacy = /^STEAM_[0-5]:([01]):(\d+)$/i.exec(input);
	if (legacy) return fromAccountId(Number(legacy[2]) * 2 + Number(legacy[1]));

	const steamId3 = /^\[U:1:(\d+)\]$/.exec(input);
	if (steamId3) return fromAccountId(Number(steamId3[1]));

	if (!/^\d+$/.test(input)) {
		return { ok: false, error: '认不出这个格式：可以填 17 位 SteamID64、账号 ID（好友码），或 /profiles/ 链接' };
	}
	// 17 位且形状对得上才是 SteamID64；否则一律当账号 id——好友码和账号 id 就是同一个数。
	return STEAMID64_RE.test(input) ? fromSteamId64(input) : fromAccountId(Number(input));
}

/**
 * 登录跳转期间暂存 state 的 Cookie。
 *
 * 放在这里而不是某条路由里：签发（login）与校验（callback）分处两个文件，
 * 名字只有一份才不会被改单边。
 */
export const LOGIN_STATE_COOKIE = 'd2s_login_state';
/** state 只活 10 分钟：够走完 Steam 授权，又不至于长期留着。 */
export const LOGIN_STATE_MAX_AGE_SECONDS = 600;

/** 登录跳转用的随机串，挡「把别人账号登到自己浏览器上」的登录 CSRF。 */
export function randomState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
