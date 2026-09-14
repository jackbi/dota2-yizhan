// @ts-check
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
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

/**
 * 主播头像的字节存在 `.cache/avatars/`（见 `src/lib/avatars.ts`），
 * 构建结束才拷进 `dist/avatars/`。页面里引用的就是 `/avatars/xxx.jpg`。
 */
const AVATAR_DIR = new URL('.cache/avatars/', import.meta.url);
/** 只有本轮真正用到的头像才发布：`localizeAvatars()` 会把用到的文件 mtime 刷成当前时间。 */
let buildStartedAt = 0;
/** 本轮开始前缓存里已有的头像，用来判断这一轮新下了几张。 */
let avatarsBefore = new Set();
/** 缓存里放太久没被用到的头像直接删掉——房间号换人、房间下榜都会留下孤儿文件。 */
const AVATAR_KEEP_DAYS = 30;

async function listAvatars() {
	try {
		return new Set((await fs.readdir(AVATAR_DIR)).filter((name) => name.endsWith('.jpg')));
	} catch {
		return new Set();
	}
}

/** 删掉长期没被用到的头像，免得缓存和 dist 越攒越大。 */
/** @param {import('astro').AstroIntegrationLogger} logger */
async function pruneAvatars(logger) {
	const names = [...(await listAvatars())];
	const cutoff = Date.now() - AVATAR_KEEP_DAYS * 24 * 60 * 60 * 1000;
	let removed = 0;
	await Promise.all(
		names.map(async (name) => {
			try {
				const file = new URL(name, AVATAR_DIR);
				if ((await fs.stat(file)).mtimeMs < cutoff) {
					await fs.rm(file, { force: true });
					removed += 1;
				}
			} catch {
				// 单个文件删不掉不影响构建。
			}
		}),
	);
	if (removed > 0) logger.info(`清理了 ${removed} 个头像缓存（超过 ${AVATAR_KEEP_DAYS} 天没用到）`);
}

/**
 * 把本轮用到的头像拷进 dist，并写一条数据源记录。
 *
 * 头像的健康记录在这里出、而不是在 `localizeAvatars()` 里：那个函数会被 OB 页和分屏页
 * 各调一次、每次只看自己要的那一批，谁最后写谁覆盖（第一版就出现过汇总显示「11 / 11 张」
 * 而实际发布了 75 张）。集成只在构建末尾跑一次，看到的是全部。
 *
 * @param {URL} dir
 * @param {import('astro').AstroIntegrationLogger} logger
 */
async function publishAvatars(dir, logger) {
	const names = [...(await listAvatars())];
	const target = new URL('avatars/', dir);
	let copied = 0;
	let fresh = 0;
	for (const name of names) {
		try {
			const file = new URL(name, AVATAR_DIR);
			// 本轮开始前就写好的说明这次没用到，不带走。
			if ((await fs.stat(file)).mtimeMs < buildStartedAt - 60_000) continue;
			await fs.mkdir(target, { recursive: true });
			await fs.copyFile(file, new URL(name, target));
			if (!avatarsBefore.has(name)) fresh += 1;
			copied += 1;
		} catch (error) {
			logger.warn(`头像 ${name} 没能发布：${error instanceof Error ? error.message : error}`);
		}
	}

	try {
		const record = {
			id: 'avatars',
			label: '主播头像',
			state: fresh > 0 ? 'fresh' : copied > 0 ? 'cache' : 'empty',
			detail:
				copied > 0
					? `发布 ${copied} 张到 /avatars/（本轮新下载 ${fresh}，缓存共 ${names.length} 张）`
					: '没有取到任何头像，页面退回首字母占位',
			at: new Date().toISOString(),
		};
		await fs.mkdir(HEALTH_DIR, { recursive: true });
		await fs.writeFile(new URL('avatars.json', HEALTH_DIR), JSON.stringify(record), 'utf8');
	} catch {
		// 健康记录只是辅助信息。
	}
}

/** @type {import('astro').AstroIntegration} */
const dataSourceReport = {
	name: 'data-source-report',
	hooks: {
		'astro:build:start': async ({ logger }) => {
			// 上一轮的结果不能混进本轮汇总。
			await fs.rm(HEALTH_DIR, { recursive: true, force: true });
			buildStartedAt = Date.now();
			await pruneAvatars(logger);
			avatarsBefore = await listAvatars();
		},
		'astro:build:done': async ({ dir, logger }) => {
			await publishAvatars(dir, logger);

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

/**
 * dev 下把 `.cache/avatars/` 挂到 `/avatars/` 上。
 *
 * 头像是**构建产物**：字节由 `astro:build:done` 拷进 `dist/avatars/`。而 `astro dev` 不跑构建，
 * 页面里引用的 `/avatars/xxx.jpg` 就全是 404——页面上一个头像都出不来，控制台刷屏。
 * 这里给 dev 加一段中间件直接从缓存目录读，省得"想看一眼头像还得先跑一次 build"。
 *
 * 只认自己生成的文件名（`平台-房间号-哈希.jpg`），`path.basename` 顺手挡掉 `../` 这类穿越。
 */
/** @type {import('astro').AstroIntegration} */
const avatarsInDev = {
	name: 'avatars-in-dev',
	hooks: {
		'astro:server:setup': ({ server }) => {
			server.middlewares.use('/avatars', async (req, res, next) => {
				const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]));
				if (!/^[a-z0-9-]+\.jpg$/.test(name)) return next();
				try {
					const bytes = await fs.readFile(new URL(name, AVATAR_DIR));
					res.setHeader('Content-Type', 'image/jpeg');
					// 缓存里的图可能刚被换掉，dev 下别让浏览器留旧的。
					res.setHeader('Cache-Control', 'no-cache');
					res.end(bytes);
				} catch {
					// 还没下到这张（或名字不对），交给后面的 404。
					next();
				}
			});
		},
	},
};

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [dataSourceReport, avatarsInDev],
});
