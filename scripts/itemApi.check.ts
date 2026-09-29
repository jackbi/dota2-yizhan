import assert from 'node:assert/strict';

/**
 * `src/lib/itemApi.ts` 装备详情懒加载的自检：**失败的 promise 不能留在缓存里**。
 *
 * 悬浮框的详情是 JSONP 拉一次就复用的。留一个失败的 promise 在缓存里，这次会话剩下的时间里
 * 每个悬浮框都会退回卡片上的 `data-*` 兜底——描述与配方永远不出现，页面上没有任何提示，
 * 也不会再重试。`heroApi` 那边已经为同一个坑补过守卫（网络抖动会让那个英雄在那个进程里
 * 永久坏掉），这里是同一个形状。
 *
 * 做法：塞一个最小的 DOM 桩（`createElement` / `head.appendChild` / `script.remove`），
 * 让"脚本加载失败"与"回调给了坏数据"两条路都能在 Node 里跑一遍。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/itemApi.check.ts`）。
 */

let created = 0;
let mode: 'error' | 'ok' = 'error';
let payload: unknown = null;

const globals = globalThis as unknown as { window: Record<string, unknown>; document: unknown };
globals.window = {};
globals.document = {
	createElement: () => {
		created += 1;
		return { src: '', async: false, onerror: undefined as ((error: unknown) => void) | undefined, remove() {} };
	},
	head: {
		appendChild: (script: { onerror?: (error: unknown) => void }) => {
			// 真实场景：脚本被网络/拦截器挡住，或者回调带着坏数据回来。
			queueMicrotask(() => {
				if (mode === 'error') script.onerror?.(new Error('脚本加载失败'));
				else (globals.window as { HeropediaDFReceive?: (data: unknown) => void }).HeropediaDFReceive?.(payload);
			});
		},
	},
};

const { loadItemDetails } = await import('../src/lib/itemApi.ts');

// 1. 失败要抛给调用方，并且**不能**留在缓存里：下一次调用必须重新发一次 JSONP
await assert.rejects(() => loadItemDetails(), '加载失败要抛给调用方');
assert.equal(created, 1, '第一次应当真的插了一次 script');
await assert.rejects(() => loadItemDetails(), '第二次也该失败（还是失败模式）');
assert.equal(created, 2, '失败的那次不能留在缓存里：第二次要重新插 script 重试');

// 2. 形状不对（回调给了没有 itemdata 的对象）同样要清缓存，而且错误说明要能查
mode = 'ok';
payload = { nope: true };
await assert.rejects(
	() => loadItemDetails(),
	(error: unknown) => {
		assert.match(String(error), /形状不对/, '形状不对要说出来，别只说"加载失败"');
		return true;
	},
);
assert.equal(created, 3, '坏数据也不能留在缓存里');

// 3. 成功之后要留住：同一份数据不再插第二个 script
payload = { itemdata: { blink: { dname: '闪烁匕首', en: 'Blink Dagger', cost: 2250, requirements: ['recipe_blink'] } } };
const details = await loadItemDetails();
assert.equal(created, 4, '第三次失败之后又重试了一次');
assert.equal(details.blink?.nameLoc, '闪烁匕首');
assert.deepEqual(details.blink?.requirements, ['recipe_blink']);
assert.equal(await loadItemDetails(), details, '成功的结果要缓存复用（悬浮框会反复读）');
assert.equal(created, 4, '命中缓存时不该再插 script');

console.log('itemApi.check 通过');
