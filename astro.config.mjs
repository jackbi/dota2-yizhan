// @ts-check
import { existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

/**
 * Astro 只在构建期把 `.env` 注入 `process.env`，`astro dev` 不会——结果是
 * `process.env.STRATZ_TOKEN` 这类读取在 dev 下全是空的：STRATZ、有道、Reddit 的
 * 凭据被静默忽略，富化层退回到最慢的 OpenDota 串行路径（每请求 1.1 秒）。
 * 这里统一补上，让两种模式读到同一份配置；已有环境变量优先级更高，命令行传入的不会被覆盖。
 */
const ENV_FILE = new URL('.env', import.meta.url);
if (existsSync(ENV_FILE)) {
	try {
		process.loadEnvFile(ENV_FILE);
	} catch {
		// .env 有问题不该挡住 dev / build，按"没有配置"继续。
	}
}

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
	},
});
