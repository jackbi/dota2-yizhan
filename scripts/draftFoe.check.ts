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
	assert.deepEqual(hero33, { heroId: 33, picks: 3, decided: 2, wins: 1, bansAgainst: 0 }, '同一英雄跨阵营、跨结果都要归到它头上');
	const banned = form.heroes.find((hero) => hero.heroId === 5);
	assert.deepEqual(banned, { heroId: 5, picks: 0, decided: 0, wins: 0, bansAgainst: 1 }, '对手禁掉的要记在「被禁」而不是出场');
	assert.equal(
		form.heroes.find((hero) => hero.heroId === 7),
		undefined,
		'自己禁的英雄不算它擅长什么',
	);
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

// 队名规则：页面里那份复制品必须和 `opendota.norm` 完全一致。
{
	const regexOf = (path: string): string => {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		const match = /replace\((\/[^\n]*?\/g),\s*''\)/.exec(source);
		assert.ok(match, `${path} 里没找到队名正规化规则`);
		return match[1]!;
	};
	assert.equal(
		regexOf('../src/lib/opendota.ts'),
		regexOf('../src/scripts/draftBoard.ts'),
		'/draft-teams.json 的键与页面查表必须用同一条正规化规则，否则手填队名永远查不到',
	);
	ok('页面与 opendota 的队名正规化规则一致');
}

console.log(`draftFoe 全部断言通过（${cases} 组）`);
