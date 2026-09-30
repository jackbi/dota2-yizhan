import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OB_MEMBERS } from '../src/data/ob.ts';
import { rankInfo } from '../src/lib/dotaLabels.ts';

/**
 * OB 页「天梯 + 擅长英雄」这一块的自检。
 *
 * 这一块最容易犯的**不是崩溃，是悄悄地贴错人**：账号 id 猜错、把"没打过"和"没取到名字"
 * 写成同一句话、把段位数字当成 MMR 摆出去。三种错在页面上都很好看，只有懂行的人才会发现，
 * 所以这里把口径钉住（与房间那句 `ownerMatch` 是同一个态度）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/obPage.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const card = readFileSync(new URL('../src/components/ObMemberCard.astro', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../src/lib/obPlayers.ts', import.meta.url), 'utf8');

// ---------------------------------------------------------------- 账号 id

{
	const withAccount = OB_MEMBERS.filter((member) => typeof member.accountId === 'number');
	assert.equal(withAccount.length, 10, `名单里应当有 10 位带账号（实际 ${withAccount.length}）`);
	for (const member of withAccount) {
		assert.ok(member.accountId! > 0, `${member.name} 的账号 id 要是正整数`);
	}
	// id 不能重复：同一个人挂两个页面还好说，两个人挂同一个账号就是把数据贴错人。
	const ids = withAccount.map((member) => member.accountId!);
	assert.equal(new Set(ids).size, ids.length, '账号 id 不能重复');
	// 来源必须写在数据文件里，否则下一个人没法核对这批 id 是从哪来的。
	const data = readFileSync(new URL('../src/data/ob.ts', import.meta.url), 'utf8');
	assert.match(data, /accountId: 90045009/, 'YYF 的账号 id 要写进名单');
	assert.match(data, /liquipediaApi/, '数据文件里要写明 id 的来源（Liquipedia 选手页的 |playerid=）');
	ok('10 位带账号、id 不重复，来源写在数据文件里');
}

// ---------------------------------------------------------------- 段位口径

{
	// 段位用站内那一套翻译（十位=奖章、个位=星），不要在这里另造一套。
	assert.equal(rankInfo(80).label, '冠绝', '80 是冠绝');
	assert.equal(rankInfo(74).label, '超凡 4 星', '74 是超凡 4 星');
	assert.equal(rankInfo(0).label, '未定级', '0/空是未定级');
	assert.match(lib, /rankInfo\(/, '要复用 dotaLabels 的段位翻译，不另写映射');
	/*
	 * **不写 MMR 数字。** Valve 不公开这个值，写出来只能靠估；
	 * 摆在「石佛」头上的一个编造分数，比空着更糟。
	 * 注释里可以（也应该）写清这件事，所以只查非注释行。
	 */
	const codeOf = (source: string): string =>
		source
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
			})
			.join('\n');
	assert.ok(!/mmr/i.test(codeOf(lib)), '数据层不该出现 mmr：公开接口拿不到这个数');
	assert.ok(!/mmr/i.test(codeOf(card)), '卡片上也不该出现 mmr');
	ok('段位复用站内翻译；不编 MMR 数字');
}

// ---------------------------------------------------------------- 三种"没有英雄"要分得开

{
	// 有池子但名字表没通：与"没打过"是两件事，必须写成两句不同的话。
	assert.match(card, /这次构建没取到英雄名/, '「没取到英雄名」要有单独的说法');
	assert.match(card, /没有可用的公开对局/, '「没有公开对局」要有单独的说法');
	assert.match(card, /stat\.pool \?/, '两种情况的判断要挂在 pool 有没有上');
	// 账号昵称必须露出来：它常常和页面上的名字差很远，读者得能自己核对。
	assert.match(card, /数据来自账号/, '卡片上要写出账号昵称，方便读者核对是不是本人');
	// 拿不到真实数据时要退回手写那份，并标明它没有统计来源。
	assert.match(card, /代表英雄（社区认知，非统计）/, '兜底那份手写英雄要标明不是统计');
	ok('「没取到名字」「没打过」「手写兜底」三种情况分开说，账号昵称露出来');
}

// ---------------------------------------------------------------- 取数策略

{
	// 构建期预渲染的页面不能只靠内存缓存（`ssrCache` 是本进程的）：那样每次重建都要重取 10 次。
	assert.match(lib, /readCacheJson/, '要落磁盘缓存，否则每次重建都要为这 10 个人重发请求');
	assert.match(lib, /ob-players\.json/, '缓存文件路径要写死，便于运维清理');
	assert.match(lib, /TOURNAMENTS_OFFLINE/, '离线构建要照用旧缓存，而不是整块消失');
	// 一个人失败不该带走整页：OB 页的主体是这些人本身。
	assert.match(lib, /catch \{/, '单人失败要吞掉，不影响其他人');
	assert.ok(!/Promise\.all\([\s\S]{0,80}?\.then\(/.test(lib), '取数不要写成会整体失败的链');
	ok('磁盘缓存 + 离线照用 + 单人失败不影响别人');
}

console.log(`obPage 全部断言通过（${cases} 组）`);
