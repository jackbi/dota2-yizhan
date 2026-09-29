import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `src/worker/partyRoom.ts`（房间 DO + 大厅 DO）与 `src/scripts/partyRoom.ts`（客户端）里
 * 几条**在本地根本跑不出来**的不变量。
 *
 * Durable Object 在本地预览里跑不起来（WebSocket Hibernation、alarm、storage 都是 workerd
 * 的东西），所以这一块的行为没法像别处那样喂输入看输出。但踩过的坑都集中在时序上，而那些
 * 时序在源码里是看得出来的：
 *
 * 1. **空置保留期不能被宽限唤醒顺手吃掉。** 宽限到点摘完人，名册刚好变空——但"名册空"
 *    不等于"空置到期"。上一版就是这么写的，于是最后一个人断线 20 秒后房间连同聊天、
 *    roll、队伍位置一起没了，而文档承诺保留 10 分钟。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/partyRoom.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 去掉注释行：注释里写着"上一版是这么写的"，不摘掉就会被自己的说明骗过去。 */
function stripComments(source: string): string {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
		})
		.join('\n');
}

const worker = stripComments(readFileSync(new URL('../src/worker/partyRoom.ts', import.meta.url), 'utf8'));
const client = stripComments(readFileSync(new URL('../src/scripts/partyRoom.ts', import.meta.url), 'utf8'));

// 1. 空置保留期：alarm 里删房间之前必须判"空置够久"
{
	const start = worker.indexOf('async alarm()');
	const end = worker.indexOf('private async join(');
	assert.ok(start > 0 && end > start, '没能从 partyRoom.ts 里切出 alarm()，解析多半坏了');
	const alarm = worker.slice(start, end);

	assert.ok(alarm.includes('emptySince'), 'alarm() 要按 emptySince 判空置时长，不能只看名册空不空');
	assert.ok(alarm.includes('EMPTY_ROOM_TTL_MS'), 'alarm() 要引空置保留期');
	assert.ok(
		alarm.indexOf('EMPTY_ROOM_TTL_MS') < alarm.indexOf('deleteAll()'),
		'空置时长的判定必须排在 deleteAll() 之前',
	);
	assert.ok(
		!/members\.length === 0\) \{\s*const code = this\.stored\.code/.test(alarm),
		'alarm() 里不该再有"名册空就删房间"那种写法：宽限唤醒刚把人摘掉时名册也是空的',
	);
	assert.ok(
		/emptySince \?\? Date\.now\(\)\) \+ EMPTY_ROOM_TTL_MS/.test(worker),
		'scheduleAlarm() 的空房 deadline 要从 emptySince 算，而不是从"现在"算',
	);
	assert.ok(
		/this\.stored\.emptySince = this\.stored\.state\.members\.length === 0 \? Date\.now\(\) : undefined/.test(worker),
		'名册变空那一刻要记下 emptySince（并在这之后清掉）',
	);
	assert.match(worker, /this\.stored\.emptySince = undefined;\n\s*if \(!roster\)/, '有人进房要清掉 emptySince');
	ok('空房保留期：名册空 != 空置到期');
}

// 2. 客户端：节拍不抢在退避阶梯前面，且同一时刻只留一个重连计时器
{
	assert.ok(client.includes('lobbyRetryAt') && client.includes('roomRetryAt'), '重连要让出"下一次允许尝试的时刻"');
	assert.ok(
		/Date\.now\(\) >= lobbyRetryAt\) connectLobby\(\)/.test(client),
		'大厅的 5 秒节拍要先看退避排的时间点',
	);
	assert.ok(
		/Date\.now\(\) >= roomRetryAt\) openRoomSocket\(\)/.test(client),
		'房间的 5 秒节拍要先看退避排的时间点',
	);
	assert.ok(
		!/if \(!lobbySocket \|\| lobbySocket\.readyState > WebSocket\.OPEN\) connectLobby\(\);/.test(client),
		'不该再有"只要 socket 不是 OPEN 就连"的写法：那会把退避阶梯跨过去',
	);
	assert.ok(client.includes('window.clearTimeout(lobbyReconnectTimer)'), '大厅重连也要只留一个计时器（close 与回到前台都会排）');
	ok('重连节拍让位于退避阶梯');
}

// 3. 跨文件：宽限期要盖得住客户端阶梯的最后一次尝试
{
	const ladder = /const RECONNECT_DELAYS_MS = \[([^\]]+)\]/.exec(client)?.[1];
	assert.ok(ladder, '没解析出客户端的退避阶梯');
	const delays = ladder.split(',').map((part) => Number(part.trim().replace(/[_\s]/g, '')));
	assert.ok(delays.length >= 3 && delays.every((value) => Number.isFinite(value) && value > 0), `退避阶梯解析异常：${ladder}`);
	const lastAttemptAt = delays.reduce((sum, value) => sum + value, 0);

	const grace = Number(/const MEMBER_GRACE_MS = ([\d_]+)/.exec(worker)?.[1]?.replace(/_/g, ''));
	assert.ok(Number.isFinite(grace) && grace > 0, '没解析出服务端的宽限期');
	assert.ok(
		grace >= lastAttemptAt,
		`宽限期 ${grace}ms 盖不住最后一次重连尝试（阶梯累加到 ${lastAttemptAt}ms）：人会在自己下一次尝试之前被摘掉`,
	);
	ok(`宽限期（${grace}ms）盖得住阶梯的最后一次尝试（${lastAttemptAt}ms）`);
}

// 4. 上报大厅：删房间那条也要发得出、且看 res.ok
{
	const start = worker.indexOf('private async tellLobby(');
	const end = worker.indexOf('export class PartyLobby');
	assert.ok(start > 0 && end > start, '没能切出 tellLobby()');
	const tell = worker.slice(start, end);

	assert.ok(
		!/private async tellLobby\(code: string, count: number\): Promise<void> \{\s*if \(!this\.stored\) return;/.test(tell),
		'tellLobby 不能因为 this.stored 是 null 就早退：房间到期删除是"先清 stored 再报没人了"',
	);
	assert.ok(tell.includes('response.ok'), 'tellLobby 要看 res.ok：只看有没有抛异常会把 4xx/5xx 当成功');
	assert.ok(/LOBBY_REPORT_ATTEMPTS/.test(tell), '"房间没了"那条上报要重试：删掉之后没有下一次机会了');
	assert.ok(worker.includes('pruneStale'), '大厅要有按 at 的兜底清理，否则一次都没送达的上报会留一张永久卡片');

	/*
	 * 兜底清理的反面：安静但有人的房间不能被当成幽灵摘掉。
	 *
	 * `at` 只在"有人进出或操作"时更新，而心跳（每 20 秒一条 ping）原先只回 pong——一屋子人
	 * 安安静静打一下午，卡片会在 6 小时后消失。所以心跳要顺手刷新卡片，并且限速。
	 */
	/*
	 * 钉精确形状，不是"整个文件里有这么一句"：挪出 ping 分支、或者挪到限流之前，都还是那句。
	 * 另外两条同源——
	 * 1. `at` 是列表的排序键，只有真的变了才能往前走。心跳跟着盖戳的话，安静但有人的房间
	 *    每 15 分钟被重新盖一次，插到真正活跃的房间前面，还让所有订阅者重收一遍列表；
	 * 2. 限速戳要在**发之前**盖。只在 response.ok 里盖的话，大厅 5xx、或者 stub 直接抛错时
	 *    戳子不更新，闸门一直开着——每条心跳（25 秒一次）都重发一遍。
	 */
	assert.match(worker, /message\.t === 'ping'[\s\S]{0,200}?await this\.refreshLobbyCard\(\);/, '心跳要顺手刷大厅卡片');
	assert.match(
		worker,
		/prev && beat && prev\.name === name && prev\.count === count \? prev\.at : Date\.now\(\)/,
		'心跳要保住 at：列表排序按"最后一次变动"',
	);
	assert.match(worker, /seenAt: Date\.now\(\)/, '存活要另开一个 seenAt 字段记');
	assert.match(
		worker,
		/now - \(room\.seenAt \?\? room\.at\) > LOBBY_ROOM_TTL_MS/,
		'兜底清理要按最后一次上报（含心跳）判，不能按最后一次变动',
	);
	const ms = (name: string): number => {
		const raw = new RegExp(`const ${name} = ([^;]+);`).exec(worker)?.[1]?.replace(/_/g, '').trim() ?? '';
		const match = /^(\d+)(?:\s*\*\s*(\d+))?$/.exec(raw);
		assert.ok(match, `没解析出 ${name}（现在是 ${raw}）`);
		return Number(match?.[1] ?? 0) * Number(match?.[2] ?? 1);
	};
	assert.ok(
		ms('LOBBY_HEARTBEAT_MS') > 0 && ms('LOBBY_HEARTBEAT_MS') < ms('LOBBY_ROOM_TTL_MS'),
		'心跳间隔要小于大厅卡片的兜底寿命，否则刷了也白刷',
	);
	assert.match(
		worker,
		/Date\.now\(\) - \(this\.stored\.lobbyReportedAt \?\? 0\) < LOBBY_HEARTBEAT_MS/,
		'心跳刷新要按上次上报时刻限速（否则每条 ping 都写一次 storage）',
	);
	assert.ok(
		tell.indexOf('this.stored.lobbyReportedAt = Date.now();') < tell.indexOf('for (let attempt'),
		'限速戳要在发上报之前就盖上：只在 response.ok 里盖的话，大厅报错时闸门一直开着',
	);
	assert.ok(
		!/if \(response\.ok\) \{[\s\S]{0,200}?lobbyReportedAt/.test(tell),
		'不要只在 response.ok 里盖限速戳（那正是上一版的问题）',
	);
	ok('大厅上报与兜底清理');
}

// 5. 房间码：路由与房间 DO 必须用同一个解析函数
{
	/*
	 * 这一条是上一条修复的漏网：路由换了 `parseRoomPath`，DO 却还在用会**过滤字符**的
	 * `normalizeCode` 处理未解码的路径段。两种判据并存时别名照样成立——`%20ABCDE%20` 在路由侧
	 * 是 `ABCDE`（路由到 DO ABCDE），在 DO 里被过滤成 `2ABCD`（`%20` 里的 2 在字母表内），
	 * 房间于是自称成另一个码，能覆盖并删掉真房间在大厅的卡片。
	 */
	assert.match(worker, /const code = parseRoomPath\(new URL\(request\.url\)\.pathname\)/, 'DO 要用路由那一套解析房间码');
	assert.ok(
		!/this\.code = L\.normalizeCode\(/.test(worker),
		'DO 不能再对路径段用 normalizeCode：它会过滤字符、造出别名',
	);
	assert.ok(!/pathname\.split\('\/'\)\.pop\(\)/.test(worker), '别再手拆路径段取房间码');
	ok('房间码：路由与 DO 同一个解析函数');
}

console.log(`partyRoom 全部断言通过（${cases} 组）`);
