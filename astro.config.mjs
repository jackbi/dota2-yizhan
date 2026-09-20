// @ts-check
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, envField } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { CACHE_KEEP_DAYS, pruneCacheDirs } from './src/lib/cachePrune.ts';

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
const CACHE_BASE = new URL('.cache/', import.meta.url);
const HEALTH_DIR = new URL('health/', CACHE_BASE);
const STATE_LABEL = { fresh: '联网抓取', cache: '使用缓存', empty: '没有数据' };

/**
 * 需要在构建末尾发布到 `dist/` 的图片频道（通用逻辑见 `src/lib/localImages.ts`）。
 *
 * `dir` 必须和 `src/lib/avatars.ts`、`src/lib/covers.ts` 里的 `channel.dir` 对得上：
 * 这里是「哪个目录要拷出去」，那边是「拷出去的图长什么样」。
 */
const IMAGE_CHANNELS = [
	{ dir: 'avatars', label: '主播头像', empty: '没有取到任何头像，页面退回首字母占位' },
	{ dir: 'covers', label: 'B站视频封面', empty: '没有取到任何封面，页面退回热链 B站 CDN' },
	{ dir: 'patch-heroes', label: '更新日志英雄图标', empty: '没有取到任何英雄图标，更新日志只显示名字' },
	{ dir: 'patch-items', label: '更新日志物品图标', empty: '没有取到任何物品图标，更新日志只显示名字' },
];
/** 缓存里放太久没被用到的图直接删掉——房间号换人、房间下榜都会留下孤儿文件。 */
const IMAGE_KEEP_DAYS = 30;

/** 只有本轮真正用到的图才发布：`localizeImages()` 会把用到的文件 mtime 刷成当前时间。 */
let buildStartedAt = 0;
/** `dir` → 本轮开始前缓存里已有的文件名，用来判断这一轮新下了几张。 */
const imagesBefore = new Map();

/** @param {string} dir */
async function listImages(dir) {
	try {
		return new Set(
			(await fs.readdir(new URL(`${dir}/`, CACHE_BASE))).filter((name) => name.endsWith('.jpg')),
		);
	} catch {
		return new Set();
	}
}

/**
 * 删掉长期没被用到的图，免得缓存和 dist 越攒越大。
 *
 * @param {{ dir: string, label: string }} channel
 * @param {import('astro').AstroIntegrationLogger} logger
 */
async function pruneImages(channel, logger) {
	const names = [...(await listImages(channel.dir))];
	const cutoff = Date.now() - IMAGE_KEEP_DAYS * 24 * 60 * 60 * 1000;
	let removed = 0;
	await Promise.all(
		names.map(async (name) => {
			try {
				const file = new URL(`${channel.dir}/${name}`, CACHE_BASE);
				if ((await fs.stat(file)).mtimeMs < cutoff) {
					await fs.rm(file, { force: true });
					removed += 1;
				}
			} catch {
				// 单个文件删不掉不影响构建。
			}
		}),
	);
	if (removed > 0) {
		logger.info(`清理了 ${removed} 张${channel.label}缓存（超过 ${IMAGE_KEEP_DAYS} 天没用到）`);
	}
}

/**
 * 把本轮用到的图拷进 dist，并写一条数据源记录。
 *
 * 健康记录在这里出、而不是在 `localizeImages()` 里：那个函数会被 OB 页和分屏页
 * 各调一次、每次只看自己要的那一批，谁最后写谁覆盖（第一版就出现过汇总显示「11 / 11 张」
 * 而实际发布了 75 张）。集成只在构建末尾跑一次，看到的是全部。
 *
 * @param {{ dir: string, label: string, empty: string }} channel
 * @param {URL} dir
 * @param {import('astro').AstroIntegrationLogger} logger
 */
async function publishImages(channel, dir, logger) {
	const names = [...(await listImages(channel.dir))];
	const target = new URL(`${channel.dir}/`, dir);
	const before = imagesBefore.get(channel.dir) ?? new Set();
	let copied = 0;
	let fresh = 0;
	for (const name of names) {
		try {
			const file = new URL(`${channel.dir}/${name}`, CACHE_BASE);
			// 本轮开始前就写好的说明这次没用到，不带走。
			if ((await fs.stat(file)).mtimeMs < buildStartedAt - 60_000) continue;
			await fs.mkdir(target, { recursive: true });
			await fs.copyFile(file, new URL(name, target));
			if (!before.has(name)) fresh += 1;
			copied += 1;
		} catch (error) {
			logger.warn(`${channel.label} ${name} 没能发布：${error instanceof Error ? error.message : error}`);
		}
	}

	try {
		const record = {
			id: channel.dir,
			label: channel.label,
			state: fresh > 0 ? 'fresh' : copied > 0 ? 'cache' : 'empty',
			detail:
				copied > 0
					? `发布 ${copied} 张到 /${channel.dir}/（本轮新下载 ${fresh}，缓存共 ${names.length} 张）`
					: channel.empty,
			at: new Date().toISOString(),
		};
		await fs.mkdir(HEALTH_DIR, { recursive: true });
		await fs.writeFile(new URL(`${channel.dir}.json`, HEALTH_DIR), JSON.stringify(record), 'utf8');
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
		for (const channel of IMAGE_CHANNELS) {
			await pruneImages(channel, logger);
			imagesBefore.set(channel.dir, await listImages(channel.dir));
		}
		/*
		 * 图片之外的那些缓存也回收一次。它们没有 TTL 之外的任何清理机制，而 key 有一部分来自
		 * 「当前内容」（热帖详情、新闻正文、翻译），于是随每次重建单调增长——见 `cachePrune.ts`。
		 * 图片频道有自己的 30 天规则、`health/` 每轮清空，都在 skip 里让开。
		 */
		const pruned = await pruneCacheDirs(fileURLToPath(CACHE_BASE), {
			skip: [...IMAGE_CHANNELS.map((channel) => channel.dir), 'health'],
		});
		if (pruned.removed > 0 || pruned.tmpRemoved > 0) {
			logger.info(
				`回收缓存：过期 ${pruned.removed} 个、写入残留 ${pruned.tmpRemoved} 个` +
					`（扫了 ${pruned.dirs} 个目录，窗口 ${CACHE_KEEP_DAYS} 天）`,
			);
		}
	},
		'astro:build:done': async ({ dir, logger }) => {
			for (const channel of IMAGE_CHANNELS) await publishImages(channel, dir, logger);

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
 * dev 下把 `.cache/<dir>/` 挂到 `/<dir>/` 上。
 *
 * 这些图是**构建产物**：字节由 `astro:build:done` 拷进 `dist/<dir>/`。而 `astro dev` 不跑构建，
 * 页面里引用的 `/avatars/xxx.jpg`、`/covers/xxx.jpg` 就全是 404——页面上一个图都出不来，
 * 控制台刷屏。这里给 dev 加一段中间件直接从缓存目录读，省得"想看一眼头像还得先跑一次 build"。
 *
 * 只认自己生成的文件名（`键-地址哈希.jpg`），`path.basename` 顺手挡掉 `../` 这类穿越。
 */
/** @type {import('astro').AstroIntegration} */
const imagesInDev = {
	name: 'images-in-dev',
	hooks: {
		'astro:server:setup': ({ server }) => {
			for (const channel of IMAGE_CHANNELS) {
				server.middlewares.use(`/${channel.dir}`, async (req, res, next) => {
					const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]));
					if (!/^[a-z0-9-]+\.jpg$/.test(name)) return next();
					try {
						const bytes = await fs.readFile(new URL(`${channel.dir}/${name}`, CACHE_BASE));
						res.setHeader('Content-Type', 'image/jpeg');
						// 缓存里的图可能刚被换掉，dev 下别让浏览器留旧的。
						res.setHeader('Cache-Control', 'no-cache');
						res.end(bytes);
					} catch {
						// 还没下到这张（或名字不对），交给后面的 404。
						next();
					}
				});
			}
		},
	},
};

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
		/*
		 * `mpegts.js` 必须显式列进来。
		 *
		 * 它只被页面脚本动态 `import()`（`/live` 的 liveWall），而实测 Astro 启动时的依赖
		 * 扫描**没有**把它收进
		 * `node_modules/.vite/deps`（那份 _metadata.json 里只有 dev-toolbar 的几个包）。
		 * 于是 Vite 每次都在请求到达时按需发现它：生成一个新的 `?v=` 哈希、把模块改写成
		 * 指向新哈希，但预构建产物并没有落盘——页面于是反复吃
		 * `504 Outdated Optimize Dep`，而且每刷一次哈希就换一个（实测见过三个）。
		 *
		 * 写进 `include` 后它和 dev-toolbar 一起在启动时预构建，哈希稳定。
		 * **以后再有「只被某个页面脚本 import」的依赖，同样要加到这里。**
		 *
		 * （`trystero` 原先也在这里，开黑房间改成服务端 WebSocket 之后不再需要它了。）
		 */
		optimizeDeps: { include: ['mpegts.js'] },
	},
	/*
	 * `site` 是 SEO 这条线的地基，不是可选项：
	 * - 没有它，`@astrojs/sitemap` 生成不出绝对 URL，只能报错；
	 * - canonical 与 og:url 也都得是绝对地址，否则搜索引擎会把 www / 尾斜杠 / 带参数的
	 *   同一个页面当成好几份。本地开发也填线上域名——它只影响构建产物里的字符串。
	 */
	site: 'https://dota2.hiwenbin.com',
	integrations: [
		dataSourceReport,
		imagesInDev,
		/*
		 * 503 个预渲染页面（英雄、物品、更新日志、赛事、战队…）靠它一次列全。
		 * `prerender = false` 的那几条（/party、/me、/api）不会被收录——它们要么要登录、
		 * 要么是接口，进 sitemap 只会浪费爬虫预算。
		 */
		sitemap(),
	],

	/*
	 * 站点主体仍是 `output: static`（默认值）——所有内容页在构建期渲染成 HTML，
	 * 部署与性能跟以前一样。适配器只是为了那几条 `export const prerender = false`
	 * 的路由：Steam 登录必须在服务端接收 OpenID 回调并向 Steam 反查断言，纯静态做不到。
	 *
	 * 两个适配器都装着，用 `DEPLOY_TARGET` 选：默认 Node（本地 dev 与自托管），
	 * `DEPLOY_TARGET=cloudflare` 出 Workers 产物（步骤见 docs/deploy.md「发布到 Cloudflare Workers」）。
	 * 前提是 SSR 侧代码只用 Web 标准 API（见 src/lib/session.ts 与 src/lib/stratzPlayer.ts
	 * 的说明），不碰 node:fs / node:crypto——否则上 Workers 就得重写。
	 */
	adapter:
		process.env.DEPLOY_TARGET === 'cloudflare'
			? cloudflare({
					/*
					 * 预渲染（也就是所有内容页）必须留在 Node 进程里跑。这些页面在构建期要抓斗鱼、
					 * 虎牙、NGA、Reddit，本机直连会被重置、得靠 HTTP_PROXY 走代理；而 workerd 里的
					 * `fetch` 不认代理环境变量——实测默认值（workerd）下构建到 `/live` 直接
					 * `TypeError: fetch failed`，改回 node 后 14 个数据源全部正常。
					 */
					prerenderEnvironment: 'node',
					/*
					 * 站点不用 Astro 的图片服务：图片是构建期自己下载、由 `astro:build:done`
					 * 发布到 `/avatars` 等目录的静态文件（见 src/lib/localImages.ts）。
					 */
					imageService: 'passthrough',
				})
			: node({ mode: 'standalone' }),

	/*
	 * 会话是我们自己签名的 Cookie（src/lib/session.ts），没用 Astro 的 sessions。
	 * 关掉之后 Cloudflare 适配器不会再自动 provisioning 一个 KV 命名空间——
	 * 生成的 `dist/server/wrangler.json` 里 `kv_namespaces` 从 `[{binding:"SESSION"}]` 变空。
	 */
	session: false,

	/*
	 * 用 `astro:env` 而不是直接读 `process.env`：Node 下两者等价，但换到
	 * Cloudflare 这类运行时，密钥要从 Workers 的绑定里取，只有 astro:env 会替我们接上。
	 */
	env: {
		schema: {
			/** 与构建期共用：SSR 取个人战绩时也要用它。 */
			STRATZ_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
			/**
			 * 固定出口中转（`scripts/stratz-relay.mjs`）的地址与口令，两个都配才会生效。
			 * 配了就一律走中转：token 绑 IP，而 Workers 的边缘出口会漂。
			 */
			STRATZ_RELAY_URL: envField.string({ context: 'server', access: 'public', optional: true }),
			STRATZ_RELAY_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
			/** 给会话 Cookie 签名。没配时登录直接报错，不会退化成一个可伪造的默认密钥。 */
			SESSION_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
			/**
			 * 对外可访问的站点地址，用于拼 OpenID 的 realm / return_to。
			 * 不配时按请求的 origin 推断（本地开发无需配置）；生产环境建议显式配上，
			 * 免得反向代理没透传对 Host 时把 Steam 的回调指错地方。
			 */
			SITE_URL: envField.string({ context: 'server', access: 'public', optional: true }),
		},
	},
});
