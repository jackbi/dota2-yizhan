import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `/party` 拖拽归队的静态自检。
 *
 * HTML5 拖拽的坑几乎全是**静默**的：写错了不报错、不抛异常，只是「拖过去什么都没发生」。
 * 在真浏览器里逐个试代价太高，所以把踩过的规则固化成断言，全部在 `src/scripts/partyRoom.ts` 上检查：
 *
 * 1. `dragover` 必须 `preventDefault()`：不调的话浏览器认为该处不接受放置，`drop` 压根不触发；
 * 2. `dragover` 必须设 `dropEffect = 'move'`：否则光标显示成「复制」甚至「禁止」；
 * 3. `dragstart` 必须 `setData()`：不设数据时 **Firefox 根本不会开始拖拽**（哪怕我们只读自己的变量）；
 * 4. `draggable` 只能挂在手柄上，不能挂在成员卡上：卡里嵌着归队用的 `<select>`，
 *    祖先带 `draggable` 之后那些控件在部分浏览器里点不动；
 * 5. 客户端**不许自己改状态**：挪人只有 `moveMemberTo()` 一条入口，它把请求发给服务端；
 *    「房主能挪任何人、其他人只能挪自己」这条规则在 Durable Object 里判（这里顺带断言它还在），
 *    否则权限判断会散落到各处，迟早走偏；
 * 6. 重建队伍区前必须 `clearDrag()`：`replaceChildren()` 会把拖拽源节点从文档里摘掉，浏览器随即
 *    中止拖拽，而 `dragend` 落在脱离文档的节点上、冒泡不到 `document`，于是 `draggingMemberId`
 *    永远停在那个幽灵身上；
 * 7. `dropZoneOf()` 查找的 `data-drop-*` 标记必须真的有人写，否则放置区永远匹配不到；
 * 8. 拖拽源与拖影、以及「外部拖进来的东西（文件等）不算数」这几件事都得在代码里落实。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/partyDrag.check.ts`）。
 */

const script = readFileSync(new URL('../src/scripts/partyRoom.ts', import.meta.url), 'utf8');

/** 从 `{` 开始配平到对应的 `}`，跳过字符串与注释（不然字符串里的括号会把配平带偏）。 */
function balancedBlock(source: string, openIndex: number): string {
	assert.equal(source[openIndex], '{', 'balancedBlock 得从 { 开始');
	let depth = 0;
	for (let i = openIndex; i < source.length; i += 1) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === '/' && next === '/') {
			i = source.indexOf('\n', i);
			if (i === -1) break;
			continue;
		}
		if (ch === '/' && next === '*') {
			i = source.indexOf('*/', i) + 1;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			for (i += 1; i < source.length && source[i] !== ch; i += 1) {
				if (source[i] === '\\') i += 1;
			}
			continue;
		}
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(openIndex, i + 1);
		}
	}
	throw new Error('括号没配上：解析坏了，先确认 partyRoom.ts 的格式');
}

function functionBody(name: string): string {
	const match = new RegExp(`function ${name}\\s*\\(`).exec(script);
	assert.ok(match, `找不到 ${name}()`);
	const open = script.indexOf('{', match.index + match[0].length);
	return balancedBlock(script, open);
}

/** 取 `document.addEventListener('<type>', …)` 那个回调的函数体。 */
function listenerBody(type: string): string {
	const marker = `addEventListener('${type}',`;
	const at = script.indexOf(marker);
	assert.ok(at >= 0, `找不到 ${type} 监听`);
	const open = script.indexOf('{', at + marker.length);
	return balancedBlock(script, open);
}

const dragStart = listenerBody('dragstart');
const dragOver = listenerBody('dragover');
const drop = listenerBody('drop');

// 规则 1：不 preventDefault 就等于没有放置区。
assert.match(dragOver, /preventDefault\(\)/, 'dragover 里必须 preventDefault()，否则 drop 永远不触发');
// 只认本站发起的拖拽：文件从桌面拖进来不该高亮、更不该挪人。
assert.match(dragOver, /if \(!draggingMemberId/, 'dragover 要先确认拖的是房间里的人');
assert.match(drop, /if \(!memberId \|\| !zone\)/, 'drop 要兜住「不是我们的拖拽」的情况');

// 规则 2：光标反馈。
assert.match(dragOver, /dropEffect\s*=\s*'move'/, "dragover 里必须 dropEffect = 'move'");

// 规则 3：Firefox 的硬性要求。
assert.match(dragStart, /dataTransfer\.setData\(/, 'dragstart 里必须 setData()，否则 Firefox 不会开始拖拽');

// 规则 4：手柄才可拖，卡片不可拖。
const draggableAssignments = [...script.matchAll(/\.draggable\s*=\s*true/g)];
assert.equal(
	draggableAssignments.length,
	1,
	`只有拖拽手柄能设 draggable，现在有 ${draggableAssignments.length} 处`,
);
assert.ok(functionBody('dragHandle').includes('draggable = true'), 'draggable 必须在 dragHandle() 里');
assert.match(functionBody('dragHandle'), /h\(\s*'span'/, '手柄要是个 span，别做成按钮');
assert.ok(
	!functionBody('memberCard').includes('draggable'),
	'成员卡本身不能可拖：卡里嵌着归队用的 <select>，祖先 draggable 会让它点不动',
);

// 规则 5：客户端只发请求，改状态的是服务端（`src/worker/partyRoom.ts`）。
// 客户端**一次都不该**直接调 `L.moveMember()`——那意味着本地权威又回来了。
const moveCalls = [...script.matchAll(/L\.moveMember\(/g)];
assert.equal(moveCalls.length, 0, `客户端不该直接改房间状态，现在有 ${moveCalls.length} 处 L.moveMember()`);
assert.match(
	functionBody('moveMemberTo'),
	/sendToRoom\(\{ t: 'move'/,
	'moveMemberTo() 只能把 move 请求发给服务端',
);
assert.match(drop, /moveMemberTo\(/, 'drop 必须走 moveMemberTo()');
assert.ok(!/hostMutate|cmd\.send/.test(drop), 'drop 里不许直接改状态或发指令：权限判断只留一处');

// 权限判断现在在服务端：非房主只能挪自己。它丢了的话，谁都能把别人的位置挪走。
const worker = readFileSync(new URL('../src/worker/partyRoom.ts', import.meta.url), 'utf8');
assert.match(worker, /message\.memberId !== clientId && !isHost/, '服务端必须拦住「非房主挪别人」');

/*
 * 规则 8：两处「静默失效」的复核——写错了页面照样看着正常，只是能力没了。
 *
 * - **`startTicker` 不能被定义两层**：曾经的外层函数只声明内层就返回，`boot()` 那句调用
 *   是空操作，5 秒节拍（刷新网络状态、捞回半开连接）从来没跑过。
 * - **大厅的房间列表必须落盘**：`PartyLobby` 与 `PartyRoom` 一样用 Hibernation，
 *   只放内存的话 DO 一被回收列表就归零，订阅者随后收到一份「只剩一个房间」的列表。
 */
const tickerDefinitions = (script.match(/function startTicker/g) ?? []).length;
assert.equal(tickerDefinitions, 1, `startTicker 只该定义一次，现在有 ${tickerDefinitions} 处（嵌套时外层调用是空操作）`);
assert.match(script, /^\s*startTicker\(\);/m, 'boot() 里要真的调用 startTicker');
const tickerBody = functionBody('startTicker');
assert.ok(tickerBody.includes('setInterval('), '节拍要在 startTicker 里');
assert.ok(tickerBody.includes('}, 5000);'), '节拍间隔要是 5 秒');
assert.ok(tickerBody.includes('renderNet()'), '节拍要刷新网络状态');
assert.match(worker, /ctx\.storage\.get<LobbyRoom\[\]>\('rooms'\)/, '大厅要能从 storage 读回房间列表（Hibernation 会回收内存）');
assert.match(worker, /this\.ctx\.storage\.put\('rooms'/, '房间列表变化后要写回 storage');

/*
 * 规则 9：断线宽限期与「按连接」限流——两条都是协议里承诺过、但坏掉了不会报错的东西。
 *
 * - 断开时当场 `removeMember` 的话，刷新页面会把名册、队伍位置、roll 结果一起清掉，房主还会
 *   被换掉，`clientId` 那套重连的承诺就落空了。
 * - 限流按 `clientId`（找不到就 `'anon'`）记账时：换 id 就能绕过，而所有未进房的连接共用
 *   一个桶，一个陌生 socket 连发 60 条就能让每个人的 join 都被判超限。
 */
assert.ok(worker.includes('const MEMBER_GRACE_MS = 20_000'), '断线要留宽限期');
assert.ok(
	worker.includes('this.stored.pending = { ...(this.stored.pending ?? {}), [clientId]: Date.now() }'),
	'断开时只记待清理时刻，不立刻摘人',
);
assert.ok(worker.includes('private async sweepPending()'), '宽限期到了要有清理');
assert.equal((worker.match(/L\.removeMember\(/g) ?? []).length, 1, '摘人只该发生在宽限期清理那一处');
assert.ok(worker.includes('rateAt'), '限流计数要按连接存在 attachment 里');
assert.ok(!worker.includes("clientId || 'anon'"), '限流不能再用共享的 anon 桶');

// 规则 6：重新渲染前清拖拽状态。
assert.match(functionBody('renderTeams'), /clearDrag\(\)/, 'renderTeams() 必须先 clearDrag()');
assert.match(functionBody('renderRoom'), /clearDrag\(\)/, 'renderRoom() 没拿到快照的分支也要 clearDrag()');

// 规则 7：放置区标记两边都得有（查找 + 写入）。
const lookup = functionBody('dropZoneOf');
for (const marker of ['data-drop-team', 'data-drop-pool']) {
	assert.ok(lookup.includes(marker), `dropZoneOf() 没查 ${marker}`);
}
for (const prop of ['dropTeam', 'dropPool']) {
	assert.ok(script.includes(`dataset.${prop} =`), `没有任何地方写 dataset.${prop}，这个放置区永远匹配不到`);
}

// 规则 8：拖拽源认得出来，拖影像样。
assert.match(functionBody('dragHandle'), /dataset\.memberDrag\s*=/, '手柄必须写 data-member-drag');
assert.match(dragStart, /\[data-member-drag\]/, 'dragstart 必须按 [data-member-drag] 找手柄');
assert.match(dragStart, /setDragImage\(/, '拖影要用整张卡片，否则只有手柄那么大');
assert.match(dragStart, /effectAllowed\s*=\s*'move'/, 'dragstart 要声明 effectAllowed');
assert.match(dragStart, /'text\/plain'/, 'dataTransfer 的类型要和读取方一致');

console.log('party 拖拽归队断言通过（8 条规则）');
