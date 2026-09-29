import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 数据源健康记录。
 *
 * 抓取层是"拿不到就不展示"的静默降级，于是"源站挂了"和"这个板块本来就没有内容"
 * 在页面上长得一模一样——这次 STRATZ 被 Cloudflare 拦掉，表现就是英雄数据整块消失，
 * 只能翻代码加日志才查得出来。
 *
 * 所以每个源跑完自己那一轮抓取后，把结果写到 `.cache/health/<id>.json`；
 * 构建结束时由 `astro.config.mjs` 里的集成读出来汇总打印。走文件而不是内存，
 * 是因为渲染可能发生在别的进程/线程里，文件是唯一稳妥的交接方式。
 */

export type SourceState = 'fresh' | 'cache' | 'empty';

export interface SourceHealth {
	id: string;
	label: string;
	state: SourceState;
	/** 一句话说明本轮的实际情况，例如 "23 篇，联网抓取 18 次"。 */
	detail: string;
	at: string;
}

const DIR = path.join(process.cwd(), '.cache', 'health');

const STATE_LABEL: Record<SourceState, string> = {
	fresh: '联网抓取',
	cache: '使用缓存',
	empty: '没有数据',
};

/** 构建汇总里显示的中文状态，供集成打印时复用。 */
export function stateLabel(state: SourceState): string {
	return STATE_LABEL[state];
}

/**
 * 一个源的状态：**按它的主数据本轮是抓的还是吃缓存的**判定。
 *
 * `fresh` 的依据是"这一源的数据这轮从上游取到了"，不是"这一轮发过请求"。一个源常常有两级数据
 * （列表是主，详情/正文是次），两级缓存的 TTL 各管各的：列表吃缓存的那一轮，详情照样可能联网补抓。
 * 按模块级的抓取次数判，就会把"使用缓存"写成"联网抓取"——上游挂着、旧缓存顶上来的那一轮，
 * 恰好就是这份旧数据最像新数据的时候。
 *
 * 优先级和 `liveApi.sourceSummary` 一致：**一条数据都没有就是"没拿到"**，哪怕这一轮确实发过请求
 * （页面取回来了、却一条都没解析出来，那是页面结构变了，不是新数据）。
 */
export function sourceState(primaryFetched: boolean, itemCount: number): SourceState {
	if (itemCount === 0) return 'empty';
	return primaryFetched ? 'fresh' : 'cache';
}

/** 记录一个数据源本轮的结果。写失败不影响构建。 */
export async function reportSource(id: string, label: string, state: SourceState, detail: string): Promise<void> {
	try {
		const record: SourceHealth = { id, label, state, detail, at: new Date().toISOString() };
		await fs.mkdir(DIR, { recursive: true });
		await fs.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(record), 'utf8');
	} catch {
		// 健康记录只是辅助信息，写不进去就算了。
	}
}
