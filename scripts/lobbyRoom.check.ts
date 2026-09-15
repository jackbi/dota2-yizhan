import assert from 'node:assert/strict';
import { joinRoom } from 'trystero';
import type { Room } from 'trystero';

/**
 * Trystero 「同一 roomId 的进出去重」这个坑的自检——纯本地，不联网、不需要 WebRTC。
 *
 * 起因是一个真实 bug：大厅房主看不到自己的房间。根因是 `joinRoom` 对同一组
 * `(appId, roomId)` **幂等**，而 `leave()` 是异步的：
 *
 * - `room.mjs` 的 `leave` 第一步是 `await leaveAction.send('')`（要把告别消息发出去）；
 * - 删掉 `occupiedRooms[appId][roomId]` 发生在它之后（`strategy.mjs`）；
 * - 期间任何 `joinRoom` 都会命中缓存，把**正在退出的旧实例**原样还回来——连 `passive`
 *   配置都是旧的。而两个 passive 之间永远不建连（`signal-handler.mjs`），于是房主以为
 *   自己在广播，实际握着个已退出的被动房间。
 *
 * 这里把两种写法摆在一起对照：不 await 的拿到旧实例且角色是错的，await 的才是新房间。
 * `relayConfig: { urls: [] }` 让两边都不去连中继——这个行为与网络无关，必须能在离线跑。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/lobbyRoom.check.ts`）。
 */

const APP_ID = 'lobby-room-check';

/**
 * 最小 RTCPeerConnection 桩。
 *
 * Trystero 在**加入非 passive 房间时**就会预热 offer 池（`new RTCPeerConnection(...)`），
 * 所以即便这个测试一个 peer 都不连，也得给它一个构造器。真正用到的只有「造 offer / 设本地描述」，
 * 数据通道那几个字段是 `sendData` 会读的。要跑真连接就得换 werift 之类的真实现。
 */
class StubPeerConnection {
	private readonly channel = {
		readyState: 'open',
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		addEventListener: () => {},
		removeEventListener: () => {},
		send: () => {},
		close: () => {},
	};
	iceConnectionState = 'new';
	connectionState = 'new';
	localDescription: { type: string; sdp: string } | null = null;
	createDataChannel = () => this.channel;
	createOffer = async () => ({ type: 'offer', sdp: 'v=0\r\n' });
	setLocalDescription = async (d: { type: string; sdp: string }) => {
		this.localDescription = d;
	};
	setRemoteDescription = async () => {};
	addIceCandidate = async () => {};
	addEventListener = () => {};
	removeEventListener = () => {};
	close = () => {};
}

/** 不给中继：joinRoom 照样会建房间并登记，正好只测「登记/去登记」的时序。 */
const config = (passive: boolean) => ({
	appId: APP_ID,
	relayConfig: { urls: [] as string[] },
	passive,
	rtcPolyfill: StubPeerConnection as unknown as typeof RTCPeerConnection,
});

// ---------------------------------------------------------------- 错误写法：不 await 就重进

const stale = joinRoom(config(true), 'room-bug');
assert.equal(stale.isPassive(), true, '第一次应以 passive 身份加入');

// 这正是原来 partyRoom.ts 里的写法：void leave() 紧接着 joinRoom() 同一个 roomId。
void stale.leave();
const afterBadRejoin = joinRoom(config(false), 'room-bug');

assert.equal(afterBadRejoin, stale, '不 await 时会命中缓存，拿回同一个实例');
assert.equal(
	afterBadRejoin.isPassive(),
	true,
	'拿回的是旧实例，所以角色仍是 passive——房主于是不在大厅里，这就是那个 bug',
);

// ---------------------------------------------------------------- 正确写法：等 leave 落定

const previous = joinRoom(config(true), 'room-ok');
assert.equal(previous.isPassive(), true, '第一次应以 passive 身份加入');

await previous.leave();
const afterGoodRejoin = joinRoom(config(false), 'room-ok');

assert.notEqual(afterGoodRejoin, previous, '等 leave 落定后重新加入应拿到新实例');
assert.equal(afterGoodRejoin.isPassive(), false, '新实例的角色才是这次要的活跃身份');

// 收尾：别把房间留着（进程退出前 leave 掉）。
await afterGoodRejoin.leave();

console.log('大厅房间进出去重的断言通过（passive 实例必须在 leave() 落定后才能重进）');
