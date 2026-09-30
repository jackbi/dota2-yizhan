import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foeHeadline, foeHeroLine, foeHighlights, foeWinRate, summarizeTeamForm } from '../src/lib/draftFoe.ts';

/**
 * 「对面擅长什么」这一层的自检。这一段链路上有三个会**静默算错**的地方：
 *
 * 1. **阵营判反**：`didRadiantWin` 是"天辉赢了"，不是"我们赢了"。同一份 BP，队伍在天辉和
 *    在夜魇胜负要反过来算，判错不会报错，只会让对面的胜率悄悄变成 50% 减去真值；
 * 2. **把别人的比赛算进来**：窗口里混进不属于这支队（或没有队伍 id）的对局，
 *    会让"他们爱用什么"变成"这段时间强队都爱用什么"；
 * 3. **队名规则漂移**：`/draft-teams.json` 的键由 `opendota.norm` 生成，页面查表用的是
 *    `draftBoard.ts` 里那份复制品。两处差一个字符，手填队名就永远查不到队伍。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftFoe.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const TEAM = 7119388;
const FOE = 9572001;

// 阵营与胜负：同一支队在天辉赢、在夜魇输，两场的胜负都要算到它自己头上。
{
	const form = summarizeTeamForm(
		TEAM,
		'Team Spirit',
		[
			// 这是我们的主队，天辉，赢了；它拿 33，对手禁了 5，自己禁了 7。
			{
				id: 1,
				radiantTeamId: TEAM,
				direTeamId: FOE,
				didRadiantWin: true,
				pickBans: [
					{ heroId: 33, isPick: true, isRadiant: true },
					{ heroId: 5, isPick: false, isRadiant: false },
					{ heroId: 7, isPick: false, isRadiant: true },
					{ heroId: 8, isPick: true, isRadiant: false },
				],
			},
			// 同一支队换到夜魇，输了；又拿了一次 33。
			{ id: 2, radiantTeamId: FOE, direTeamId: TEAM, didRadiantWin: true, pickBans: [{ heroId: 33, isPick: true, isRadiant: false }] },
			// 结果还没写完的对局：出场要算，胜率不算。
			{ id: 3, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: null, pickBans: [{ heroId: 33, isPick: true, isRadiant: true }] },
			// 跟这支队无关的一场，必须被跳过。
			{ id: 4, radiantTeamId: 111, direTeamId: 222, didRadiantWin: true, pickBans: [{ heroId: 99, isPick: true, isRadiant: true }] },
		],
		30,
	);

	assert.equal(form.matches, 3, '只数这三场属于它的比赛');
	assert.equal(form.decided, 2, '结果未知的那场不进胜率');
	assert.equal(form.wins, 1, '夜魇那场它是输的，不能算赢');

	const hero33 = form.heroes.find((hero) => hero.heroId === 33);
	assert.deepEqual(
		hero33,
		{ heroId: 33, picks: 3, decided: 2, wins: 1, bansAgainst: 0, bansBy: 0, averagePickOrder: 0 },
		'同一英雄跨阵营、跨结果都要归到它头上；这三场没带 order，平均出手按 0（未知）算',
	);
	const banned = form.heroes.find((hero) => hero.heroId === 5);
	assert.deepEqual(
		banned,
		{ heroId: 5, picks: 0, decided: 0, wins: 0, bansAgainst: 1, bansBy: 0, averagePickOrder: 0 },
		'对手禁掉的要记在「被禁」而不是出场',
	);
	/*
	 * 自己禁的英雄要**留下来**，但只能挂在 `bansBy` 上：预测"他们会禁什么"用的就是它，
	 * 而"他们擅长什么"（picks）还是 0——这两件事以前被一起扔掉，于是预测 BP 时无从下手。
	 */
	const ownBan = form.heroes.find((hero) => hero.heroId === 7);
	assert.deepEqual(
		ownBan,
		{ heroId: 7, picks: 0, decided: 0, wins: 0, bansAgainst: 0, bansBy: 1, averagePickOrder: 0 },
		'自己禁的要记在 bansBy，且不能被当成"他们擅长"',
	);
	assert.equal(foeHighlights(form).some((hero) => hero.heroId === 7), false, '自己禁的不能进"他们擅长"那一栏');
	assert.equal(
		form.heroes.find((hero) => hero.heroId === 8),
		undefined,
		'对面拿的英雄不算它擅长什么',
	);
	assert.equal(
		form.heroes.find((hero) => hero.heroId === 99),
		undefined,
		'不属于这支队那场比赛的 BP 不能算进来',
	);
	ok('阵营、结果、被禁、无关对局四件事都算对了');
}

// 排序：先出场、再被对手禁；样本不足时不写胜率。
{
	const form = summarizeTeamForm(
		TEAM,
		'',
		[
			{ id: 1, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [
				{ heroId: 10, isPick: true, isRadiant: true },
				{ heroId: 20, isPick: true, isRadiant: true },
				{ heroId: 30, isPick: false, isRadiant: false },
			] },
			{ id: 2, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: false, pickBans: [
				{ heroId: 20, isPick: true, isRadiant: true },
				{ heroId: 10, isPick: true, isRadiant: true },
				// 20 同样出场两次，但还被对手禁过一次，所以排在前面。
				{ heroId: 20, isPick: false, isRadiant: false },
				{ heroId: 30, isPick: false, isRadiant: false },
			] },
		],
		30,
	);
	assert.deepEqual(
		form.heroes.filter((hero) => hero.picks > 0).map((hero) => hero.heroId),
		[20, 10],
		'同为 2 场时按被禁次数排，10 没有被禁所以排在后面',
	);
	assert.equal(foeWinRate(form.heroes[0]!), 0.5, '两场一胜一负是 50%');
	const single = summarizeTeamForm(TEAM, '', [{ id: 9, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [{ heroId: 44, isPick: true, isRadiant: true }] }], 30);
	assert.equal(foeWinRate(single.heroes[0]!), null, '只有一场时不给胜率，写上去就是误导');
	ok('排序按出场与被禁，样本不足时不报胜率');
}

// 文案：数字要写全，且不能漏出 undefined / NaN。
{
	const form = summarizeTeamForm(
		TEAM,
		'Team Spirit',
		[
			{ id: 1, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [{ heroId: 33, isPick: true, isRadiant: true }, { heroId: 5, isPick: false, isRadiant: false }] },
			{ id: 2, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [{ heroId: 33, isPick: true, isRadiant: true }, { heroId: 5, isPick: false, isRadiant: false }] },
		],
		30,
	);
	const line = foeHeroLine(form, 33);
	assert.match(line, /对面（Team Spirit）近 30 天拿了 2 场（2 胜 0 负，胜率 100\.0%）/, `依据文案不对：${line}`);
	assert.match(line, /对手禁过它 0 次/, '被禁 0 次不该省略——否则读者以为没这一项');
	assert.equal(foeHeroLine(form, 999), '', '不在窗口里的英雄没有依据，返回空串');
	assert.equal(foeHighlights(form, 1)[0]?.heroId, 33, '最擅长的那个要排在前面');
	// 只拿过一场的英雄不进依据，也不占「对面擅长」的位子：那不是偏好，是巧合。
	const once = summarizeTeamForm(TEAM, 'Team Spirit', [{ id: 7, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: false, pickBans: [{ heroId: 77, isPick: true, isRadiant: true }] }], 30);
	assert.equal(foeHeroLine(once, 77), '', '只拿过一场的不写进依据');
	assert.equal(foeHighlights(once).length, 0, '只拿过一场的不占「对面擅长」的位子');
	assert.match(foeHeadline(form), /Team Spirit 近 30 天 2 场，2 胜 0 负/, `摘要不对：${foeHeadline(form)}`);
	// 没名字也要能读：不能出现「undefined 近 30 天」。
	const unnamed = summarizeTeamForm(TEAM, '', [], 30);
	assert.equal(foeHeadline(unnamed), '', '没有比赛时不写摘要');
	for (const text of [line, foeHeadline(form), foeHeroLine(form, 33, 'ours')]) {
		assert.ok(!/undefined|NaN/.test(text), `文案里出现了 undefined/NaN：${text}`);
	}
	assert.match(foeHeroLine(form, 33, 'ours'), /我方（Team Spirit）/, '替对面落子时人称要翻过来');
	ok('文案带全数字、人称可翻，且不出现 undefined/NaN');
}

/*
 * 「第几手拿的」也是这一层的信息，而且它决定预测像不像真 BP：
 * 幻影长矛手这种被抓就死的核，实战里平均总在十几手之后才拿；拿它当一选等于把大哥亮出来。
 * 上游 `pickBans.order` 给的就是这个手号，这里钉住它按人平均、且缺 order 时不编。
 */
{
	const form = summarizeTeamForm(
		TEAM,
		'Team Spirit',
		[
			{ id: 11, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [
				{ heroId: 33, isPick: true, isRadiant: true, order: 9 },
				{ heroId: 33, isPick: true, isRadiant: true, order: 15 },
				// 没给 order 的那一场要算出场，但不许污染平均手号。
				{ heroId: 33, isPick: true, isRadiant: true },
			] },
			{ id: 12, radiantTeamId: TEAM, direTeamId: FOE, didRadiantWin: true, pickBans: [{ heroId: 41, isPick: true, isRadiant: true, order: 24 }] },
		],
		30,
	);
	assert.equal(form.heroes.find((hero) => hero.heroId === 33)?.averagePickOrder, 12, '平均手号要按有 order 的那几场算');
	assert.equal(form.heroes.find((hero) => hero.heroId === 41)?.averagePickOrder, 24, '只在最后一手拿的英雄，手号就是 24');
	assert.match(foeHeroLine(form, 33), /平均第 12\.0 手/, '依据里要写出来，读者才判断得了这一手拿它像不像真的');
	for (const text of [foeHeroLine(form, 33), foeHeroLine(form, 41)]) {
		assert.ok(!/undefined|NaN/.test(text), `文案里出现了 undefined/NaN：${text}`);
	}
	ok('拿它时平均在第几手：按有 order 的场次算，缺 order 不编');
}

/*
 * 队名规则：**查表这件事已经从浏览器搬到了构建期**。
 *
 * 以前浏览器里有一份 `normTeamName` 的复制品，和 `opendota.norm` 差一个字符的症状是
 * 「手填的队名永远查不到队伍」且不报错。现在 `draftTeams.ts` 直接用 `normalizeTeamName()`
 * 把队名换成 OpenDota id，随 `/draft-teams.json` 一起发给浏览器，那边不再需要这份规则。
 * 所以这里换成两条：改名的那一端必须还是同一个函数，页面脚本里不许再出现复制品。
 */
{
	const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
	const opendota = read('../src/lib/opendota.ts');
	const draftTeams = read('../src/lib/draftTeams.ts');
	const board = read('../src/scripts/draftBoard.ts');
	assert.match(opendota, /export function normalizeTeamName\(/, 'opendota 要导出队名正规化规则，构建期查表用');
	assert.match(draftTeams, /normalizeTeamName\s*}?\s*from '\.\/opendota'/, 'draftTeams 要直接用 opendota 那份规则，不许另抄一份');
	assert.match(draftTeams, /normalizeTeamName\(team\.name\)/, '队名要在这里换成 OpenDota id');
	assert.ok(!/lowercase\(\)\.replace\(/.test(board), '浏览器那边不该再有队名正规化的复制品');
	ok('队名查表只在构建期做一次，浏览器不再复制正规化规则');
}

console.log(`draftFoe 全部断言通过（${cases} 组）`);
