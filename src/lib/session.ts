import type { AstroCookies } from 'astro';
import { SESSION_SECRET } from 'astro:env/server';

/**
 * 登录会话：一个自己签名的 Cookie，服务端不存任何状态。
 *
 * 为什么是无状态签名而不是「服务端 session 表」：站点主体是静态站，登录只是附加能力，
 * 不该为了它引入数据库。无状态签名在 Node、Serverless、Workers 上行为完全一致。
 *
 * 为什么只用 Web Crypto：这里刻意不 import `node:crypto`。换 adapter 上 Cloudflare
 * Workers 时没有 Node 内置模块，用了 `node:crypto` 就得整层重写；`crypto.subtle`
 * 在 Node 18+ 与 Workers 都是全局可用的。
 *
 * 密钥没配、或短于 `MIN_SECRET_LENGTH` 时一律拒绝签发与校验，**不回退到默认密钥**——
 * 否则任何人都能用公开的默认值、或穷举出来的短密钥伪造出别人的登录态。
 */

export interface SessionUser {
	/** Valve 账号 id（32 位），也是 STRATZ 的 steamAccountId。 */
	accountId: number;
	/** SteamID64，字符串保存：超出 JS 安全整数范围，不能走 number。 */
	steamId: string;
	name: string;
	avatar: string;
	/** 签发时间与过期时间，Unix 秒。 */
	iat: number;
	exp: number;
}

export const SESSION_COOKIE = 'd2s_session';
/** 30 天。STRATZ 自己的 token 也是一年有效，这里取更短的窗口。 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;

/**
 * 密钥的最小长度。**只判"非空"是不够的。**
 *
 * 签名本身不是秘密（会话 Cookie 里就带着一个），所以任何人都能拿自己那份 Cookie 离线穷举密钥：
 * 十来个字符的密钥用现成字典跑一遍就能猜到，猜到之后就能伪造任意人的登录态。
 * README 给的生成方式是 `openssl rand -hex 32`（64 个字符），这里按它的一半取门槛，
 * 留出"自己随手敲一串"也能过的空间。
 */
const MIN_SECRET_LENGTH = 32;

export function sessionConfigured(): boolean {
	return typeof SESSION_SECRET === 'string' && SESSION_SECRET.trim().length >= MIN_SECRET_LENGTH;
}

// ---------------------------------------------------------------- 编解码

/** base64url，不带 padding。`btoa`/`atob` 在 Node 与 Workers 都是全局的。 */
function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
	try {
		const padded = text.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** 昵称可能是中文，签名对象必须先编码成 UTF-8 字节再转 base64。 */
function encodeText(text: string): string {
	return toBase64Url(new TextEncoder().encode(text));
}

function decodeText(text: string): string | null {
	const bytes = fromBase64Url(text);
	if (!bytes) return null;
	try {
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- 签名

let keyPromise: Promise<CryptoKey> | null = null;
let keyForSecret = '';

async function signingKey(): Promise<CryptoKey> {
	const secret = SESSION_SECRET ?? '';
	if (keyForSecret !== secret || !keyPromise) {
		keyForSecret = secret;
		keyPromise = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
	}
	return keyPromise;
}

/**
 * 定长比较，避免按字节提前返回把签名泄漏成旁路信道。
 *
 * 这里其实不是高价值目标（签名本身不是秘密、也拿不到部分匹配的反馈），但比较函数
 * 写成 `===` 是那种「以后被人复制到别处才出事」的写法，索性一次写对。
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function sign(payload: string): Promise<string> {
	const signature = await crypto.subtle.sign('HMAC', await signingKey(), new TextEncoder().encode(payload));
	return toBase64Url(new Uint8Array(signature));
}

// ---------------------------------------------------------------- 对外读写

export async function createSessionToken(user: Omit<SessionUser, 'iat' | 'exp'>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const session: SessionUser = { ...user, iat: now, exp: now + SESSION_MAX_AGE_SECONDS };
	const payload = encodeText(JSON.stringify(session));
	return `${payload}.${await sign(payload)}`;
}

/**
 * 校验并解出会话。任何一步不对（缺密钥、格式坏、签名不匹配、过期）都返回 null，
 * 调用方按「未登录」处理，不区分失败原因。
 */
export async function readSessionToken(token: string | undefined): Promise<SessionUser | null> {
	if (!token || !sessionConfigured()) return null;
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;

	const payload = token.slice(0, dot);
	const provided = fromBase64Url(token.slice(dot + 1));
	const expected = fromBase64Url(await sign(payload));
	if (!provided || !expected || !timingSafeEqual(provided, expected)) return null;

	const json = decodeText(payload);
	if (!json) return null;
	try {
		const session = JSON.parse(json) as SessionUser;
		if (typeof session.accountId !== 'number' || typeof session.exp !== 'number') return null;
		if (session.exp <= Math.floor(Date.now() / 1000)) return null;
		return session;
	} catch {
		return null;
	}
}

export function sessionCookieOptions(secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		// Lax 而不是 Strict：从 Steam 跳回来的那一次是跨站导航，
		// Strict 下浏览器不会带上 Cookie，回调后就认不出刚登录的人。
		sameSite: 'lax' as const,
		secure,
		maxAge: SESSION_MAX_AGE_SECONDS,
	};
}

export async function readSession(cookies: AstroCookies): Promise<SessionUser | null> {
	return readSessionToken(cookies.get(SESSION_COOKIE)?.value);
}

export async function writeSession(
	cookies: AstroCookies,
	user: Omit<SessionUser, 'iat' | 'exp'>,
	secure: boolean,
): Promise<void> {
	cookies.set(SESSION_COOKIE, await createSessionToken(user), sessionCookieOptions(secure));
}

export function clearSession(cookies: AstroCookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
