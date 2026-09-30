import assert from 'node:assert/strict';
import { buildTeamSignature, signatureHeroOf, signatureHighlights, signatureLine, signatureScopeLabel } from '../src/lib/teamSignature.ts';

/**
 * 「战队 + 人员擅长英雄」折表这一层的自检。
 *
 * 这段代码本身很短，容易犯的错却有三种，而且都不会崩：
 *
 * 1. **把同一个人算两遍**：名单里出现同名选手、或同一英雄跨人重复时不去重，
 *    会在提示词里写成"这支队拿了 12 场"，其实是两个人各 6 场；
 * 2. **窗口混着写**：一个人的招牌是本版本、另一个是回退的 90 天，
 *    合成之后还标版本号，等于把两套口径说成同一个；
 * 3. **人称翻错**：这份签名属于哪一边由调用方给，写反了页面上的"我方/对面"就是反的。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/teamSignature.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// ---------------------------------------------------------------- 折表

{
	const signature = buildTeamSignature('Team Spirit', [
		{
			nick: 'Yatoro',
			scope: '7.41f 版本',
			heroes: [
				{ heroId: 41, games: 6, wins: 4 },
				{ heroId: 9, games: 2, wins: 1 },
			],
		},
		{
			nick: 'Larl',
			scope: '7.41f 版本',
			heroes: [
				{ heroId: 41, games: 3, wins: 2 },
				// 只打过一场：合计不到门槛，不该进名单。
				{ heroId: 99, games: 1, wins: 1 },
			],
		},
	]);
	assert.ok(signature, '有招牌数据时要建出签名');
	assert.equal(signature!.heroes.length, 2, '门槛以下的英雄不进名单');
	const faceless = signatureHeroOf(signature, 41);
	assert.ok(faceless, '同一个英雄两个人都在打时要合并成一条');
	assert.equal(faceless!.games, 9, '场次要按人合计');
	assert.equal(faceless!.wins, 6, '胜场要按人合计');
	assert.deepEqual(faceless!.players, ['Yatoro', 'Larl'], '选手按各自场次降序留下，界面与提示词都要能看到是谁');
	assert.equal(signature!.scope, '7.41f 版本', '全队同口径时才写版本号');
	ok('同名英雄按人合计，一个人只算一次，选手按场次排序');
}

{
	// 两个人口径不同：不能挑一个写上去，那不是这批数字的窗口。
	const mixed = buildTeamSignature('Mixed', [
		{ nick: 'A', scope: '7.41f 版本', heroes: [{ heroId: 5, games: 4, wins: 2 }] },
		{ nick: 'B', scope: '近 90 天', heroes: [{ heroId: 6, games: 4, wins: 3 }] },
	]);
	assert.equal(mixed?.scope, '', '口径不一致时整队不标版本号');
	assert.equal(signatureScopeLabel(mixed?.scope ?? ''), '', '没口径就不写窗口');
	assert.equal(signatureScopeLabel('window'), '近 90 天', '回退窗口要有固定说法');
	ok('口径不一致时整队不写版本号');
}

{
	assert.equal(buildTeamSignature('Nobody', []), null, '一个人都没有时返回 null，调用方按"没有数据"处理');
	assert.equal(
		buildTeamSignature('OneGame', [{ nick: 'A', scope: '7.41f 版本', heroes: [{ heroId: 5, games: 1, wins: 1 }] }]),
		null,
		'只打过一场的进不了名单：那不是"擅长"',
	);
	ok('空名单与单场数据都按"没有招牌"处理');
}

// ---------------------------------------------------------------- 顺序稳定

{
	// 场次相同时按胜场、再按英雄 id：每轮构建出来必须一模一样，否则页面上的顺序会自己变。
	const a = buildTeamSignature('T', [
		{ nick: 'A', scope: 'x', heroes: [
			{ heroId: 7, games: 3, wins: 1 },
			{ heroId: 3, games: 3, wins: 2 },
			{ heroId: 5, games: 3, wins: 1 },
		] },
	]);
	const b = buildTeamSignature('T', [
		{ nick: 'A', scope: 'x', heroes: [
			{ heroId: 5, games: 3, wins: 1 },
			{ heroId: 7, games: 3, wins: 1 },
			{ heroId: 3, games: 3, wins: 2 },
		] },
	]);
	assert.deepEqual(a?.heroes, b?.heroes, '输入顺序变了，输出的顺序不能跟着变');
	assert.deepEqual(a?.heroes.map((hero) => hero.heroId), [3, 5, 7], '场次平手时先看胜场，再看英雄 id');
	ok('排序与输入顺序无关，结果可复现');
}

// ---------------------------------------------------------------- 依据文案

{
	const signature = buildTeamSignature('Team Spirit', [
		{ nick: 'Yatoro', scope: '7.41f 版本', heroes: [{ heroId: 41, games: 6, wins: 4 }] },
	]);
	const line = signatureLine(signature, 41, 'theirs');
	assert.match(line, /对面（Team Spirit）/, '默认是"对面"');
	assert.match(line, /7\.41f 版本/, '要把统计口径写出来——版本不同招牌就不同');
	assert.match(line, /Yatoro 的招牌/, '要写清是谁在打');
	assert.match(line, /6 场 4 胜/, '数字要能逐条核对');
	assert.match(signatureLine(signature, 41, 'ours'), /我方（Team Spirit）/, '人称要能翻过来');
	assert.equal(signatureLine(signature, 4242, 'theirs'), '', '不在名单里的英雄不写这一条');
	assert.equal(signatureLine(null, 41, 'theirs'), '', '没有签名时不写');
	for (const text of [line, signatureLine(signature, 41, 'ours')]) {
		assert.ok(!/undefined|NaN/.test(text), `文案里出现了 undefined/NaN：${text}`);
	}
	assert.equal(signatureHighlights(signature, 4).length, 1, '只有一条时就返回一条');
	assert.equal(signatureHighlights(null).length, 0, '没有签名时返回空数组');
	ok('依据文案带口径、带选手、人称可翻，不出现 undefined/NaN');
}

console.log(`teamSignature 全部断言通过（${cases} 组）`);
