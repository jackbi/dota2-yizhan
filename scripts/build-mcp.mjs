/**
 * 把仓库里的 BP 引擎打包成 MCP 用的单文件。
 *
 * 为什么要打包而不是让 MCP 直接 import `.ts`：
 * - 发布出去的包要能在任意 Node 上跑。原生类型擦除要 Node ≥ 22.18（本机 22.23 是默认开的），
 *   指望用户的 npx 恰好是新版不现实；
 * - `mcp/package.json` 是包的根，`files` 出不了这一层目录，`../src/lib/*.ts` 根本打包不进去。
 *
 * 打出来的 `mcp/dist/engine.mjs` 是**构建产物**，不进 git（见 `.gitignore`），
 * 由 `prepublishOnly` 在发版前重新生成，避免发出去的是旧的。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const entry = fileURLToPath(new URL('mcp/engine.entry.ts', ROOT));
const outfile = fileURLToPath(new URL('mcp/dist/engine.mjs', ROOT));

await build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: 'esm',
	// `neutral` 而不是 `node`：引擎里没有 node 内置模块，别让 esbuild 塞进 node: 前缀。
	platform: 'neutral',
	target: 'node20',
	// 类型全在编译期擦掉，运行时不需要任何依赖。
	legalComments: 'none',
	banner: {
		js: [
			'// 构建产物，勿手改。由 scripts/build-mcp.mjs 从 src/lib/{draftOrder,draftScore,draftVerdict,...}.ts 打包，',
			'// 执行 `pnpm mcp:build` 重新生成。改了引擎记得重跑，否则发出去的还是旧口径。',
		].join('\n'),
	},
});

const { size } = await import('node:fs/promises').then((fs) => fs.stat(outfile));
console.log(`mcp/dist/engine.mjs 已生成（${(size / 1024).toFixed(1)}KB）`);
