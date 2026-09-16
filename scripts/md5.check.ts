import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5Hex } from '../src/lib/md5.ts';

/**
 * `src/lib/md5.ts` 的自检：拿 `node:crypto` 当参照物。
 *
 * 这份 MD5 只服务于直播直链的签名（`node:crypto` 在 Cloudflare Workers 上要走
 * `nodejs_compat`，而仓库的规矩是 SSR 侧不碰 node 模块），所以正确性完全靠这里兜住。
 * 用例覆盖分块边界——补位长度算错时，短的正好、长的全错，只测 `'abc'` 是发现不了的。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/md5.check.ts`）。
 */
const cases = [
	'',
	'a',
	'abc',
	'message digest',
	'The quick brown fox jumps over the lazy dog',
	// 补位边界：55/56 是「刚好还放得下长度」和「必须多开一块」的分界，63/64/65 同理。
	'a'.repeat(55),
	'a'.repeat(56),
	'a'.repeat(57),
	'a'.repeat(63),
	'a'.repeat(64),
	'a'.repeat(65),
	'a'.repeat(119),
	'a'.repeat(120),
	// 多字节：长度按字节算而不是字符，这一步最容易写错。
	'斗鱼 9999 虎牙 678555',
	'🀄️'.repeat(20),
	// 签名里真实出现的长输入：md5(md5(...) + key + rid + ts) 这种链式调用。
	'2f9a1c1f3b7c1a4e5d6f8a9b0c1d2e3f' + 'douyu-key-here' + '99991700000000',
];

for (const input of cases) {
	const expected = createHash('md5').update(input, 'utf8').digest('hex');
	const actual = md5Hex(input);
	assert.equal(actual, expected, `md5 不一致：输入 ${JSON.stringify(input).slice(0, 40)}`);
}

// 链式调用是签名算法的形状，单独走一遍确认多次调用之间没有残留状态。
let chain = 'rand_str';
for (let i = 0; i < 12; i++) chain = md5Hex(chain + 'key');
let expectedChain = 'rand_str';
for (let i = 0; i < 12; i++) expectedChain = createHash('md5').update(expectedChain + 'key', 'utf8').digest('hex');
assert.equal(chain, expectedChain, '链式 md5 不一致');

console.log(`md5.check: ${cases.length + 1} 组用例通过`);
