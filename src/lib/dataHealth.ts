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
