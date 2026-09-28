import assert from 'node:assert/strict';
import { parseDouyuCategory, parseHuyaCategory } from '../src/lib/roomList.ts';

/**
 * `src/lib/roomList.ts` 两个平台解析器的自检（纯函数，不联网）。
 *
 * 这两段代码面对的是平台页面，**解析错了页面照样渲染**，只是少几个房间、或者多一个点不开的
 * 房间。真正会让人白查半天的是这两条：
 *
 * 1. 虎牙的房间号必须取 `profileRoom`。列表里的 `privateHost` 是 `longdd` 这种靓号字符串，
 *    喂给开播接口直接 422——页面上就是一个"永远状态未知"的格子。
 * 2. 斗鱼的房间对象要从 `"cateInfo"` 之后开始扫。分区页前面还有别的 JSON，按整页正则取
 *    `"rid"` 会取到别处的数字，把房间号张冠李戴。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/roomList.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. 斗鱼：只扫 cateInfo 之后的房间块，重复的房间号只留一条，缺昵称的跳过
{
	const html = [
		'<html><head><script>var cfg = {"cateInfo":null,"list":[{"rid":111,"nn":"别处来的"}]};</script></head>',
		'<body><script>window.$ROOM_DATA = {"cateInfo":{"tagId":"2_3"},"list":[',
		'{"authInfo":{"rid":"x"},"rid":9999,"nn":"yyfyyf","rn":"DOTA2 快乐","ol":3612801,"av":"https://apic.douyucdn.cn/avatar_middle.jpg?x=1","roomLabel":["签约","手游"]},',
		'{"authInfo":{"rid":"x"},"rid":9999,"nn":"重复的房间","rn":"不该出现"},',
		'{"authInfo":{"rid":"x"},"rid":507882,"nn":"没有昵称的房间"},',
		'{"authInfo":{"rid":"x"},"rid":82088,"nn":"带\\"引号\\"的名字","ol":0}',
		']};</script></body></html>',
	].join('');

	const rooms = parseDouyuCategory(html);
	assert.deepEqual(
		rooms.map((r) => r.roomId),
		['9999', '507882', '82088'],
		'cateInfo 之前那个 rid=111 不该被当成房间；重复的 rid 只留一条',
	);
	assert.equal(rooms[0]?.name, 'yyfyyf');
	assert.equal(rooms[0]?.title, 'DOTA2 快乐');
	assert.equal(rooms[0]?.hot, 3612801, '斗鱼热度是 ol');
	assert.deepEqual(rooms[0]?.labels, ['签约', '手游']);
	assert.equal(rooms[0]?.avatar, 'https://apic.douyucdn.cn/avatar_middle.jpg?x=1');
	assert.equal(rooms[1]?.name, '没有昵称的房间', '缺 nn 时用 rn 兜底');
	assert.equal(rooms[2]?.name, '带"引号"的名字', '转义过的引号要还原（借 JSON.parse）');
	assert.equal(rooms[2]?.hot, undefined, 'ol 为 0 时不写热度，页面上不会拿 0 当"没人看"');
	assert.equal(rooms.every((r) => r.platform === 'douyu'), true);
	ok('斗鱼分区页：切块取房间、去重、缺字段兜底');
}

// 2. 斗鱼：整页里没有任何房间块时返回空数组，不抛
{
	assert.deepEqual(parseDouyuCategory('<html><body>没有房间</body></html>'), []);
	assert.deepEqual(parseDouyuCategory(''), []);
	ok('斗鱼：没有房间块时返回空数组');
}

// 3. 虎牙：房间号取 profileRoom，绝不取 privateHost（靓号喂开播接口会 422）
{
	const rooms = parseHuyaCategory({
		status: 200,
		data: {
			datas: [
				{ profileRoom: '678555', privateHost: 'longdd', nick: 'LongDD', roomName: 'DOTA2 上分', totalCount: '123456', avatar180: 'https://x/y.jpg' },
				{ profileRoom: 12345, privateHost: 'number-only', nick: '  搜狐  ', roomName: '' },
				{ privateHost: 'no-profile-room', nick: '缺规范号' },
				{ profileRoom: 'x', nick: '' },
			],
		},
	});
	assert.deepEqual(
		rooms.map((r) => r.roomId),
		['678555', '12345'],
		'房间号一律用 profileRoom（privateHost 是靓号字符串）；缺 profileRoom 或昵称的跳过',
	);
	assert.equal(rooms[0]?.name, 'LongDD');
	assert.equal(rooms[0]?.hot, 123456);
	assert.equal(rooms[0]?.avatar, 'https://x/y.jpg');
	assert.equal(rooms[1]?.name, '搜狐', '昵称要 trim');
	assert.equal(rooms[1]?.title, undefined, '空标题不写成空串');
	assert.equal(rooms[1]?.hot, undefined, '没有人数就不写热度');
	assert.equal(rooms.every((r) => r.platform === 'huya'), true);
	ok('虎牙列表：房间号取 profileRoom，字段归一');
}

// 4. 虎牙：热度里混着非数字字符时只取数字；状态不是 200 就是空
{
	const rooms = parseHuyaCategory({
		status: 200,
		data: { datas: [{ profileRoom: '1', nick: 'a', totalCount: '1.2万' }] },
	});
	assert.equal(rooms[0]?.hot, 12, 'totalCount 里的非数字要去掉（虎牙给的是带单位的串）');

	assert.deepEqual(parseHuyaCategory({ status: 403, data: { datas: [{ profileRoom: '1', nick: 'a' }] } }), []);
	assert.deepEqual(parseHuyaCategory({ status: 200 }), []);
	assert.deepEqual(parseHuyaCategory({ status: 200, data: { datas: 'nonsense' } }), []);
	assert.deepEqual(parseHuyaCategory(null), []);
	ok('虎牙：热度归一，非 200 与坏形状返回空');
}

console.log(`roomList 全部断言通过（${cases} 组）`);
