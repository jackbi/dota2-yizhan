/**
 * 社区帖详情页的「加载更多回复」。
 *
 * 首屏的楼层是构建期渲染好的静态 HTML（爬虫与无 JS 的访客看到的就是它）；想看后面几页的人
 * 点一下按钮，这里去 `/api/community/floors` 取下一页，按 `data-pid` 去重后追加到列表末尾。
 * 分工写在 `src/lib/communityFloors.ts` 的文件头。
 *
 * 页面侧要给的约定（两个详情页都照这个来）：
 *
 * ```html
 * <div data-floors-more data-source="nga" data-id="47683317" data-next-page="2" data-remaining="16">
 *   <button data-floors-more-button>加载更多回复（还有 16 层）</button>
 *   <p data-floors-more-note hidden></p>
 *   <ul data-floors-list>…</ul>          <!-- 追加目标，可以不在同一个容器里 -->
 *   <h2 data-floors-range>回复 #1 – #19</h2>   <!-- 可选，有楼层号的那一族给 -->
 * </div>
 * ```
 *
 * 三条行为：
 * 1. **去重**：亮评与楼层会重叠（虎扑的亮评可能来自第 8 页），同一个 `data-pid` 只出现一次；
 * 2. **失败要说人话**：按钮复原、把原因写在 `[data-floors-more-note]` 里，旁边就是「前往原帖」；
 * 3. **到底了就收摊**：按钮换成「已经到底了」，不再发请求。
 */

interface FloorsPayload {
	ok: boolean;
	reason?: string;
	page?: number;
	items?: { pid: string; html: string }[];
	progress?: { remaining?: number; hasMore?: boolean; nextPage?: number | null; page?: number };
	/** NGA 有楼层号：这一页最后一个楼层号，用来把标题里的范围接上去。 */
	toFloor?: number;
}

const box = document.querySelector<HTMLElement>('[data-floors-more]');
const button = box?.querySelector<HTMLButtonElement>('[data-floors-more-button]');
const note = box?.querySelector<HTMLElement>('[data-floors-more-note]');
const list = document.querySelector<HTMLElement>('[data-floors-list]');
const range = document.querySelector<HTMLElement>('[data-floors-range]');

if (box && button && list && box.dataset.source && box.dataset.id) {
	const source = box.dataset.source;
	const id = box.dataset.id;
	let page = Number(box.dataset.nextPage ?? '2');
	/** 已经渲染出来的楼层 id：追加时按它去重。 */
	const shown = new Set(
		[...document.querySelectorAll<HTMLElement>('[data-pid]')]
			.map((node) => node.dataset.pid ?? '')
			.filter(Boolean),
	);
	/** 标题里那个起始楼层号（`回复 #1 – #19` 的 1），只 NGA 有。 */
	const firstFloor = Number(range?.dataset.firstFloor ?? '0');

	/** 按钮文案与「还剩多少」都从这里来，别在两处各算一遍。 */
	function paint(remaining: number, hasMore: boolean): void {
		if (!hasMore) {
			button.hidden = true;
			if (note) {
				note.hidden = false;
				note.textContent = '这一帖的回复已经全部展开了。';
			}
			return;
		}
		button.textContent = `加载更多回复（还有 ${remaining} 层）`;
	}

	function fail(reason: string): void {
		button.disabled = false;
		if (note) {
			note.hidden = false;
			note.textContent = reason;
		}
	}

	button.addEventListener('click', async () => {
		button.disabled = true;
		if (note) note.hidden = true;
		try {
			const response = await fetch(
				`/api/community/floors?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&page=${page}`,
				{ headers: { Accept: 'application/json' } },
			);
			const payload = (await response.json()) as FloorsPayload;
			if (!payload.ok) return fail(payload.reason ?? '这一页没取到，稍后再试。');

			for (const item of payload.items ?? []) {
				if (!item.pid || shown.has(item.pid)) continue;
				shown.add(item.pid);
				list.insertAdjacentHTML('beforeend', item.html);
			}

			/*
			 * `remaining` 是接口算的「这一页之外还剩多少」（含被亮评展示过、因此不会追加的那几层，
			 * 所以它是个上限，宁可多说几条）。
			 */
			const remaining = Math.max(0, payload.progress?.remaining ?? 0);
			page = payload.progress?.nextPage ?? page + 1;
			if (range && payload.toFloor && firstFloor > 0) {
				range.textContent = `回复 #${firstFloor} – #${payload.toFloor}`;
			}
			paint(remaining, payload.progress?.hasMore === true);
		} catch {
			fail('取下一页时网络出错了，稍后再试或直接去原帖。');
		}
	});
}
