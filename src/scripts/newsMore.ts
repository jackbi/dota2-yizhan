/**
 * 资讯页的「加载更多」。
 *
 * 这一页是**一条列表 + 一排标签页**：七个来源的卡片都躺在同一个 `#info-list` 里，
 * 每张外面包着 `<div data-source="…">`，标签页靠显隐切来源。所以这里不是每个来源一个按钮，
 * 而是**一个跟着当前标签页走的按钮**——读者在哪一栏，翻的就是哪一栏。
 *
 * 页面侧要给的约定：
 *
 * ```html
 * <div id="info-tabs"><button data-source="wmpvp" aria-pressed="true">…</button></div>
 * <div id="info-list"><div data-source="wmpvp">…卡片…</div></div>
 * <div data-more data-sources="news,wmpvp,nga,hupu">
 *   <button data-more-button>加载更多</button>
 *   <p data-more-note hidden></p>
 * </div>
 * ```
 *
 * 四条行为：
 * 1. **跟着标签页**：切栏时刷新按钮文案，各自记住翻到第几页、翻没翻到底；
 * 2. **去重**：按卡片的 `data-key` 去重（同一篇资讯可能同时属于官网多个栏目、NGA 的榜单也会重叠）；
 * 3. **翻不动就不摆按钮**：来源不在 `data-sources` 里（比如 Reddit），按钮隐藏并说明原因；
 * 4. **失败要说人话**：把原因写在 `[data-more-note]` 里，按钮复原可以重试。
 */

interface MorePayload {
	ok: boolean;
	reason?: string;
	source?: string;
	page?: number;
	hasMore?: boolean;
	nextPage?: number | null;
	items?: { key: string; html: string }[];
}

/** 每个来源翻到哪儿了。标签页来回切时不用重来。 */
interface State {
	page: number;
	done: boolean;
}

/** 标签页上的计数跟着追加的条数涨。找不到那颗数字就安静跳过。 */
function bumpTabCount(source: string, added: number): void {
	const badge = document.querySelector<HTMLElement>(`#info-tabs [data-source="${source}"] .tabular-nums`);
	if (!badge) return;
	const current = Number(badge.textContent ?? '0');
	if (Number.isFinite(current)) badge.textContent = String(current + added);
}

const tabs = document.getElementById('info-tabs');
const list = document.getElementById('info-list');
const box = document.querySelector<HTMLElement>('[data-more]');
const button = box?.querySelector<HTMLButtonElement>('[data-more-button]');
const note = box?.querySelector<HTMLElement>('[data-more-note]');

if (tabs && list && box && button) {
	const pageable = new Set((box.dataset.sources ?? '').split(',').filter(Boolean));
	const state = new Map<string, State>();
	/** 已经渲染出来的卡片 key：资讯可能同时挂在官网多个栏目下，NGA 的榜单也会重叠。 */
	const shown = new Set(
		[...list.querySelectorAll<HTMLElement>('[data-key]')]
			.map((node) => node.dataset.key ?? '')
			.filter(Boolean),
	);

	/** 当前标签页是哪一个：`aria-pressed` 是页面自己维护的选中态。 */
	function activeSource(): string {
		const pressed = tabs?.querySelector<HTMLElement>('[data-source][aria-pressed="true"]');
		return pressed?.dataset.source ?? 'news';
	}

	function stateOf(source: string): State {
		let current = state.get(source);
		if (!current) {
			current = { page: 1, done: false };
			state.set(source, current);
		}
		return current;
	}

	function paint(): void {
		const source = activeSource();
		if (!pageable.has(source)) {
			button!.hidden = true;
			if (note) {
				note.hidden = false;
				note.textContent = '这一栏的上游没有分页，只能看到最近一批。';
			}
			return;
		}
		const current = stateOf(source);
		button!.hidden = current.done;
		button!.disabled = false;
		button!.textContent = current.page === 1 ? '加载更多' : `加载更多（已到第 ${current.page} 页）`;
		if (note) {
			note.hidden = current.page === 1;
			if (current.page > 1) note.textContent = '';
		}
	}

	function fail(reason: string): void {
		button!.disabled = false;
		if (note) {
			note.hidden = false;
			note.textContent = reason;
		}
	}

	button.addEventListener('click', async () => {
		const source = activeSource();
		const current = stateOf(source);
		button.disabled = true;
		if (note) note.hidden = true;
		try {
			let appended = 0;
			const response = await fetch(
				`/api/news/more?source=${encodeURIComponent(source)}&page=${current.page + 1}`,
				{ headers: { Accept: 'application/json' } },
			);
			const payload = (await response.json()) as MorePayload;
			if (!payload.ok) return fail(payload.reason ?? '这一页没取到，稍后再试。');

			for (const item of payload.items ?? []) {
				if (!item.key || shown.has(item.key)) continue;
				shown.add(item.key);
				// 外层这层 `data-source` 是标签页的显隐依据，不能少。
				list.insertAdjacentHTML('beforeend', `<div data-source="${source}" data-key="${item.key}">${item.html}</div>`);
				appended += 1;
			}
			current.page = payload.page ?? current.page + 1;
			current.done = payload.hasMore !== true || (payload.items ?? []).length === 0;
			// 标签页上那个数字是构建期算的，追加之后跟着涨，免得读者以为没变化。
			if (appended > 0) bumpTabCount(source, appended);
			paint();
			if (current.done && note) {
				note.hidden = false;
				note.textContent = '这一栏已经到底了。';
			}
		} catch {
			fail('取下一页时网络出错了，稍后再试。');
		}
	});

	// 切栏时刷新按钮（页面自己的标签脚本维护 `aria-pressed`，这里跟在它后面读）。
	tabs.addEventListener('click', () => queueMicrotask(paint));
	paint();
}
