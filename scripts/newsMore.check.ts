import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderNewsCard, renderThreadCard } from '../src/lib/cardHtml.ts';
import { hupuBoardUrl } from '../src/lib/hupuBoard.ts';
import { MORE_SOURCES, MAX_MORE_PAGE } from '../src/lib/listMore.ts';
import { newsFeedPageUrl, parseNewsFeedPage } from '../src/lib/newsFeed.ts';
import { ngaHotUrl, parseHotThreads } from '../src/lib/ngaThread.ts';
import { chaohuaFeedUrl, chaohuaNextCursor, cleanWeiboText, parseChaohuaFeed, parseCreatedAt, toWeiboCard } from '../src/lib/weiboChaohua.ts';
import { listItemToNewsCard, parseWmpvpList, wmpvpListUrl } from '../src/lib/wmpvpList.ts';

/**
 * 资讯列表「加载更多」这一层的自检。
 *
 * 与 `communityFloors.check.ts` 同样的处境：**坏掉了页面照样能看**——按钮点不动、翻回来一批
 * 重复的、卡片没转义、页码其实被上游忽略，都不会报错。所以钉五件事：
 *
 * 1. **分页形态**：官网是 `indexN.htm`、完美世界是 `pageNum`、虎扑是 `/dota2-N`，
 *    而 **NGA 的热榜接口压根没有分页**（`&page=N` 返回同一份），所以那一栏是本地切片；
 *    微博超话反过来——**它没有 page 参数**，只能靠 `since_id` 游标走。两条都最容易
 *    想当然写错（"带上 page 就能翻页"），钉死。
 * 2. **解析**：四个来源各自的字段口径（NGA 要滤掉锁定帖与合集、少于 5 条回复的不算热帖）。
 * 3. **渲染只有一份**：卡片标记住在 `cardHtml.ts`，`.astro` 组件只是它的壳——用户文本必须转义。
 * 4. **接口的边界**：不可索引、页码有上限、source 白名单、Reddit 明说没有分页。
 * 5. **页面与客户端的约定**：列表容器、`data-key`、按钮块、标签页切换后要重新查一遍卡片。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/newsMore.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// ---------------------------------------------------------------- 分页形态

{
	assert.equal(newsFeedPageUrl('/news', 1), 'https://www.dota2.com.cn/news/index.htm', '官网第 1 页是 index.htm');
	assert.equal(newsFeedPageUrl('/news', 4), 'https://www.dota2.com.cn/news/index4.htm', '第 4 页是 index4.htm');
	assert.match(wmpvpListUrl(3), /pageNum=3&pageSize=20$/, '完美世界用 pageNum');
	assert.equal(hupuBoardUrl(1), 'https://bbs.hupu.com/dota2', '虎扑第 1 页是板块地址本身');
	assert.equal(hupuBoardUrl(2), 'https://bbs.hupu.com/dota2-2', '虎扑第 2 页是 /dota2-2');
	assert.ok(
		!/page=/.test(ngaHotUrl(7)),
		'NGA 的热榜地址**不能**带 page 参数：实测带上也返回同一份，那是假的翻页',
	);
	assert.equal(
		chaohuaFeedUrl(),
		'https://weibo.com/ajax_proxy/chaohua/page?flowId=1008080a7614bd4a7b1331677f9bc690323e64_-_sort_time',
		'微博超话取的是「最新发帖」那个 flowId',
	);
	assert.ok(!/page=/.test(chaohuaFeedUrl()), '微博这一栏也不能拼 page 参数');
	assert.match(
		chaohuaFeedUrl('{"max_id":1}'),
		/&since_id=%7B%22max_id%22%3A1%7D$/,
		'翻页只认 since_id 游标，且要编码后回传',
	);
	ok('五个来源的分页形态（NGA 没有上游分页、微博只认 since_id 游标）');
}

// ---------------------------------------------------------------- 解析

{
	const html = `
		<a href="https://www.dota2.com.cn/article/details/220533.html" class="item">
			<img src="https://cdn.example/1.jpg" />
			<h2 class="title">标题 &amp; 实体</h2>
			<p class="date">2026-10-01</p>
		</a>
		<a href="https://www.dota2.com.cn/article/details/220534.html" class="item">
			<h2 class="title">第二条</h2>
			<p class="date">2026-09-30</p>
		</a>
		<a href="/other" class="other">不是条目</a>`;
	const items = parseNewsFeedPage(html);
	assert.equal(items.length, 2, '只认 class="item" 的条目');
	assert.equal(items[0].id, '220533', 'id 从详情页地址里取');
	assert.equal(items[0].title, '标题 & 实体', '标题要还原实体、去掉标签');
	assert.equal(items[0].img, 'https://cdn.example/1.jpg');
	assert.equal(items[1].img, '', '没有配图就是空串');
	ok('官网列表页：条目、id、标题与配图');
}

{
	const data = {
		result: [
			{ news: { newsId: 304298, title: '一条', publishTime: 1791000000000, thumbnail: 'https://cdn/x.jpg' } },
			{ banner: { id: 1 } },
			{ news: { title: '没有 id' } },
		],
	};
	const items = parseWmpvpList(data);
	assert.equal(items.length, 1, '只留带 news 且字段齐的条目');
	assert.equal(items[0].id, '304298');
	assert.equal(items[0].date, '2026-10-03', '毫秒时间戳按东八区切成 YYYY-MM-DD');
	// 运行时那张卡不能带配图：图床只认它自己的 Referer，热链必然是裂图。
	assert.equal(listItemToNewsCard(items[0]).img, undefined, '运行时的完美世界卡片不带配图');
	assert.equal(items[0].cover, 'https://cdn/x.jpg', '数据层仍然保留原始封面地址');
	ok('完美世界列表：字段口径与「运行时不带配图」');
}

{
	const hot = {
		data: [
			[
				{ tid: 1, subject: '热帖', author: 'a', replies: 30, postdate: 1791000000, lastpost: 1791000500 },
				{ tid: 2, subject: '锁定的', author: 'b', replies: 50, type: 1024 },
				{ tid: 3, subject: '合集入口', author: 'c', replies: 50, type: 32768 },
				{ tid: 4, subject: '回复太少', author: 'd', replies: 2 },
			],
		],
	};
	const threads = parseHotThreads(hot);
	assert.deepEqual(
		threads?.map((thread) => thread.tid),
		['1'],
		'锁定帖、合集入口与回复数不够的都要滤掉',
	);
	assert.equal(threads?.[0].replies, 30);
	ok('NGA 热榜：滤锁定与合集、按回复数门槛');
}

{
	// 形状照抄接口的真实返回：items 里混着 cell / card，只有 category=feed 的是帖子。
	const json = {
		items: [
			{ category: 'cell', type: 'span' },
			{ category: 'card', data: { card_type: 121, itemid: 'page_feed_child_tab' } },
			{
				category: 'feed',
				data: {
					idstr: '5351770596577510',
					mblogid: 'RlIMXrB6S',
					created_at: 'Thu Oct 08 15:36:44 +0800 2026',
					text:
						'拼豆邮票 &amp; 表情<img alt="[泪]" src="https://face.t.sinajs.cn/x.png"/>' +
						'<a href="https://s.weibo.com/weibo?q=%23dota2%23">#dota2#</a>\u200b',
					reposts_count: 4,
					comments_count: 3,
					attitudes_count: 12000,
					pic_ids: ['p1'],
					pic_infos: {
						p1: {
							bmiddle: { url: 'https://wx2.sinaimg.cn/wap360/p1.jpg' },
							large: { url: 'https://wx2.sinaimg.cn/large/p1.jpg' },
						},
					},
					user: { idstr: '2726969131', screen_name: 'akimo秋葉' },
				},
			},
			// 缺 mblogid：拼不出原帖地址，卡片点开就是个死链，宁可不要。
			{ category: 'feed', data: { idstr: '9', user: { idstr: '1' } } },
		],
		moreInfo: { params: { since_id: '{"max_id":5351690595205570}', page: 2 } },
	};
	const posts = parseChaohuaFeed(json);
	assert.equal(posts.length, 1, '只认 feed 条目，缺 mblogid 的要丢掉');
	const post = posts[0];
	assert.equal(post.id, '5351770596577510');
	assert.equal(post.url, 'https://weibo.com/2726969131/RlIMXrB6S', '原帖地址由 uid + mblogid 拼');
	assert.equal(post.text, '拼豆邮票 & 表情[泪]#dota2#', '表情留 alt 文字、标签只留文字、实体要还原');
	assert.equal(
		post.createdAt,
		Date.UTC(2026, 9, 8, 7, 36, 44) / 1000,
		'微博给的是 +0800 的字面时间，解析时不能跟着构建机时区漂',
	);
	assert.equal(post.image, 'https://wx2.sinaimg.cn/wap360/p1.jpg', '卡片图取 bmiddle 那档');
	assert.equal(chaohuaNextCursor(json), '{"max_id":5351690595205570}', '游标原样回传');
	assert.equal(chaohuaNextCursor({ items: [] }), null, '没有 moreInfo 就是没有下一页');
	assert.equal(parseCreatedAt('不是时间'), 0, '解不出的时间给 0，别让 NaN 进到页面上');

	const card = toWeiboCard({ ...post, localImage: '/weibo-pics/5351770596577510-1234abcd.jpg' });
	assert.equal(card.href, post.url, '这一栏直指原帖（站内不镜像）');
	assert.equal(card.img, '/weibo-pics/5351770596577510-1234abcd.jpg');
	assert.equal(card.badge, '微博');
	assert.equal(card.date, '2026-10-08', '日期按 UTC+8 落成 YYYY-MM-DD');
	assert.match(card.title, /拼豆邮票/, '正文进标题');
	assert.match(card.meta, /转发 4/, '互动数进卡片底部');

	// 纯转发自己没有正文，不能渲染成一块空白。
	const repost = parseChaohuaFeed({
		items: [
			{
				category: 'feed',
				data: {
					idstr: '5',
					mblogid: 'Abc123',
					created_at: 'Thu Oct 08 15:36:44 +0800 2026',
					text: '',
					user: { idstr: '1', screen_name: '转发的人' },
					retweeted_status: { text: '被转发的原文' },
				},
			},
		],
	});
	assert.equal(repost[0].text, '转发：被转发的原文', '没有正文的转发要拿原文顶上');
	ok('微博超话：feed 解析、时间口径、原帖地址与卡片');
}

// ---------------------------------------------------------------- 卡片标记

{
	const card = renderNewsCard({
		id: '1',
		title: '<script>alert(1)</script>',
		summary: '摘要 & 符号',
		date: '2026-10-01',
		tags: ['国服资讯'],
		meta: '来源：测试',
		href: '/news/1/',
	});
	assert.ok(!card.includes('<script>alert(1)</script>'), '标题是用户文本，必须转义');
	assert.match(card, /href="\/news\/1\/"/, '站内详情页链接照规范形态写');
	assert.match(card, /摘要 &amp; 符号/, '摘要里的 & 也要转义');

	const thread = renderThreadCard(
		{
			id: 'nga-1',
			source: 'nga',
			title: '标题',
			author: '楼主',
			replies: 12,
			lastReplyAt: 1791000000,
			summary: '',
			href: '/community/nga/1/',
		},
		1791003600,
	);
	assert.match(thread, /12 回复/);
	assert.match(thread, /href="\/community\/nga\/1\/"/);
	assert.match(thread, /最后回复/, '社区帖卡要有最后回复时间');
	ok('卡片标记：转义、链接与关键信息');
}

// ---------------------------------------------------------------- 接口与页面的约定

{
	const api = readFileSync(new URL('../src/pages/api/news/more.ts', import.meta.url), 'utf8');
	assert.match(api, /'X-Robots-Tag': 'noindex'/, '这条接口不可索引');
	assert.match(api, /page > MAX_MORE_PAGE/, '页码要有上限');
	assert.match(api, /MORE_SOURCES\.includes/, 'source 走白名单');
	assert.match(api, /source === 'reddit'/, 'Reddit 要明确说"没有分页"，而不是静默失败');
	assert.ok(!/href=/.test(api), '接口里不该出现链接');
	assert.ok(MAX_MORE_PAGE >= 10 && MORE_SOURCES.length === 5, '五条来源、上限别小到翻不了几页');
	assert.ok(MORE_SOURCES.includes('weibo'), '微博那一栏要能翻页');

	const page = readFileSync(new URL('../src/pages/news.astro', import.meta.url), 'utf8');
	assert.match(page, /data-more data-sources=\{MORE_SOURCES\.join\(','\)\}/, '按钮块要声明哪些栏能翻');
	assert.match(page, /data-key=\{card\.id\}/, '首屏卡片要带 key：浏览器靠它去重');
	assert.match(page, /data-key=\{post\.id\}/, '社区帖卡也要带 key');
	assert.match(page, /data-source="weibo"/, '微博那一栏首屏卡片也要挂 data-source，标签页才认');
	assert.match(page, /'#weibo': 'weibo'/, '带锚进页面要能落到微博那一栏');
	assert.match(page, /import '\.\.\/scripts\/newsMore'/, '页面要引入加载逻辑');
	// 列表是活的：切栏时只按开场查一次快照的话，后追加的卡片不会被藏起来。
	assert.match(
		page,
		/const apply = \(\) => \{[\s\S]{0,200}?list\.querySelectorAll<HTMLElement>\('\[data-source\]'\)/,
		'标签页的显隐逻辑必须每次重新查列表（否则追加的卡片切栏后还留着）',
	);

	const script = readFileSync(new URL('../src/scripts/newsMore.ts', import.meta.url), 'utf8');
	assert.match(script, /data-key="\$\{item\.key\}"/, '追加时要带上 key，供下一次去重');
	assert.match(script, /data-source="\$\{source\}"/, '追加的外层要写 data-source，标签页才认');
	ok('接口与页面：noindex、上限、Reddit 说明、key 与「列表是活的」');
}

console.log(`newsMore 全部断言通过（${cases} 组）`);
