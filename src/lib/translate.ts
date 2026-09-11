import { createHash } from 'node:crypto';
import { createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 翻译层：构建期把英文内容翻成简体中文。
 *
 * 默认走有道网页版接口（参考 hengran-family-butler 的 fanyi 模块）——它靠网页端签名
 * 与 AES 响应解密，不需要任何凭证；配了 AZURE_TRANSLATOR_KEY 时改用微软翻译，
 * 那是官方接口，更稳但需要订阅密钥。
 *
 * 译文按「原文 + 目标语言」的哈希永久落盘，只有新内容才会真正发请求；
 * 任何一步失败都返回 null，由调用方决定退回原文。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'translate');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const REQUEST_INTERVAL_MS = 250;
/** 单次请求的字符上限，超长正文会按句子切开分多次翻。 */
const CHUNK_LIMIT = 1000;
/** 有道网页版接口要带上浏览器 UA、referer 与这两个 cookie，缺一个就返回 code 50。 */
const BROWSER_HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
	referer: 'https://fanyi.youdao.com/',
	cookie: 'OUTFOX_SEARCH_USER_ID_NCOO=2100336809.6038957; OUTFOX_SEARCH_USER_ID=711138426@112.20.94.181',
};
/** 网页端固定的两把密钥，用来解密响应，不是账号凭证。 */
const YOUDAO_AES_KEY = 'ydsecret://query/key/B*RGygVywfNBwpmBaZg*WT7SIOUP2T0C9WHMZN39j^DAdaZhAnxvGcCY6VYFwnHl';
const YOUDAO_AES_IV = 'ydsecret://query/iv/C@lZe2YzHtZ2CYgaXKSVfsb7Y4QWHjITPPZ0nQp87fBeJ!Iv6v^6fvi2WN@bYpJ4';

function md5(value: string, encoding: 'hex' | 'buffer' = 'hex'): string | Buffer {
	return createHash('md5').update(value).digest(encoding);
}

function providerName(): 'azure' | 'youdao' {
	return process.env.AZURE_TRANSLATOR_KEY ? 'azure' : 'youdao';
}

// ---------------------------------------------------------------- 缓存

const memory = new Map<string, string | null>();

function cacheFile(text: string): string {
	const hash = createHash('sha1').update(`${providerName()}:zh:${text}`).digest('hex');
	return path.join(CACHE_DIR, `${hash}.txt`);
}

async function readCached(text: string): Promise<string | null | undefined> {
	if (memory.has(text)) return memory.get(text);
	try {
		return await fs.readFile(cacheFile(text), 'utf8');
	} catch {
		return undefined;
	}
}

async function writeCached(text: string, value: string): Promise<void> {
	memory.set(text, value);
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await fs.writeFile(cacheFile(text), value, 'utf8');
}

// ---------------------------------------------------------------- 分段与限速

/** 按行聚合到接近上限，单行过长时再按句号/空格切开。 */
function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
	const chunks: string[] = [];
	let current = '';
	const flush = () => {
		if (current.trim()) chunks.push(current.trim());
		current = '';
	};
	for (const rawLine of text.split('\n')) {
		let line = rawLine;
		while (line.length > limit) {
			flush();
			const cut = Math.max(line.lastIndexOf('. ', limit), line.lastIndexOf('。', limit), line.lastIndexOf(' ', limit));
			const at = cut > limit * 0.5 ? cut + 1 : limit;
			chunks.push(line.slice(0, at).trim());
			line = line.slice(at);
		}
		if (current && current.length + line.length + 1 > limit) flush();
		current = current ? `${current}\n${line}` : line;
	}
	flush();
	return chunks;
}

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** 串行化请求，两次之间留一点间隔。 */
function pace<T>(run: () => Promise<T>): Promise<T> {
	const next = queue.then(async () => {
		const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastRequestAt = Date.now();
		return run();
	});
	queue = next.catch(() => undefined);
	return next;
}

// ---------------------------------------------------------------- 有道网页版

async function youdaoSecretKey(): Promise<string | null> {
	const now = String(Date.now());
	const params = new URLSearchParams({
		keyid: 'webfanyi-key-getter',
		sign: md5(`client=fanyideskweb&mysticTime=${now}&product=webfanyi&key=asdjnjfenknafdfsdfsd`) as string,
		client: 'fanyideskweb',
		product: 'webfanyi',
		appVersion: '1.0.0',
		vendor: 'web',
		pointParam: 'client,mysticTime,product',
		mysticTime: now,
		keyfrom: 'fanyi.web',
	});
	try {
		const response = await fetch(`https://dict.youdao.com/webtranslate/key?${params}`, {
			headers: BROWSER_HEADERS,
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { data?: { secretKey?: string } };
		return data.data?.secretKey ?? null;
	} catch {
		return null;
	}
}

/** 响应是 AES-128-CBC 加密的 base64，key/iv 都是那两串固定值的 md5。 */
function youdaoDecode(payload: string): { code?: number; translateResult?: { tgt?: string }[][] } | null {
	try {
		const decipher = createDecipheriv(
			'aes-128-cbc',
			md5(YOUDAO_AES_KEY, 'buffer') as Buffer,
			md5(YOUDAO_AES_IV, 'buffer') as Buffer,
		);
		const json = decipher.update(payload, 'base64', 'utf8') + decipher.final('utf8');
		return JSON.parse(json);
	} catch {
		return null;
	}
}

async function youdaoTranslate(text: string): Promise<string | null> {
	return pace(async () => {
		const secretKey = await youdaoSecretKey();
		if (!secretKey) return null;
		const now = String(Date.now());
		const body = new URLSearchParams({
			from: 'en',
			to: 'zh-CHS',
			i: text,
			dictResult: 'true',
			keyid: 'webfanyi',
			sign: md5(`client=fanyideskweb&mysticTime=${now}&product=webfanyi&key=${secretKey}`) as string,
			client: 'fanyideskweb',
			product: 'webfanyi',
			appVersion: '1.0.0',
			vendor: 'web',
			pointParam: 'client,mysticTime,product',
			mysticTime: now,
			keyfrom: 'fanyi.web',
		});
		try {
			const response = await fetch('https://dict.youdao.com/webtranslate', {
				method: 'POST',
				headers: { ...BROWSER_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
				body,
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) return null;
			const data = youdaoDecode(await response.text());
			if (!data || data.code !== 0 || !data.translateResult) return null;
			const text = data.translateResult.flat().map((item) => item.tgt ?? '').join('');
			return text.trim() ? text : null;
		} catch {
			return null;
		}
	});
}

// ---------------------------------------------------------------- 微软翻译

async function azureTranslate(text: string): Promise<string | null> {
	const key = process.env.AZURE_TRANSLATOR_KEY;
	if (!key) return null;
	const region = process.env.AZURE_TRANSLATOR_REGION;
	return pace(async () => {
		try {
			const response = await fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans', {
				method: 'POST',
				headers: {
					'Ocp-Apim-Subscription-Key': key,
					'Content-Type': 'application/json',
					...(region ? { 'Ocp-Apim-Subscription-Region': region } : {}),
				},
				body: JSON.stringify([{ Text: text }]),
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) return null;
			const data = (await response.json()) as { translations?: { text?: string }[] }[];
			const translated = data?.[0]?.translations?.[0]?.text;
			return translated?.trim() ? translated : null;
		} catch {
			return null;
		}
	});
}

// ---------------------------------------------------------------- 对外接口

/**
 * 翻成简体中文。命中缓存直接返回；失败返回 null。
 * 超长文本按句切成多段分别翻译后用换行拼回。
 */
export async function translateToChinese(text: string): Promise<string | null> {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const cached = await readCached(trimmed);
	if (cached !== undefined) return cached;
	if (OFFLINE) return null;

	const translate = providerName() === 'azure' ? azureTranslate : youdaoTranslate;
	const parts: string[] = [];
	for (const chunk of chunkText(trimmed)) {
		const translated = await translate(chunk);
		if (translated === null) return null;
		parts.push(translated.trim());
	}
	const result = parts.join('\n').trim();
	if (!result) return null;

	await writeCached(trimmed, result);
	return result;
}
