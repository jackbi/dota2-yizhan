/*
 * 相对导入带 `.ts` 后缀：这些模块要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { MatchAnalysisInput } from '../lib/matchAnalysis.ts';
import { ANALYSIS_MAX_TOKENS, buildAnalysisMessages, parseAnalysisReply } from '../lib/matchAnalysisPrompt.ts';
import type { ParsedAnalysis } from '../lib/matchAnalysisPrompt.ts';
import type { AiConfig } from '../lib/aiConfig.ts';
import { AI_STORE_KEY, aiStateLabel, isConfigured, loadAiConfig, sameAiTarget } from '../lib/aiConfig.ts';
import { chatErrorMessage, requestChat } from '../lib/aiChat.ts';

/**
 * `/replay/<id>` 的 AI 赛后分析。
 *
 * 与 `/draft` 的两条边界一样，且这里是公开页，所以更严格：
 * - **key 只存在这台浏览器**（localStorage，见 `lib/aiConfig.ts`），请求由浏览器直接发给用户
 *   自己填的地址，站点不经手；
 * - **不点不请求**。复盘页的 URL 空间是无界的，自动请求等于替每个到访者花一次他自己的钱。
 *   结果按「比赛 id + 地址 + 模型」缓存在本机，回访不必重花一次；换了模型就作废。
 *
 * 数字全部来自服务端算好的那份摘要（`#match-ai-data`），提示词与解析在 `matchAnalysisPrompt`。
 * 这一层只做三件事：读数据、发请求、把结构化结果画出来。
 */

/**
 * 结果缓存。键是「地址 + 模型」，换一个就是另一份结果，不能沿用。
 *
 * 键里带版本号：给结构化结果加字段（v2 是`转折点`那一节）时必须换键——缓存里存的是**解析后
 * 的对象**，老条目不会自己长出新字段，页面只会安静地少一块。这条规矩在仓库里记过一次
 * （见 docs/data-sources.md 的「加头像没升版本」）。
 */
const CACHE_KEY = 'd2s-match-ai-v2';
/** 最多留几场的分析。常用浏览器会翻很多场，不留上限会一直长。 */
const CACHE_LIMIT = 20;

interface CachedAnalysis {
	baseUrl: string;
	model: string;
	at: number;
	analysis: ParsedAnalysis;
}

function element<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

/** 模型的话与选手名都要经过这一层再插进 DOM，避免被带偏的回复当成 HTML 执行。 */
function esc(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readData(): MatchAnalysisInput | null {
	const raw = document.getElementById('match-ai-data')?.textContent ?? '';
	try {
		const parsed = JSON.parse(raw) as MatchAnalysisInput;
		return typeof parsed?.matchId === 'number' && Array.isArray(parsed?.players) ? parsed : null;
	} catch {
		return null;
	}
}

function loadCache(): Record<string, CachedAnalysis> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, CachedAnalysis>) : {};
	} catch {
		return {};
	}
}

/** 写回并裁到上限：按生成时间留最近的那几场。 */
function saveCache(entry: CachedAnalysis, matchId: number): void {
	try {
		const cache = loadCache();
		cache[String(matchId)] = entry;
		const keys = Object.keys(cache);
		if (keys.length > CACHE_LIMIT) {
			keys
				.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
				.slice(0, keys.length - CACHE_LIMIT)
				.forEach((key) => delete cache[key]);
		}
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
	} catch {
		// 隐私模式写不进去，不影响本次会话继续用。
	}
}

/** 与缓存命中判定共用一份口径：地址与模型都一致才算「这份结果还是当前模型的」。 */
function sameCacheTarget(entry: CachedAnalysis, config: AiConfig): boolean {
	return entry.baseUrl === config.baseUrl && entry.model === config.model;
}

function renderList(title: string, items: string[]): string {
	if (items.length === 0) return '';
	return `<div><p class="text-[11px] text-faint">${esc(title)}</p><ul class="mt-1 space-y-1">${items
		.map((item) => `<li class="text-xs leading-relaxed text-muted">${esc(item)}</li>`)
		.join('')}</ul></div>`;
}

const data = readData();
const run = element<HTMLButtonElement>('match-ai-run');
const state = element<HTMLParagraphElement>('match-ai-state');
const result = element<HTMLDivElement>('match-ai-result');

if (data && run && state && result) {
	/** 「胜方 / 负方」用队名说，读者才知道讲的是哪一支；上游没给结果时退回中性说法。 */
	const winnerName = data.winner === '天辉' ? data.radiantName : data.winner === '夜魇' ? data.direName : null;
	const loserName = data.winner === '天辉' ? data.direName : data.winner === '夜魇' ? data.radiantName : null;
	const winnerTitle = winnerName ? `胜方（${winnerName}）赢在哪` : '胜方赢在哪';
	const loserTitle = loserName ? `负方（${loserName}）输在哪` : '负方输在哪';

	let ai = loadAiConfig();
	let busy = false;
	let statusText = '';

	function render(analysis: ParsedAnalysis): void {
		result.innerHTML = [
			analysis.headline ? `<p class="text-sm leading-relaxed text-cream">${esc(analysis.headline)}</p>` : '',
			analysis.turningPoint
				? `<div class="rounded-lg border border-line bg-surface-2/40 px-3 py-2"><p class="text-[11px] text-faint">转折点</p><p class="mt-1 text-xs leading-relaxed text-cream">${esc(analysis.turningPoint)}</p></div>`
				: '',
			renderList(winnerTitle, analysis.winnerWhy),
			renderList(loserTitle, analysis.loserWhy),
			renderList('负方要赢，得这么做', analysis.pathToWin),
			analysis.dimensions.length > 0
				? `<div class="space-y-1.5 border-t border-line pt-2">${analysis.dimensions
						.map(
							(point) =>
								`<p class="text-xs leading-relaxed text-muted">${point.dimension ? `<span class="text-gold">${esc(point.dimension)}</span> ` : ''}${esc(point.text)}</p>`,
						)
						.join('')}</div>`
				: '',
		]
			.filter((block) => block !== '')
			.join('');
	}

	function paint(): void {
		run.disabled = busy;
		run.textContent = busy ? '分析中…' : '生成分析';
		state.textContent = statusText || (isConfigured(ai) ? aiStateLabel(ai) : `${aiStateLabel(ai)}；入口在设置页`);
	}

	/** 换了地址 / key / 模型就把上一份结果撤掉：它已经不对应当前这个模型了。 */
	function refreshConfig(): void {
		const next = loadAiConfig();
		if (sameAiTarget(next, ai)) {
			ai = next;
			return;
		}
		ai = next;
		statusText = '';
		result.innerHTML = '';
		paint();
	}

	async function generate(): Promise<void> {
		if (!isConfigured(ai)) {
			statusText = '还没配置模型：先在设置页填地址与 key，再回来生成';
			state.scrollIntoView({ block: 'center', behavior: 'smooth' });
			paint();
			return;
		}
		if (busy) return;
		busy = true;
		statusText = '';
		paint();
		// 请求最长能跑 30 秒，这中间配置可能被别的标签页改了：回来先对一眼，换了就丢掉这份。
		const target = ai;
		try {
			const reply = await requestChat(target, buildAnalysisMessages(data), { maxTokens: ANALYSIS_MAX_TOKENS });
			if (!sameAiTarget(target, ai)) return;
			if (!reply.ok) {
				statusText = chatErrorMessage(reply);
				return;
			}
			const parsed = parseAnalysisReply(reply.content);
			if (!parsed) {
				statusText = '模型的回复解析不了，再点一次或换一个模型试试';
				return;
			}
			render(parsed);
			saveCache({ baseUrl: target.baseUrl, model: target.model, at: Date.now(), analysis: parsed }, data.matchId);
			statusText = `由 ${target.model} 生成`;
		} catch {
			if (sameAiTarget(target, ai)) statusText = '调用模型失败（网络或代理）';
		} finally {
			busy = false;
			paint();
		}
	}

	const cached = loadCache()[String(data.matchId)];
	if (cached && sameCacheTarget(cached, ai)) {
		render(cached.analysis);
		statusText = '已显示上次生成的结果，想重来就再点一次';
	} else if (cached) {
		statusText = `上一份是 ${cached.model} 生成的，与当前模型不同，需重新生成`;
	}
	paint();

	run.addEventListener('click', () => {
		void generate();
	});
	// 与 BP 台同一条：从 bfcache 退回来、或另一个标签页改了配置，都要把状态跟上。
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) refreshConfig();
	});
	window.addEventListener('storage', (event) => {
		if (event.key === AI_STORE_KEY) refreshConfig();
	});
}
