import assert from 'node:assert/strict';
import { parseHuyaStream } from '../src/lib/huyaStream.ts';

/**
 * `src/lib/huyaStream.ts` 的自检（纯函数，不联网）。
 *
 * 这里解析错就等于把一条播不了的地址喂给播放器，所以把形状钉死：线路按接口偏好排序、
 * `http://` 一律抬成 `https://`、非 200 与缺字段当解析失败、轮播房间「没有线路」也不能算成功。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/liveStream.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 一条线路的原始形状：接口给的就是 http + 带 wsSecret/wsTime 的查询串。 */
const line = (cdn: string, priority: number, name = 'a') => ({
	cdnType: cdn,
	webPriorityRate: priority,
	url: `http://${cdn}.flv.huya.com/src/${name}.flv?wsSecret=x&wsTime=1`,
});

const payload = (data: unknown, status = 200) => ({ status, data });

// 正常响应：三条线路按 webPriorityRate 从大到小排，协议全部抬成 https
{
	const info = parseHuyaStream(
		payload({
			liveStatus: 'ON',
			profileInfo: { nick: '某主播' },
			liveData: { roomName: '某标题' },
			stream: { flv: { multiLine: [line('AL', 8), line('TX', 52), line('HS', 40)] } },
		}),
	);
	assert.ok(info, '形状正常时不该返回 null');
	assert.equal(info.live, true);
	assert.equal(info.owner, '某主播');
	assert.equal(info.title, '某标题');
	assert.deepEqual(
		info.lines.map((l) => l.cdn),
		['TX', 'HS', 'AL'],
		'线路要按接口给的偏好排（虎牙网页播放器取的就是最大的那条）',
	);
	assert.ok(
		info.lines.every((l) => l.url.startsWith('https://')),
		'接口给的是 http://，在 https 页面上会被按混合内容拦掉，必须抬成 https',
	);
	ok('正常响应：线路按偏好排序，http 抬成 https');
}

// 已经是 https 的地址不要改坏
{
	const info = parseHuyaStream(
		payload({
			liveStatus: 'ON',
			stream: { flv: { multiLine: [{ cdnType: 'AL', webPriorityRate: 1, url: 'https://a.flv.huya.com/x.flv?wsTime=1' }] } },
		}),
	);
	assert.equal(info?.lines[0]?.url, 'https://a.flv.huya.com/x.flv?wsTime=1');
	ok('https 地址原样保留');
}

// 空地址与缺 cdnType 的条目要跳过，不能让 undefined 混进候选列表
{
	const info = parseHuyaStream(
		payload({
			liveStatus: 'ON',
			stream: { flv: { multiLine: [line('AL', 5), { cdnType: 'TX', webPriorityRate: 9 }, { url: '   ' }] } },
		}),
	);
	assert.equal(info?.lines.length, 1, '没有 url 的线路不该进候选');
	assert.equal(info?.lines[0]?.cdn, 'AL');
	ok('空地址与缺 url 的条目被跳过');
}

// 轮播 / 未开播：真实响应里 multiLine 就是空的，结果应当是「没有线路」而不是解析失败
{
	const info = parseHuyaStream(
		payload({
			liveStatus: 'REPLAY',
			profileInfo: { nick: '翔龙丶Longdd' },
			liveData: { roomName: '' },
			stream: { flv: { multiLine: [] } },
		}),
	);
	assert.ok(info, '形状正常（只是没开播）时不返回 null');
	assert.equal(info.live, false);
	assert.deepEqual(info.lines, []);
	ok('轮播房间：live=false 且没有候选线路');
}

// 缺 stream / 缺 flv 都不能抛
{
	assert.deepEqual(parseHuyaStream(payload({ liveStatus: 'ON' }))?.lines, []);
	assert.deepEqual(parseHuyaStream(payload({ liveStatus: 'ON', stream: {} }))?.lines, []);
	ok('缺 stream / 缺 flv 时不抛，线路为空');
}

// 不是 200 或没有 data：当解析失败
{
	assert.equal(parseHuyaStream(payload({ liveStatus: 'ON' }, 403)), null);
	assert.equal(parseHuyaStream({ status: 200 }), null);
	assert.equal(parseHuyaStream(null), null);
	assert.equal(parseHuyaStream('nonsense'), null);
	ok('非 200 / 缺 data / 完全不是对象 → null');
}

console.log(`liveStream 全部断言通过（${cases} 组）`);
