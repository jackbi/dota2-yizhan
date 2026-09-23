#!/usr/bin/env node
/**
 * `npx dota2-yizhan` 的入口。
 *
 * 平时由 MCP 客户端按 stdio 拉起来，人不直接跑它；直接跑会打印一段说明，
 * 免得有人以为它坏了——它在等 stdin 上的 JSON-RPC，不会自己输出任何东西。
 */

import { createRequire } from 'node:module';
import { TOOLS } from './tools.mjs';
import { createServer, listen } from './server.mjs';
import { BASE_URL } from './data.mjs';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
	console.log(`DOTA2 驿站 MCP（${pkg.version}）· 数据来自 ${BASE_URL}

用法：由 MCP 客户端按 stdio 启动，不需要参数。

  Claude Code   claude mcp add dota2 -- npx -y dota2-yizhan
  Cursor/其他   写进 mcpServers：{"command":"npx","args":["-y","dota2-yizhan"]}

工具（${TOOLS.length} 个）：
${TOOLS.map((tool) => `  ${tool.name.padEnd(16)} ${tool.description.split('\n')[0]}`).join('\n')}

环境变量：
  DOTA2_MCP_BASE      换数据来源，默认 ${BASE_URL}
  DOTA2_MCP_TTL_MS    数据缓存时长（毫秒），默认 600000
`);
	process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
	console.log(pkg.version);
	process.exit(0);
}

const server = createServer({
	name: 'dota2-yizhan',
	version: pkg.version,
	tools: TOOLS,
	log: (message) => process.stderr.write(`[dota2-yizhan] ${message}\n`),
});

listen({
	handle: server.handle,
	log: (message) => process.stderr.write(`[dota2-yizhan] ${message}\n`),
});
