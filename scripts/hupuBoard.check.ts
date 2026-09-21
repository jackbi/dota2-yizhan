import assert from 'node:assert/strict';
import { selectBoardThreads, toThreads } from '../src/lib/hupuBoard.ts';

/**
 * `src/lib/hupuApi.ts` 列表口径的自检。
 *
 * 这一栏踩过的坑是**排序**，不是抓取：版面页给的是「最新回复」顺序（新帖在前），
 * 而这里原来先按 `回复数 >= 5` 过滤、再按回复数倒序取前 20——新帖回复少，第一刀就被砍掉，
 * 选出来的全是几天前的高回复长贴（实测线上那 20 条里最新的一条也是 74 小时前），
 * 于是每轮构建这一栏都长一个样，看着像"数据没更新"。
 *
 * 所以这里盯三件事：
 *
 * 1. **顺序就是版面页的顺序**，不按回复数重排；
 * 2. **回复数不是门槛**，0 回复 / 2 回复的新帖照样进列表；
 * 3. **只有时间解不出来的行才丢**，且不会因为跨年解析出"未来时间"。
 *
 * 顺序那条是能红的：把 `selectBoardThreads` 换回"按回复数倒序 + 过滤"，
 * 第 1 组立刻挂。HTML 片段取自真实列表行，字段名与嵌套结构都照抄。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/hupuBoard.check.ts`）。
 */

/** 2026-09-21 14:00（北京时间）——列表里的时间只有 `MM-DD HH:mm`，得钉住"现在"。 */
const nowSec = Date.UTC(2026, 8, 21, 6, 0, 0) / 1000;

interface Row {
	pid?: string;
	title?: string;
	/** 列表里的「回复 / 浏览」 */
	datum?: string;
	author?: string;
	time?: string;
}

/** 一行帖子，结构照抄线上（`post-title` / `post-datum` / `post-auth` / `post-time` 四个 div）。 */
function row({ pid = '642490008', title = '标题', datum = '4 / 726', author = '虎扑JR0342489011', time = '09-21 10:58' }: Row): string {
	return (
		'<li class="bbs-sl-web-post-body"><div class="bbs-sl-web-post-layout">' +
		`<div class="post-title"><a href="/${pid}.html" target="_blank" class="p-title" style="color:;font-style:normal">${title}</a></div>` +
		`<div class="post-datum">${datum}</div>` +
		`<div class="post-auth"><a href="https://my.hupu.com/119335170812002">${author}</a></div>` +
		`<div class="post-time">${time}</div>` +
		'</div></li>'
	);
}

let cases = 0;

// 1. 版面页的顺序 = 输出顺序；新帖排在老长贴前面，且少回复不被过滤。
{
	const html = [
		row({ pid: '1', title: '刚打完的一场逆风翻盘', datum: '2 / 120', time: '09-21 13:30' }),
		row({ pid: '2', title: '几天前的高楼', datum: '500 / 99999', time: '09-11 09:00' }),
		row({ pid: '3', title: '刚发的新帖还没人回', datum: '0 / 12', time: '09-21 13:00' }),
	].join('');
	const threads = toThreads(html, nowSec);
	assert.ok(threads, '应该解析出帖子');
	assert.deepEqual(
		threads.map((thread) => thread.pid),
		['1', '2', '3'],
		'顺序要跟版面页一致，不能按回复数重排',
	);
	assert.equal(threads[0]?.replies, 2, '回复数照实解析');
	assert.equal(threads[0]?.views, 120, '浏览数照实解析');
	assert.equal(Math.round((nowSec - (threads[0]?.lastReplyAt ?? 0)) / 60), 30, '新帖是 30 分钟前的');
	assert.equal(threads[2]?.replies, 0, '0 回复的新帖也要在列表里，回复数不再是门槛');
	// 取前 1 条：旧实现会给出 500 回复那条，这正是这条断言能红的地方。
	assert.deepEqual(
		selectBoardThreads(threads, 1).map((thread) => thread.pid),
		['1'],
		'取前 N 取的是版面页最前面的，不是回复数最多的',
	);
	assert.equal(selectBoardThreads(threads).length, 3, '少于上限时原样返回');
	cases += 1;
}

// 2. 只有时间解不出来的行会被丢，其它字段坏掉的行也丢（不能编默认值）。
{
	const html = [
		row({ pid: '4', title: '时间是「刚刚」这种相对说法', time: '刚刚' }),
		row({ pid: '', title: '没有帖子 id' }),
		row({ pid: '6', title: '', datum: '3 / 10' }),
		row({ pid: '7', title: '', author: '', datum: '3 / 10', time: '09-21 09:00' }),
	].join('');
	assert.deepEqual(toThreads(html, nowSec), [], '解不出来的行一律丢掉，不做兜底猜测');

	const empty = toThreads('<ul></ul>', nowSec);
	assert.equal(empty, null, '一行都没匹配到时要给 null，让调用方知道"页面结构变了"而不是"今天没帖子"');
	cases += 1;
}

// 3. 跨年的 `MM-DD` 不能解析成未来时间。
{
	const threads = toThreads(row({ pid: '8', title: '去年年底的帖子', time: '12-31 23:30' }), nowSec);
	const at = threads?.[0]?.lastReplyAt ?? 0;
	assert.ok(at > 0 && at < nowSec, `解析出的时间必须是过去：${at} vs ${nowSec}`);
	assert.equal(new Date(at * 1000).getUTCFullYear(), 2025, '比"现在"晚的日期退回上一年');
	cases += 1;
}

// 4. 上限生效，且截的是尾巴不是重排。
{
	const html = Array.from({ length: 30 }, (_, index) =>
		row({
			pid: String(100 + index),
			title: `第 ${index + 1} 条`,
			datum: `${30 - index} / 100`,
			time: '09-21 12:00',
		}),
	).join('');
	const threads = toThreads(html, nowSec) ?? [];
	assert.equal(threads.length, 30, '30 行都要解析出来');
	const picked = selectBoardThreads(threads);
	assert.equal(picked.length, 20, '默认取前 20 条');
	assert.deepEqual(
		picked.map((thread) => thread.pid),
		threads.slice(0, 20).map((thread) => thread.pid),
		'取的就是版面页最前面那 20 条',
	);
	cases += 1;
}

console.log(`hupuBoard.check: ${cases} 组用例通过`);
