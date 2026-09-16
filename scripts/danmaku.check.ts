import assert from 'node:assert/strict';
import { DANMAKU_PORTS, decodeDouyuPackets, encodeDouyuPacket, retryDelay } from '../src/lib/douyuDanmaku.ts';

/**
 * `src/lib/douyuDanmaku.ts` 的自检。
 *
 * 弹幕协议没有文档，全靠「从斗鱼页面自己发的包上抄」——所以这里放的用例也全是**抓下来的真包**
 * （`chatmsg` 那条是 yyf 直播间 9999 的原样正文；`loginres` 那种特别长的按同结构截短了）。
 * 编解码一错，格子里就是「一条弹幕都不出来」，而现场又没法调试（浏览器控制台里只有 WS 帧），
 * 所以这类纯函数必须在这里兜住。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/danmaku.check.ts`）。
 */

/** 服务器 → 客户端的包：同样的 12 字节头，类型换成 690。这里只为造用例，客户端不往这个方向发。 */
function serverFrame(...payloads: string[]): Uint8Array {
	const parts: number[] = [];
	for (const text of payloads) {
		const body = [...new TextEncoder().encode(`${text}\0`)];
		const total = 12 + body.length;
		const head = new Uint8Array(new Int32Array([total, total, 690]).buffer);
		parts.push(...head, ...body);
	}
	return new Uint8Array(parts);
}

/** 抓下来的真实正文：进场、聊天、在线列表各一条。 */
const CHAT = 'type@=chatmsg/rid@=9999/ct@=14/uid@=1707233/nn@=明天你好啊丷/txt@=POM急了 可以等龙骑跳先手的/cid@=d76ff4eed1544366ac965c0000000000/ic@=avatar_v3@S202303@Sa6a8cef5fa924a00bb25fd4e16b1b226/level@=44/sahf@=0/col@=1/cst@=1789539675945/';
const ENTER = 'type@=uenter/rid@=9999/uid@=2030095/nn@=黄金狮子/level@=39/sahf@=0/fl@=24/bl@=24/brid@=9999/if@=1/';
const OUL = 'type@=oul/un@=4029/rid@=9999/ul@=uid@AA=28836917@ASnn@AA=菜的理所应当@ASicon@AA=avatar_v3@AAS202609/';

let cases = 0;

// 1. 打包：长度写在头两段（同一个值，= 12 + 正文 + 1），第三段是 689，正文以 \0 收尾。
{
	const packet = encodeDouyuPacket('type@=mrkl/');
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	assert.equal(packet.byteLength, 12 + 'type@=mrkl/'.length + 1, '包长应该是 12 + 正文 + \\0');
	assert.equal(view.getInt32(0, true), packet.byteLength, '第一段长度不对');
	assert.equal(view.getInt32(4, true), packet.byteLength, '第二段长度应该和第一段一样');
	assert.equal(view.getInt32(8, true), 689, '类型应该是 689');
	assert.equal(new TextDecoder().decode(packet.subarray(12)), 'type@=mrkl/\0', '正文不对');
	cases += 1;
}

// 2. 一条帧里串着多个包（实测 `mrkl` / `oul` / `chatmsg` 会挤在一起），要全部拆出来。
{
	const packets = decodeDouyuPackets(serverFrame('type@=mrkl/', CHAT, ENTER, OUL));
	assert.deepEqual(
		packets.map((p) => p.type),
		['mrkl', 'chatmsg', 'uenter', 'oul'],
		'包的顺序或数量不对',
	);
	cases += 1;
}

// 3. 字段与转义：`@S` 是 `/`、`@A` 是 `@`，字段值里连 `@=` 都能出现。
{
	const [chat] = decodeDouyuPackets(serverFrame(CHAT));
	assert.equal(chat.fields.nn, '明天你好啊丷', '昵称（多字节）不对');
	assert.equal(chat.fields.txt, 'POM急了 可以等龙骑跳先手的', '正文不对');
	assert.equal(chat.fields.col, '1');
	assert.equal(chat.fields.cst, '1789539675945');
	// 头像串里的 `@S`：还原之后才是真正的路径。
	assert.equal(chat.fields.ic, 'avatar_v3/202303/a6a8cef5fa924a00bb25fd4e16b1b226', '`@S` 没有还原成 `/`');

	const [enter] = decodeDouyuPackets(serverFrame(ENTER));
	assert.equal(enter.fields.brid, '9999', '数字字段不该被当成别的东西');

	/*
	 * `oul` 的 `ul` 字段是**两层**转义：内层先把用户信息拼成 `uid@=.../nn@=...`，外层再照常转义
	 * （`@` 变 `@A`），于是原文里的 `@A` 到了这里成了 `@AA`、`@S` 成了 `@AS`。这里只解一层——
	 * 想要里面那几个字段得再解一次。格子里不画在线列表，就不多花这一遍。
	 */
	const [oul] = decodeDouyuPackets(serverFrame(OUL));
	assert.equal(
		oul.fields.ul,
		'uid@A=28836917@Snn@A=菜的理所应当@Sicon@A=avatar_v3@AS202609',
		'外层转义没有还原（或者多解了一层）',
	);
	cases += 1;
}

// 4. 正文里出现 `type@=` 这四个字符时**不能**被切开：斗鱼会把 `@` 转义成 `@A`，
//    所以真实帧里永远是 `type@A=`，切点唯一。这条是「按 `type@=` 切包」这个取法的命根子。
{
	const tricky = 'type@=chatmsg/rid@=9999/nn@=路人/txt@=type@A=这种写法不会被切开@S也不会/level@=1/';
	const packets = decodeDouyuPackets(serverFrame(tricky));
	assert.equal(packets.length, 1, '被误切成了多条');
	assert.equal(packets[0].type, 'chatmsg');
	assert.equal(packets[0].fields.txt, 'type@=这种写法不会被切开/也不会');
	cases += 1;
}

// 5. 帧前面那 12 字节二进制头（还原成字符串是乱码）不能变成一条弹幕。
{
	const packets = decodeDouyuPackets(serverFrame(CHAT));
	assert.equal(packets.length, 1);
	assert.equal(packets[0].type, 'chatmsg');
	cases += 1;
}

// 6. 端口表要覆盖实测见过的那几个（8501 / 8503 / 8506），否则「换一个再来」就是空转。
{
	for (const port of [8501, 8503, 8506]) assert.ok(DANMAKU_PORTS.includes(port as never), `端口 ${port} 不在表里`);
	assert.equal(new Set(DANMAKU_PORTS).size, DANMAKU_PORTS.length, '端口表里有重复');
	cases += 1;
}

// 7. 重试节奏：三档、越等越久、而且带抖动。
//
// 「越等越久」是防把观众自己的 IP 打成风控对象（实测同一出口短时间开十几次就会被静默无视）；
// 「有抖动」是防 9 个格子在同一秒一起重连——那看起来正是一个 IP 在猛敲。
{
	const ports = DANMAKU_PORTS.length;
	const span = (list: number[]): [number, number] => [Math.min(...list), Math.max(...list)];
	const [firstMin, firstMax] = span(Array.from({ length: ports }, (_, i) => retryDelay(i + 1)));
	const [secondMin, secondMax] = span(Array.from({ length: ports }, (_, i) => retryDelay(i + 1 + ports)));
	const [slowMin, slowMax] = span(Array.from({ length: ports }, (_, i) => retryDelay(i + 1 + ports * 2)));
	assert.ok(firstMin >= 1500 && firstMax <= 2000, `第一圈该在 1.5~2 秒：${firstMin}~${firstMax}`);
	assert.ok(secondMin >= 10_000 && secondMax <= 12_000, `第二圈该在 10~12 秒：${secondMin}~${secondMax}`);
	assert.ok(slowMin >= 120_000 && slowMax <= 150_000, `之后该在 2~2.5 分钟：${slowMin}~${slowMax}`);
	assert.ok(firstMax < secondMin && secondMax < slowMin, '档位重叠了，越等越久这条性质就没了');
	assert.ok(new Set(Array.from({ length: 24 }, () => retryDelay(99))).size > 1, '慢档没有抖动');
	cases += 1;
}

console.log(`danmaku.check: ${cases} 组用例通过`);
