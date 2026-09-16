#!/usr/bin/env node
/**
 * STRATZ 固定出口中转。
 *
 * ## 为什么需要它
 *
 * STRATZ 的 token **绑定调用方 IP**，换了出口就回 403
 * （`You cannot use different IP Addresses when using the API.`，纯文本、连 content-type 都没有）。
 * 而站点的两条取数路径都没有稳定出口：
 *
 * - **运行时的个人战绩**跑在 Cloudflare Workers 上，边缘出口按 colo 漂，今天能用明天可能就 403；
 * - **构建期**跑在开发机上，本机到 douyu / huya / i0.hdslb.com 的直连会被重置，所以平时挂着
 *   Clash 代理，而代理组一旦按延迟自动选节点，出口 IP 也跟着变。
 *
 * 于是把 token 交给**一台出口固定的机器**（自建服务器）持有：这个进程只做一件事——收下
 * `{query, variables}`，用它自己的出口转发给 STRATZ，再把响应原样带回来。调用方只跟它说话，
 * STRATZ 那边永远只看到一个 IP。
 *
 * ## 用法
 *
 * ```sh
 * STRATZ_TOKEN=<stratz.com/api 生成的 token> \
 * RELAY_TOKEN=<随便一串 32 字节以上随机值> \
 * node scripts/stratz-relay.mjs
 * ```
 *
 * 环境变量：
 * - `STRATZ_TOKEN`（必需）真正送给 STRATZ 的 token，只存在这台机器上；
 * - `RELAY_TOKEN`（必需）调用方要带的口令，**不放这个就是一扇开着的大门**，谁都能拿它烧你的额度；
 * - `HOST` / `PORT`（可选）默认 `127.0.0.1:8788`——交给 nginx / caddy 反代就不要再往外听；
 * - `STRATZ_UPSTREAM`（可选）默认官方 GraphQL 地址，只为测试留的开关。
 *
 * 端点：
 * - `POST /graphql` 头带 `x-relay-token: <RELAY_TOKEN>`，body 就是 STRATZ 的 `{query, variables}`，
 *   响应原样返回（状态码、正文都不改，调用方那套「403 是不是 IP 绑定」的判定因此还能用）；
 * - `GET /probe` 同样要口令，打一条最小的查询，回 `{status, body}`——**部署完先用它把 token
 *   绑到这台机器的出口上**，看到 `status: 200` 就说明绑定成功；
 * - `GET /healthz` 不需要口令，只回 `ok`，给监控用。
 *
 * 只转发到固定的上游、只认这两个路径、body 上限 256 KB：这不是一个通用代理。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8788);
const UPSTREAM = process.env.STRATZ_UPSTREAM ?? 'https://api.stratz.com/graphql';
const STRATZ_TOKEN = (process.env.STRATZ_TOKEN ?? '').trim();
const RELAY_TOKEN = (process.env.RELAY_TOKEN ?? '').trim();

/** 调用方那套判定靠正文内容，转发时连状态码一起原样带回去。 */
const FORWARD_HEADERS = {
	'Content-Type': 'application/json',
	Accept: 'application/json',
	// STRATZ 接口前面挂着 Cloudflare，只放行官方文档指定的这个 UA，改了会被挑战页拦。
	'User-Agent': 'STRATZ_API',
};

const MAX_BODY_BYTES = 256 * 1024;
/** 请求体是 JSON，不是任意字节流；GraphQL 查询里不会出现这些控制字符。 */
const MAX_QUERY_CHARS = 64 * 1024;

if (!STRATZ_TOKEN || !RELAY_TOKEN) {
	console.error('缺少 STRATZ_TOKEN 或 RELAY_TOKEN，拒绝启动（不配口令的中转等于开放代理）');
	process.exit(1);
}
if (RELAY_TOKEN.length < 24) {
	console.error('RELAY_TOKEN 太短，至少 24 个字符（建议 `openssl rand -hex 32`）');
	process.exit(1);
}

/**
 * 定长比较：先各自 sha256 再比，这样比较耗时与口令长度无关。
 * 直接用 `===` 比字符串会在第一个不同字节就返回，等于把口令按字节泄露出去。
 *
 * @param {unknown} given
 * @param {string} expected
 */
function tokenMatches(given, expected) {
	if (typeof given !== 'string' || given.length === 0) return false;
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * 读完请求体，超过上限就中止——不设上限的话任何人扔一个 10 GB 的 body 就能把内存吃光。
 *
 * 只有「声明了 Content-Length 且超限」那条路能干净地回 413（在 handler 里先判），
 * 走到这里的超限属于 chunked 硬灌，只能把连接拆掉。
 *
 * @param {import('node:http').IncomingMessage} req
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
function send(res, status, body, headers = {}) {
	res.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(body);
}

/**
 * 转发一次请求，返回上游的状态码与正文。**不做任何重试**：调用方自己那层已经有重试与
 * 「403 到底是不是 IP 绑定」的分类逻辑，中转再插一层重试只会让限速更难看清。
 *
 * @param {string} body
 * @returns {Promise<{ status: number, body: string, contentType: string }>}
 */
async function forward(body) {
	const res = await fetch(UPSTREAM, {
		method: 'POST',
		signal: AbortSignal.timeout(30_000),
		headers: { ...FORWARD_HEADERS, Authorization: `Bearer ${STRATZ_TOKEN}` },
		body,
	});
	return {
		status: res.status,
		body: await res.text(),
		contentType: res.headers.get('content-type') ?? 'application/json; charset=utf-8',
	};
}

const server = createServer(async (req, res) => {
	const started = Date.now();
	const url = new URL(req.url ?? '/', `http://${HOST}`);

	// 监控用，不带口令也不打上游——它不能变成「每次探活都消耗一次额度」的东西。
	if (req.method === 'GET' && url.pathname === '/healthz') {
		send(res, 200, 'ok');
		return;
	}

	if (url.pathname !== '/graphql' && url.pathname !== '/probe') {
		send(res, 404, 'not found');
		return;
	}
	if (!tokenMatches(req.headers['x-relay-token'], RELAY_TOKEN)) {
		send(res, 401, 'unauthorized');
		return;
	}

	/** @type {string} */
	let body;
	if (req.method === 'POST' && url.pathname === '/graphql') {
		/*
		 * 先看声明的长度：超了就**在读之前**回 413 并关连接。等流读到一半再拆 socket 的话，
		 * 响应根本写不出去，客户端只会看到 "Empty reply from server"（实测过）。
		 */
		const declared = Number(req.headers['content-length'] ?? 0);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			send(res, 413, 'body too large', { Connection: 'close' });
			return;
		}
		try {
			body = await readBody(req);
		} catch {
			send(res, 413, 'body too large');
			return;
		}
	} else if (req.method === 'GET' && url.pathname === '/probe') {
		// 最小的合法查询：真正的目的是「用这台机器的出口认证一次」，把 token 绑到这里的 IP 上。
		body = JSON.stringify({ query: '{ __typename }' });
	} else {
		send(res, 405, 'method not allowed');
		return;
	}

	try {
		const query = JSON.parse(body)?.query;
		if (typeof query !== 'string' || query.length > MAX_QUERY_CHARS) {
			send(res, 400, 'bad request');
			return;
		}
	} catch {
		send(res, 400, 'bad request');
		return;
	}

	try {
		const result = await forward(body);
		console.log(
			`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${result.status} ` +
				`${Date.now() - started}ms ${Buffer.byteLength(result.body)}B`,
		);
		if (url.pathname === '/probe') {
			send(
				res,
				200,
				JSON.stringify({ status: result.status, body: result.body.slice(0, 300) }, null, 2),
				{ 'Content-Type': 'application/json; charset=utf-8' },
			);
			return;
		}
		send(res, result.status, result.body, { 'Content-Type': result.contentType });
	} catch (error) {
		// 这台机器到 STRATZ 自己断了：回 502，让调用方按「上游故障」重试，而不是伪装成 4xx。
		console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> 502 ${Date.now() - started}ms`);
		send(res, 502, `relay 无法连上上游：${error instanceof Error ? error.message : String(error)}`);
	}
});

server.listen(PORT, HOST, () => {
	console.log(`stratz-relay 监听 http://${HOST}:${PORT}（上游 ${UPSTREAM}）`);
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
	process.on(signal, () => {
		console.log(`${signal}：停止监听`);
		server.close(() => process.exit(0));
	});
}
