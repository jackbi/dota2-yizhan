import assert from 'node:assert/strict';
import { douyuAuth, encRounds } from '../src/lib/liveStream.ts';
import { parseHuyaStream } from '../src/lib/huyaStream.ts';

/**
 * 直播解析侧的自检（纯函数，不联网）。
 *
 * `huyaStream.ts` 那半：解析错就等于把一条播不了的地址喂给播放器，所以把形状钉死——线路按
 * 接口偏好排序、`http://` 一律抬成 `https://`、非 200 与缺字段当解析失败、轮播房间「没有线路」
 * 也不能算成功。
 *
 * `liveStream.ts` 那半只钉一件事：斗鱼签名里 MD5 链的轮数。它由上游 `getEncryption` 的
 * `enc_time` 决定，那个数字直接当循环次数用就是让远端决定我们烧多少 CPU——
 * 一条异常响应就能把本地构建卡死、把 Workers 的 CPU 额度打满（看起来却像是"斗鱼挂了"）。
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

// 斗鱼签名轮数：正常值原样用，不可信的一律拒绝（调用方据此报错退出，循环里也夹了一道）
{
	assert.equal(encRounds(0), 0, '0 轮是合法的（不串就是原串）');
	assert.equal(encRounds(1), 1);
	assert.equal(encRounds('3'), 3, '接口给的是 JSON，数字有时是字符串');
	ok('轮数：正常值原样通过');
}

{
	for (const raw of [1e9, 1001, -1, 1.5, 'abc', undefined, null, NaN, Infinity, {}, []]) {
		assert.equal(encRounds(raw), null, `不该把 ${JSON.stringify(raw) ?? String(raw)} 当成轮数`);
	}
	ok('轮数：超范围 / 负数 / 非整数 / 非数字一律拒绝');
}

{
	// 一条异常响应（这里给 10 亿）既不能真的去串十亿次 MD5，也不能悄悄按 0 轮算出一个错签名。
	assert.throws(
		() => douyuAuth('key', 'rand', 1e9, 0, '9999', 1700000000),
		/enc_time/,
		'超出上限的轮数要直接失败（与 resolveDouyu 的处理一致），不能悄悄降级',
	);
	const zero = douyuAuth('key', 'rand', 0, 0, '9999', 1700000000);
	assert.notEqual(
		douyuAuth('key', 'rand', 2, 0, '9999', 1700000000),
		zero,
		'正常轮数要真的参与计算：签名必须随 enc_time 变化',
	);
	ok('签名：轮数不可信时直接失败，正常轮数照常参与');
}

console.log(`liveStream 全部断言通过（${cases} 组）`);
