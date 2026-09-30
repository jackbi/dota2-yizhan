import assert from 'node:assert/strict';
import {
	FAMILIARITY_WEIGHT,
	buildRosterProfile,
	buildTeamSignature,
	familiarityBonus,
	rosterFamilyLine,
	rosterHeroOf,
	rosterOutOfPool,
	rosterPoolOf,
	signatureHeroOf,
	signatureHighlights,
	signatureLine,
	signatureScopeLabel,
} from '../src/lib/teamSignature.ts';

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

// ---------------------------------------------------------------- 按号位的池子

/**
 * 这一层是"这一手像不像他们"的关键：**号位必须对得上**。
 *
 * 合成一份的时候，把三号位的招牌算到二号位头上是看不出来的——用户的投诉正是这个形状
 * （"我怎么没见过 XM 玩过天穹守望者"）。所以下面每一条都在钉"谁在哪个号位、他拿过什么"。
 */
const TEAM = [
	{ nick: 'Ame', position: 1, scope: '7.41f 版本', heroes: [{ heroId: 41, games: 7, wins: 3 }] },
	{ nick: 'Xm', position: 2, scope: '7.41f 版本', heroes: [{ heroId: 106, games: 6, wins: 4 }, { heroId: 9, games: 3, wins: 1 }] },
	{ nick: 'zeal', position: 3, scope: '7.41f 版本', heroes: [{ heroId: 106, games: 4, wins: 1 }] },
] as const;

{
	const profile = buildRosterProfile('Xtreme Gaming', TEAM);
	assert.ok(profile, '有号位与招牌时要建出画像');
	assert.deepEqual(profile!.positions.map((pool) => pool.position), [1, 2, 3], '按号位升序，缺的号位不占位');
	assert.deepEqual(rosterPoolOf(profile, 2)?.players, ['Xm'], '二号位是谁要写出来');
	assert.equal(rosterPoolOf(profile, 4), null, '名单里没有四号位时返回 null，不摆空池子');
	// 同一个英雄两个号位都有人打：合并在各自号位里，不串号。
	assert.equal(rosterHeroOf(profile, 2, 106)?.games, 6, '二号位看的是 Xm 的场次');
	assert.equal(rosterHeroOf(profile, 3, 106)?.games, 4, '三号位看的是 zeal 的场次');
	assert.equal(rosterHeroOf(profile, 2, 41), null, '一号位的英雄不算在二号位头上');
	// 不分号位的那份还在：界面上的"这支队有人打它"仍然用得上。
	assert.equal(signatureHeroOf(profile, 41)?.games, 7, '不分号位的合计保留着');
	ok('画像按号位分组，同一英雄各号位各算，号位对不上就是查不到');
}

{
	const profile = buildRosterProfile('Xtreme Gaming', TEAM);
	// 号位对得上：这一句是"这个位置上的这个人在打它"。
	assert.match(rosterFamilyLine(profile, 2, 106, 'theirs'), /对面（Xtreme Gaming） 2 号位是 Xm/, '要写清是哪个号位、谁');
	assert.match(rosterFamilyLine(profile, 2, 106, 'theirs'), /拿过它 6 场 4 胜/, '场次胜负要能核对');
	assert.match(rosterFamilyLine(profile, 2, 106, 'theirs'), /7\.41f 版本里/, '统计口径要跟着出来');
	assert.match(rosterFamilyLine(profile, 2, 106, 'ours'), /我方（Xtreme Gaming）/, '人称要能翻');
	assert.equal(rosterFamilyLine(profile, 1, 106, 'theirs'), '', '这个号位的人没打过它时不给这句');

	// 号位对不上：必须写成"摇摆"，这正是上一版缺的那句。
	assert.match(rosterOutOfPool(profile, 1, 106), /2 号位 Xm 在打它（6 场）/, '别的号位在打时要说是谁在打');
	assert.match(rosterOutOfPool(profile, 1, 106), /摇摆/, '要点明这是摇摆而不是熟手');
	assert.equal(rosterOutOfPool(profile, 2, 106), '', '就在这个号位的池子里时不写风险');
	assert.match(rosterOutOfPool(profile, 2, 999), /没有人常拿它/, '谁都没打过时要说清是"数据里没有"');
	// 没号位的名单（教练组那种）：不编号位，只留不分号位那份。
	const noPosition = buildRosterProfile('T', [{ nick: 'Coach', scope: '7.41f 版本', heroes: [{ heroId: 5, games: 3, wins: 1 }] }]);
	assert.deepEqual(noPosition?.positions, [], '没写号位的人不进制表，不给他编一个位置');
	assert.equal(signatureHeroOf(noPosition, 5)?.games, 3, '但仍在不分号位的合计里');
	ok('依据文案分得清"这个号位在打它"与"别的号位在打它"，缺号位时不编位置');
}

{
	const profile = buildRosterProfile('Xtreme Gaming', TEAM);
	// 加成随场次线性上升、满 8 场封顶；不在池子里一律 0（不给负分：不认识不等于不会玩）。
	assert.equal(familiarityBonus(profile, 2, 999), 0, '不在池子里就是 0');
	assert.equal(familiarityBonus(profile, 1, 106), 0, '别的号位在打也不算这个位置的熟手');
	assert.ok(Math.abs(familiarityBonus(profile, 2, 9)! - (3 / 8) * FAMILIARITY_WEIGHT) < 1e-9, '3 场按 3/8 给分');
	assert.ok(Math.abs(familiarityBonus(profile, 2, 106)! - (6 / 8) * FAMILIARITY_WEIGHT) < 1e-9, '6 场按 6/8 给分');
	assert.ok(Math.abs(familiarityBonus(profile, 1, 41)! - (7 / 8) * FAMILIARITY_WEIGHT) < 1e-9, '7 场还没到封顶线');
	// 打过 11 场的那位用来验封顶：再多也不过是"很熟"，不该被场次无限拉大。
	const deep = buildRosterProfile('Cap', [{ nick: 'Deep', position: 4, scope: '7.41f 版本', heroes: [{ heroId: 5, games: 11, wins: 6 }] }]);
	assert.equal(familiarityBonus(deep, 4, 5), FAMILIARITY_WEIGHT, '满 8 场及以上封顶');
	assert.ok(familiarityBonus(profile, 2, 106)! < 0.05, '加成不能大到盖过号位胜率本身');
	ok('熟手加成线性封顶、只认对得上的号位，不吃负分');
}

console.log(`teamSignature 全部断言通过（${cases} 组）`);
