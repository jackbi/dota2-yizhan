/**
 * MCP 的 stdio 服务端，手写、零依赖。
 *
 * 为什么不用 `@modelcontextprotocol/sdk`：它的直接依赖有十七个（express、hono、jose、ajv、
 * cors…），而这台服务只需要 stdio 上的四个方法。多出来的依赖会实打实拖慢 `npx` 的冷启动，
 * 对一个「一行接入」的工具来说不划算。代价是协议要自己跟——所以这里只实现**确定要用到**的部分，
 * 并且把不支持的能力明确报错，不装作支持。
 *
 * 传输是 LSP 那套：一行一条 JSON-RPC 消息，UTF-8，`\n` 分隔。
 * **stdout 只走协议**，日志一律去 stderr，否则会把客户端的解析器冲掉。
 */

import { createInterface } from 'node:readline';

/** 能谈的协议版本，从新到旧。客户端给哪个就回哪个，都不认识就用第一个。 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const JSON_RPC = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
};

/** 校验 tool 入参。只做 JSON Schema 里实际用到的那几种类型，够用且不会误判。 */
function checkSchema(schema, args) {
	const properties = schema.properties ?? {};
	const problems = [];

	if (schema.required) {
		for (const key of schema.required) {
			if (args[key] === undefined) problems.push(`缺少必填参数 ${key}`);
		}
	}

	for (const [key, value] of Object.entries(args)) {
		const rule = properties[key];
		if (!rule || value === undefined || value === null) continue;
		if (rule.type === 'string' && typeof value !== 'string') problems.push(`${key} 应该是字符串`);
		if (rule.type === 'integer' && !Number.isInteger(value)) problems.push(`${key} 应该是整数`);
		if (rule.type === 'number' && typeof value !== 'number') problems.push(`${key} 应该是数字`);
		if (rule.type === 'array' && !Array.isArray(value)) problems.push(`${key} 应该是数组`);
		if (rule.type === 'array' && Array.isArray(value) && rule.items?.type === 'string') {
			if (value.some((item) => typeof item !== 'string')) problems.push(`${key} 的元素应该都是字符串`);
		}
		if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')}`);
	}
	return problems;
}

export function createServer({ name, version, tools, log = () => {} }) {
	const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

	/** 处理一条消息，返回要发回去的响应；通知返回 null。 */
	async function handle(message) {
		if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
		const { id, method, params } = message;
		// 没有 id 就是通知：执行但不回消息。
		const isNotification = id === undefined || id === null;
		const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
		const fail = (code, message_, data) =>
			isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: message_, ...(data ? { data } : {}) } };

		switch (method) {
			case 'initialize': {
				const asked = params?.protocolVersion;
				const agreed = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
				return ok({
					protocolVersion: agreed,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name, version },
					instructions:
						'这些工具查的是 DOTA2 驿站（https://dota2.hiwenbin.com）构建期抓取并整理的实测数据。' +
						'所有胜率与场次都请原样引用；数据每隔约 30 分钟重建一次，工具输出里带着抓取时间。',
				});
			}
			case 'notifications/initialized':
			case 'notifications/cancelled':
				return null;
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({
					tools: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				});
			case 'tools/call': {
				const toolName = params?.name;
				const tool = toolMap.get(toolName);
				if (!tool) return fail(JSON_RPC.invalidParams, `没有叫 ${toolName} 的工具`);
				const args = params?.arguments ?? {};
				if (typeof args !== 'object' || Array.isArray(args)) {
					return fail(JSON_RPC.invalidParams, 'arguments 必须是对象');
				}
				const problems = checkSchema(tool.inputSchema, args);
				if (problems.length) return fail(JSON_RPC.invalidParams, `参数不对：${problems.join('；')}`);

				try {
					const text = await tool.run(args);
					return ok({ content: [{ type: 'text', text }] });
				} catch (error) {
					/*
					 * 工具自己报的错（找不到英雄、参数与顺序对不上、取数失败）按**结果**返回，
					 * 不是协议错误：这样模型能读到原因并自己改，而不是整轮对话断在这里。
					 */
					log(`工具 ${toolName} 执行失败：${error?.message ?? error}`);
					return ok({ content: [{ type: 'text', text: `出错了：${error?.message ?? error}` }], isError: true });
				}
			}
			default:
				return fail(JSON_RPC.methodNotFound, `不支持的方法 ${method}`);
		}
	}

	return { handle };
}

export function listen({ handle, log = () => {} }) {
	const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	let queue = Promise.resolve();

	const send = (payload) => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};

	input.on('line', (line) => {
		const text = line.trim();
		if (!text) return;
		// 串行处理：工具会打网络，并发跑没有收益，按收到顺序回更省心。
		queue = queue.then(async () => {
			let message;
			try {
				message = JSON.parse(text);
			} catch {
				send({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC.parseError, message: '不是合法的 JSON' } });
				return;
			}
			const messages = Array.isArray(message) ? message : [message];
			const responses = [];
			for (const one of messages) {
				try {
					const response = await handle(one);
					if (response) responses.push(response);
				} catch (error) {
					log(`处理 ${one?.method} 时抛错：${error?.stack ?? error}`);
					if (one?.id !== undefined && one?.id !== null) {
						send({
							jsonrpc: '2.0',
							id: one.id,
							error: { code: JSON_RPC.internalError, message: String(error?.message ?? error) },
						});
					}
				}
			}
			if (responses.length === 1) send(responses[0]);
			else if (responses.length > 1) send(responses);
		});
	});

	input.on('close', () => {
		// 客户端关掉 stdin 就退出，不做优雅收尾：这里没有需要落盘的状态。
		queue.finally(() => process.exit(0));
	});
}
