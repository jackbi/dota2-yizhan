import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeClientMessage, decodeLobbyMessage, decodeServerMessage, encodeMessage } from '../src/lib/partyProtocol.ts';

/**
 * `src/lib/partyProtocol.ts` 的自检（纯函数，不联网）。
 *
 * 这是**信任边界**：房间的 WebSocket 端点是公开的，消息来自别人的浏览器，形状不对的必须被
 * 丢掉而不是猜。所以这里把「该收的收、该拒的拒」钉死——尤其是别让 `join` 里混进一个坏 id，
 * 或者让 `move` 带着别人的 memberId 过关（权限那一步在 Durable Object 里，这里只保证形状）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/partyProtocol.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const id = 'a1b2c3d4e5f60718';

// 进房：字段裁到上限，create 缺省就是「加入已有房间」
{
	const message = decodeClientMessage(
		JSON.stringify({ t: 'join', clientId: id, name: '阿'.repeat(80), avatar: 'https://x/y.png', password: 'pw' }),
	);
	assert.equal(message?.t, 'join');
	assert.equal(message && 'name' in message ? message.name.length : -1, 40, '昵称要裁到 40');
	assert.equal(message && 'create' in message ? message.create : 'missing', undefined);
	ok('join：昵称按上限裁剪，没带 create 就是加入');
}

// 进房：clientId 形状不对（太短、含非法字符、非字符串）一律拒绝
{
	for (const bad of ['short', 'has space 123456', 42, null, undefined]) {
		const raw = JSON.stringify({ t: 'join', clientId: bad, name: 'x', avatar: '', password: '' });
		assert.equal(decodeClientMessage(raw), null, `clientId=${String(bad)} 应该被拒`);
	}
	ok('join：clientId 形状不对就丢掉');
}

// 挪人：teamId 为 null 表示回空闲池；memberId 必须是合法 id
{
	const move = decodeClientMessage(JSON.stringify({ t: 'move', memberId: id, teamId: null }));
	assert.deepEqual(move, { t: 'move', memberId: id, teamId: null });
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'move', memberId: 'bad id', teamId: 't1' })), null);
	ok('move：空 teamId 是「回空闲池」，坏 memberId 被拒');
}

// 房主工具：每种 op 都要解析得出来，缺字段的拒绝
{
	const ops = [
		{ kind: 'add' },
		{ kind: 'autoForm' },
		{ kind: 'randomize' },
		{ kind: 'byRoll' },
		{ kind: 'clearRolls' },
		{ kind: 'remove', teamId: 't1' },
		{ kind: 'rename', teamId: 't1', name: '甲队' },
		{ kind: 'size', size: '6' },
		{ kind: 'autoAssign', on: true },
	];
	for (const op of ops) {
		const message = decodeClientMessage(JSON.stringify({ t: 'team', op }));
		assert.equal(message?.t, 'team', `${op.kind} 应该解析成功`);
	}
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'team', op: { kind: 'rename', teamId: 't1' } })), null, '改名缺 name 要拒');
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'team', op: { kind: 'nonsense' } })), null);
	ok('team：房主工具逐个能解析，缺字段/未知 op 被拒');
}

// 页面上的房主工具按钮名必须就是协议里的 kind。
// `data-host-tool` 的值被直接当成 op 发出去（见 partyRoom.ts 的事件委托），所以 HTML 与协议
// 是两个文件里的同一份名单。曾经「新增队伍」写的是 `addTeam`、协议里却叫 `add`：类型检查会报
// "此比较似乎是无意的"，而**浏览器里是静默失灵**——点下去只换来一个 bad-message，页面上什么都不说。
{
	const page = readFileSync(new URL('../src/pages/party.astro', import.meta.url), 'utf8');
	const tools = [...page.matchAll(/data-host-tool="([^"]+)"/g)].map((match) => match[1]);
	assert.ok(tools.length >= 5, `party.astro 里只找到 ${tools.length} 个 data-host-tool，选择器多半写坏了`);
	for (const tool of tools) {
		assert.ok(decodeClientMessage(JSON.stringify({ t: 'team', op: { kind: tool } })), `data-host-tool="${tool}" 不是协议认得的 kind`);
	}
	ok(`party.astro：${tools.length} 个房主工具按钮名与协议一致`);
}

// 聊天：空串与非字符串都不该进房间
{
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'chat', text: '' })), null);
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'chat', text: 42 })), null);
const chat = decodeClientMessage(JSON.stringify({ t: 'chat', text: '中'.repeat(500) }));
assert.equal(chat && 'text' in chat ? chat.text.length : -1, 400, '聊天内容裁到 400');
ok('chat：空/非字符串被拒，超长裁剪');

// 裁剪要按**码点**：emoji 是代理对，直接 slice 会在边界劈出半个字符，聊天里就是乱码方块。
{
	const long = decodeClientMessage(JSON.stringify({ t: 'chat', text: '😀'.repeat(500) }));
	const text = long && 'text' in long ? long.text : '';
	assert.equal([...text].length, 400, 'emoji 也要按码点裁到 400');
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(text), '裁剪后不该留下落单的代理项');
	ok('chat：emoji 超长按码点裁剪，不劈坏代理对');
}
}

// 杂项：不是 JSON、不是对象、未知类型全部返回 null（调用方按「丢弃」处理）
{
	assert.equal(decodeClientMessage('not json'), null);
	assert.equal(decodeClientMessage('[]'), null);
	assert.equal(decodeClientMessage(JSON.stringify({ t: 'drop-table' })), null);
	assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'ping' })), { t: 'ping' });
	ok('未知消息一律丢掉，ping 保留');
}

// 服务端消息：joined/state 要有 state，error 透传 code
{
	const state = { code: 'ABCDE', hostId: id, members: [] };
	const joined = decodeServerMessage(encodeMessage({ t: 'joined', selfId: id, state: state as never, chat: [] }));
	assert.equal(joined?.t, 'joined');
	assert.equal(joined && 'selfId' in joined ? joined.selfId : '', id);
	assert.equal(decodeServerMessage(JSON.stringify({ t: 'joined', selfId: id })), null, '缺 state 要拒');
	assert.equal(decodeServerMessage(JSON.stringify({ t: 'state', state: { code: 'x' } })), null, 'members 不是数组要拒');
	const error = decodeServerMessage(JSON.stringify({ t: 'error', code: 'bad-password' }));
	assert.deepEqual(error, { t: 'error', code: 'bad-password', message: undefined });
	ok('服务端消息：缺字段被拒，错误码透传');
}

// 大厅消息：列表里坏行跳过，好的留下
{
	const lobby = decodeLobbyMessage(
		JSON.stringify({
			t: 'rooms',
			rooms: [
				{ code: 'ABCDE', name: '开黑', count: '3', at: '1700000000000' },
				{ code: '', name: '没有房间码', count: 1 },
				{ code: 'FGHJK', name: '负人数', count: -5 },
				'nonsense',
			],
		}),
	);
	assert.equal(lobby?.rooms.length, 2);
	assert.equal(lobby?.rooms[0]?.count, 3, 'count 字符串要转成数字');
	assert.equal(lobby?.rooms[1]?.count, 0, '负数归零');
	assert.equal(decodeLobbyMessage(JSON.stringify({ t: 'rooms' })), null);
	ok('大厅消息：坏行跳过，数字字段归一');
}

console.log(`partyProtocol 全部断言通过（${cases} 组）`);
