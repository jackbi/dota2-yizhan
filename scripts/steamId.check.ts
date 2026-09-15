import assert from 'node:assert/strict';
import { accountIdToSteamId64, parseSteamIdInput } from '../src/lib/steamAuth.ts';

/**
 * `parseSteamIdInput` 的自检。
 *
 * 这段逻辑接收的是**用户手抄/手贴的字符串**，形式最杂、也最容易被贴着贴着就多一个空格，
 * 而它解析出来的 accountId 会直接拿去查 STRATZ——错一位就是查到别人头上。
 * 所以几种写法必须互相等价、几种明显的垃圾必须被挡住。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/steamId.check.ts`）。
 */

const ok = (input: string, accountId: number) => {
	const parsed = parseSteamIdInput(input);
	assert.equal(parsed.ok, true, `「${input}」应该能解析`);
	if (!parsed.ok) return;
	assert.equal(parsed.accountId, accountId, `「${input}」的 accountId`);
	// 两个 id 必须能互相换算，否则写回时会对不上。
	assert.equal(parsed.steamId, accountIdToSteamId64(accountId), `「${input}」的 SteamID64`);
};

const bad = (input: string) => {
	assert.equal(parseSteamIdInput(input).ok, false, `「${input}」应该被拒绝`);
};

// 同一个人换五种写法，结果必须一致（76561198000000000 ↔ 39734272）。
ok('76561198000000000', 39734272);
ok('  76561198000000000  ', 39734272);
ok('https://steamcommunity.com/profiles/76561198000000000/', 39734272);
ok('steamcommunity.com/profiles/76561198000000000', 39734272);
ok('39734272', 39734272);
ok('STEAM_1:0:19867136', 39734272);
ok('STEAM_0:1:19867135', 39734271);
ok('[U:1:39734272]', 39734272);

// 边界：32 位无符号的最大值可用，再大就不是账号 id 了。
ok('4294967295', 4294967295);

// 自定义短名要的是 Steam Web API Key，本站没有，必须给出可操作的提示而不是静默失败。
bad('steamcommunity.com/id/someone');
const shortName = parseSteamIdInput('https://steamcommunity.com/id/gaben');
assert.equal(shortName.ok, false);
if (!shortName.ok) assert.match(shortName.error, /profiles/, '拒绝自定义短名时要告诉用户去哪儿抄 ID');

bad('');
bad('   ');
bad('abc');
bad('0');
bad('99999999999999999999');
bad('4294967296');
// 17 位但不是 SteamID64 的形状：当账号 id 也超出了 32 位。
bad('12345678901234567');
// 只有 SteamID64 的基数（accountId 会算成 0）。
bad('76561197960265728');
// 错误的旧格式。
bad('STEAM_2:3:123');
bad('STEAM_1:1:');

console.log('steamId 解析断言通过');
