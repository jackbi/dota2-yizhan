import { spawnSync } from 'node:child_process';
import { normalizeBaseUrl } from '../src/lib/aiConfig.ts';
import { AI_PROVIDERS, headersFor } from '../src/lib/aiProviders.ts';

/**
 * 探测各服务商：地址对不对、浏览器能不能直连。
 *
 * 加一家新服务商、或者怀疑某家的策略变了的时候跑这个，比在设置页里挨个填一遍快得多。
 * 它探的就是 `lib/aiProviders.ts` 那张表，所以表改了这里跟着改，不用再维护第二份清单。
 *
 * 两件事各探一次，与当初建表时用的是同一套办法（结论见 docs/draft.md 的「服务商预设」）：
 *
 * 1. **地址**：带一个明显无效的 key 打 `<地址>/models`。401/403/400/405 说明路径存在，
 *    404 才是地址写错；200 是那种公开的模型列表（OpenRouter、魔搭）。
 * 2. **跨域**：对 `<地址>/chat/completions` 发 `OPTIONS` 预检，看回不回
 *    `Access-Control-Allow-Origin`，以及放不放行我们真正会带的那些请求头。
 *    这一条是硬门槛：请求从浏览器直接发出，不放行就只能自建代理。
 *
 * **它会往各服务商发几条请求**（带的是无效 key，不发送任何用户数据、不花额度），所以不进
 * `pnpm check`——那个必须离线可跑。什么时候跑由你决定。
 *
 * 这台机器要是配了代理，脚本会自己用 `NODE_USE_ENV_PROXY=1` 重启一次：Node 的 `fetch` 默认
 * 不认 `http_proxy` / `https_proxy`，不重启的话需要代理的那几家会被误报成「连不上」。
 *
 * 跑：
 *   pnpm probe:providers
 *   node --experimental-strip-types scripts/aiProviders.probe.ts --only=openai,anthropic
 *   node --experimental-strip-types scripts/aiProviders.probe.ts --origin=https://dota2.hiwenbin.com
 *
 * 退出码：0 表示没发现明确的问题；1 表示有服务商「404 / 被跨域挡住」——这两类都是要动手改的。
 * 「连不上」（DNS、超时、被网络环境挡）只提示不改退出码：它说明的是你这台机器的网络，不是表写错了。
 */

/** 与 `astro.config.mjs` 里的 `SITE_ORIGIN` 一致（`aiProviders.check` 会盯着这两处别漂移）。 */
const DEFAULT_ORIGIN = 'https://dota2.hiwenbin.com';
const PROBE_TIMEOUT_MS = 20_000;
/** 明显无效的 key：只为触发鉴权错误，能把「路径存在」与「路径不存在」分开。 */
const PROBE_KEY = 'sk-invalid-probe';

const args = process.argv.slice(2);
const originArg = args.find((arg) => arg.startsWith('--origin='))?.slice('--origin='.length);
const onlyArg = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const ORIGIN = (originArg ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((id) => id.trim())) : null;

/**
 * Node 的 `fetch` **默认不认** `http_proxy` / `https_proxy`（浏览器与 curl 都认，就它不认）。
 *
 * 在需要代理的网络上，这会让 OpenAI、Gemini、Grok 一律显示「连不上」——不是表写错了，是探测请求
 * 根本没走代理。Node 22.21+ 支持 `NODE_USE_ENV_PROXY=1` 让 fetch 认环境变量，所以这里自己重启
 * 一次带上它；`DOTA2_PROBE_REEXEC` 是防重入的标记，只重启一次。
 *
 * 老版本的 Node 会忽略这个变量，那就等于没重启：只是多跑一次进程，结果与不重启一样。
 */
const PROXY_ENV = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '';
if (PROXY_ENV && process.env.NODE_USE_ENV_PROXY !== '1' && process.env.DOTA2_PROBE_REEXEC !== '1') {
	console.log(`检测到代理（${PROXY_ENV}），用 NODE_USE_ENV_PROXY=1 重启一次让 fetch 走它…\n`);
	const restarted = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
		stdio: 'inherit',
		env: { ...process.env, NODE_USE_ENV_PROXY: '1', DOTA2_PROBE_REEXEC: '1' },
	});
	process.exit(restarted.status ?? 1);
}

type Verdict = 'ok' | 'bad' | 'unknown' | 'skipped';

interface Result {
	id: string;
	label: string;
	path: Verdict;
	pathDetail: string;
	cors: Verdict;
	corsDetail: string;
}

/** 预检时声明我们要带的头，必须与真实请求一致，否则浏览器那边过不去、这里却显示通过。 */
function requestedHeaders(baseUrl: string): string {
	// 真实请求里 `Content-Type` 是后加的（`headersFor` 已经包含），这里统一收敛成小写去重。
	return Object.keys(headersFor(baseUrl, PROBE_KEY))
		.map((name) => name.toLowerCase())
		.sort()
		.join(',');
}

async function probeModels(baseUrl: string): Promise<{ verdict: Verdict; detail: string }> {
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: headersFor(baseUrl, PROBE_KEY),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (response.status === 404) return { verdict: 'bad', detail: '404：地址大概写错了' };
		if (response.status === 200) return { verdict: 'ok', detail: '200：公开的模型列表' };
		return { verdict: 'ok', detail: `${response.status}：路径存在（鉴权被拒）` };
	} catch (error) {
		return { verdict: 'unknown', detail: `连不上（${errorLabel(error)}）` };
	}
}

async function probeCors(baseUrl: string): Promise<{ verdict: Verdict; detail: string }> {
	const wants = requestedHeaders(baseUrl);
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'OPTIONS',
			headers: {
				Origin: ORIGIN,
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': wants,
			},
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const allowOrigin = response.headers.get('access-control-allow-origin');
		const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
		if (!allowOrigin) {
			return { verdict: 'bad', detail: `预检被拒或没给跨域头（HTTP ${response.status}）：浏览器发不出去` };
		}
		if (allowOrigin !== '*' && allowOrigin !== ORIGIN) {
			return { verdict: 'bad', detail: `跨域只放行了 ${allowOrigin}` };
		}
		// 放行的头要覆盖我们真正会带的那些（`*` 也算覆盖）。
		if (!allowHeaders) return { verdict: 'bad', detail: '预检没声明放行哪些请求头，浏览器会拦下 Authorization' };
		if (allowHeaders !== '*') {
			const allowed = new Set(allowHeaders.split(',').map((name) => name.trim()));
			const missing = wants.split(',').filter((name) => name && !allowed.has(name));
			if (missing.length > 0) return { verdict: 'bad', detail: `没放行请求头：${missing.join('、')}` };
		}
		return { verdict: 'ok', detail: `放行 ${allowOrigin === '*' ? '*' : '本站域名'}` };
	} catch (error) {
		return { verdict: 'unknown', detail: `连不上（${errorLabel(error)}）` };
	}
}

/**
 * 探测一次不够稳：边缘节点偶尔会把这种没头没脑的探测请求当异常流量，随手回 4xx 且不带跨域头。
 * 第一次不是「正常」就再试一次，两次里取更明确的那次（正常 > 有问题 > 摸不清）。
 */
const RANK: Record<Verdict, number> = { ok: 2, bad: 1, unknown: 0, skipped: 0 };
async function withRetry<T extends { verdict: Verdict }>(probe: () => Promise<T>): Promise<T> {
	const first = await probe();
	if (first.verdict === 'ok') return first;
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const second = await probe();
	return RANK[second.verdict] > RANK[first.verdict] ? second : first;
}

function errorLabel(error: unknown): string {
	if (error instanceof Error) {
		// 超时与 DNS 在 Node 里的文案又长又不一样，收敛成两个能认得的词。
		if (error.name === 'TimeoutError') return '超时';
		if (/ENOTFOUND|EAI_AGAIN/.test(error.message)) return '域名解析不了';
		if (/ECONNREFUSED/.test(error.message)) return '端口拒绝连接';
		return error.message.slice(0, 40);
	}
	return String(error).slice(0, 40);
}

const MARK: Record<Verdict, string> = { ok: '✓', bad: '✗', unknown: '⚠', skipped: '·' };

async function run(): Promise<number> {
	const targets = AI_PROVIDERS.filter((provider) => (ONLY ? ONLY.has(provider.id) : true));
	if (ONLY && targets.length === 0) {
		console.error(`--only 里没有一项能对上预设表：${[...ONLY].join('、')}`);
		return 1;
	}

	console.log(`探测 ${targets.length} 家服务商（Origin: ${ORIGIN}）\n`);
	const results: Result[] = [];
	for (const provider of targets) {
		// 自定义没有地址；Cloudflare 的地址里要填账号 id，脚本不猜——这两家只登记不探测。
		if (!provider.baseUrl || provider.baseUrl.includes('{')) {
			results.push({
				id: provider.id,
				label: provider.label,
				path: 'skipped',
				pathDetail: provider.baseUrl ? '地址里有占位符，要在设置页填' : '要用户自己填地址',
				cors: 'skipped',
				corsDetail: '同上',
			});
			console.log(`${MARK.skipped} ${provider.label}：跳过（地址要用户填）`);
			continue;
		}

		const baseUrl = normalizeBaseUrl(provider.baseUrl);
		const path = await withRetry(() => probeModels(baseUrl));
		const cors = await withRetry(() => probeCors(baseUrl));
		results.push({ id: provider.id, label: provider.label, path: path.verdict, pathDetail: path.detail, cors: cors.verdict, corsDetail: cors.detail });
		console.log(`${MARK[path.verdict]}${MARK[cors.verdict]} ${provider.label}`);
		console.log(`     地址 ${path.detail}`);
		console.log(`     跨域 ${cors.detail}`);
	}

	// 本地服务（Ollama）没起就没有，不算问题；「连不上」同理，那是网络环境的事。
	const local = new Set(['ollama']);
	const problems = results.filter(
		(result) => !local.has(result.id) && (result.path === 'bad' || result.cors === 'bad'),
	);
	const unknown = results.filter((result) => !local.has(result.id) && (result.path === 'unknown' || result.cors === 'unknown'));

	console.log('\n———————— 小结 ————————');
	console.log(`✓ 正常 ${results.filter((r) => r.path === 'ok').length} 家地址、${results.filter((r) => r.cors === 'ok').length} 家放行跨域`);
	if (problems.length > 0) {
		for (const problem of problems) {
			console.log(`✗ ${problem.label}：${problem.path === 'bad' ? problem.pathDetail : problem.corsDetail}`);
		}
	}
	if (unknown.length > 0) {
		console.log(`⚠ 连不上（多半是这台机器的网络问题，不代表表写错）：${unknown.map((r) => r.label).join('、')}`);
	}
	console.log(problems.length > 0 ? '\n结论：有要动手改的地方（看上面的 ✗）。' : '\n结论：没发现明确的问题。');
	return problems.length > 0 ? 1 : 0;
}

run()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error('探测中断：', error);
		process.exitCode = 1;
	});
