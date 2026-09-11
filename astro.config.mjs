// @ts-check
import { existsSync, promises as fs } from 'node:fs';
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

/**
 * 构建结束打印各数据源本轮的实际情况。
 *
 * 抓取失败是静默降级（拿不到就不展示），页面上看不出"源挂了"和"本来就没有"，
 * 而 lib 里的 console 输出 Astro 不会转发。所以各源把结果写成
 * `.cache/health/<id>.json`，这里在渲染全部结束后读出来汇总——文件交接，
 * 不依赖渲染跑在主进程还是工作线程里。
 */
const HEALTH_DIR = new URL('.cache/health/', import.meta.url);
const STATE_LABEL = { fresh: '联网抓取', cache: '使用缓存', empty: '没有数据' };

/** @type {import('astro').AstroIntegration} */
const dataSourceReport = {
	name: 'data-source-report',
	hooks: {
		'astro:build:start': async () => {
			// 上一轮的结果不能混进本轮汇总。
			await fs.rm(HEALTH_DIR, { recursive: true, force: true });
		},
		'astro:build:done': async ({ logger }) => {
			let names = [];
			try {
				names = await fs.readdir(HEALTH_DIR);
			} catch {
				return;
			}
			/** @type {{ label: string; state: 'fresh' | 'cache' | 'empty'; detail: string }[]} */
			const records = [];
			for (const name of names) {
				try {
					records.push(JSON.parse(await fs.readFile(new URL(name, HEALTH_DIR), 'utf8')));
				} catch {
					// 单条记录坏掉不影响其它源。
				}
			}
			if (records.length === 0) return;

			// 需要关注的排在前面。
			const order = { empty: 0, cache: 1, fresh: 2 };
			records.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.label.localeCompare(b.label, 'zh'));

			logger.info(`数据源（${records.length}）：`);
			for (const record of records) {
				logger.info(`  ${record.label} — ${STATE_LABEL[record.state] ?? record.state}：${record.detail}`);
			}
		},
	},
};

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [dataSourceReport],
});
