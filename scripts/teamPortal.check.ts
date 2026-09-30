import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liquipediaTeamId, parseTeamPortal } from '../src/lib/liquipediaParse.ts';
import { teamRegionLabel, unknownRegionKeys } from '../src/lib/teamRegions.ts';

/**
 * 活跃战队门户（`Portal:Teams` 的 Regions 面板）解析的自检。
 *
 * 战队名录的主来源从"赛程窗口反推"换成了这个门户，于是这里错了**页面照样能打开**：
 * 少一个地区就是少一整个区块，id 生成方式错了就是把同一支队劈成两张卡片、两个页面。
 * 所以钉住四件事：
 *
 * 1. **地区的键**由 `<h4 id>` 归一化而来（`Eastern_Europe_&amp;_CIS` → `eastern-europe-cis`），
 *    而且认得的那六个都要有中文标签；
 * 2. **一行的两种闭合写法**：Liquipedia 渲染出来是 `<br />`，它自己的模板文档里是 `<br>`，
 *    只认一种就会把整行吃掉（实测踩过）；
 * 3. **队伍 id 只认 href**，不认队名：门户里 `Inner_Circle_x_Insanity` 显示成「IC x Insanity」，
 *    赛程页显示成「Inner Circle x Insanity」——按队名生成会得到两个 id，同一支队两个页面；
 * 4. **队标取 `srcset` 里最大的一档**（门户自带的 2x），拿不到才退回 `src`。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/teamPortal.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/**
 * 照真实页面缩写的夹具：保留解析真正依赖的那几处——地区标题的 `<h4 id>`、每行的
 * `team-template-team-standard`、`team-template-image-icon` 上多出来的 `lightmode` 类、
 * `srcset`，以及两种 `<br>` 写法。两端各去掉一个没用的 panel（`panel-box` 之外的内容）。
 */
const PORTAL_HTML = `
<div class="panel-box wiki-bordercolor-light"><h4 id="North_America" style="display:none"> North America </h4>
<div class="panel-box-body"><span data-highlightingclass="GamerLegion" class="team-template-team-standard"><span class="team-template-image-icon"><a href="/dota2/GamerLegion" title="GamerLegion"><img alt="GamerLegion" src="/commons/images/thumb/2/21/GamerLegion_2026_allmode.png/49px-GamerLegion_2026_allmode.png" srcset="/commons/images/thumb/2/21/GamerLegion_2026_allmode.png/74px-GamerLegion_2026_allmode.png 1.5x, /commons/images/thumb/2/21/GamerLegion_2026_allmode.png/99px-GamerLegion_2026_allmode.png 2x"></a></span> <span class="team-template-text"><a href="/dota2/GamerLegion" title="GamerLegion">GamerLegion</a></span></span><br /></div></div>
<div class="panel-box wiki-bordercolor-light"><h4 id="Eastern_Europe_&amp;_CIS"> Eastern Europe &amp; CIS </h4>
<div class="panel-box-body"><span data-highlightingclass="Team Spirit" class="team-template-team-standard"><span class="team-template-image-icon team-template-lightmode"><a href="/dota2/Team_Spirit" title="Team Spirit"><img alt="Team Spirit" src="/commons/images/thumb/6/66/Team_Spirit_2022_lightmode.png/43px-Team_Spirit_2022_lightmode.png"></a></span> <span class="team-template-text"><a href="/dota2/Team_Spirit" title="Team Spirit">Team Spirit</a></span></span><br><span data-highlightingclass="IC x Insanity" class="team-template-team-standard"><span class="team-template-image-icon"><a href="/dota2/Inner_Circle_x_Insanity" title="IC x Insanity"><img alt="IC x Insanity" src="/commons/images/thumb/a/a1/Inner_Circle_x_Insanity_allmode.png/50px-Inner_Circle_x_Insanity_allmode.png"></a></span> <span class="team-template-text"><a href="/dota2/Inner_Circle_x_Insanity" title="IC x Insanity">IC x Insanity</a></span></span><br /></div></div>
`;

// 1. 地区、顺序、计数
{
	const regions = parseTeamPortal(PORTAL_HTML);
	assert.deepEqual(
		regions.map((region) => [region.key, region.teams.length]),
		[
			['north-america', 1],
			['eastern-europe-cis', 2],
		],
		'地区按门户上的顺序出现，键要归一化（下划线、`&amp;` 都要收）',
	);
	assert.equal(regions[1].label, 'Eastern Europe & CIS', '标签保留门户原文（实体要解开），中文由 teamRegions 负责');
	ok('地区：顺序、键、数量都对得上');
}

// 2. 两种 <br> 写法都要认，行内的 lightmode 类不能把整行吃掉
{
	const [na, eeu] = parseTeamPortal(PORTAL_HTML);
	assert.equal(na.teams[0].name, 'GamerLegion', '`<br />` 结尾的那行要解析出来');
	assert.deepEqual(
		eeu.teams.map((team) => team.name),
		['Team Spirit', 'IC x Insanity'],
		'`<br>` 结尾的行、以及带 `team-template-lightmode` 类的行都要解析出来',
	);
	ok('两种 <br> 闭合与 lightmode 类：整行都不丢');
}

// 3. id 只认 href：门户显示名和赛程页不一样时，两队仍是同一个 id
{
	const [, eeu] = parseTeamPortal(PORTAL_HTML);
	const ic = eeu.teams[1];
	assert.equal(ic.wiki, 'Inner_Circle_x_Insanity', '页面标题取自 href');
	assert.equal(liquipediaTeamId(ic.wiki ?? ic.name), 'lp-team-inner-circle-x-insanity');
	assert.notEqual(
		liquipediaTeamId(ic.name),
		'lp-team-inner-circle-x-insanity',
		'按门户上的显示名（IC x Insanity）会算出另一个 id——这正是不能用队名生成 id 的原因',
	);
	assert.equal(
		liquipediaTeamId('Inner Circle x Insanity'),
		liquipediaTeamId('Inner_Circle_x_Insanity'),
		'赛程页那份显示名与页面标题算出来必须是同一个 id，否则同一支队会有两个页面',
	);
	ok('队伍 id：按页面标题生成，显示名换了也对得上');
}

// 4. 队标取 srcset 里最大的一档，没有 srcset 才退回 src
{
	const [na, eeu] = parseTeamPortal(PORTAL_HTML);
	assert.equal(
		na.teams[0].logo,
		'https://liquipedia.net/commons/images/thumb/2/21/GamerLegion_2026_allmode.png/99px-GamerLegion_2026_allmode.png',
		'有 srcset 就用最大的一档（2x），卡片在高分屏上才不糊',
	);
	assert.equal(
		eeu.teams[0].logo,
		'https://liquipedia.net/commons/images/thumb/6/66/Team_Spirit_2022_lightmode.png/43px-Team_Spirit_2022_lightmode.png',
		'没有 srcset 时用 src，并且要补上 Liquipedia 主机名',
	);
	ok('队标：优先 srcset 最大档，退回 src');
}

// 5. 地区的键要有中文标签；认不得的原样显示门户给的名字，别混进"其他"
{
	const keys = parseTeamPortal(PORTAL_HTML).map((region) => region.key);
	assert.deepEqual(unknownRegionKeys(keys), [], '已知的六个地区必须都有中文标签');
	assert.equal(teamRegionLabel('eastern-europe-cis', 'Eastern Europe & CIS'), '东欧与独联体');
	assert.equal(teamRegionLabel('middle-east', 'Middle East'), 'Middle East', '门户加了新地区就照它自己的名字显示，别编一个中文');
	assert.equal(unknownRegionKeys(['middle-east']).length, 1, '新地区会被自检发现');
	ok('地区标签：已知的有中文，未知的原样显示且能被发现');
}

// 6. 接线：门户抓取要走缓存 + 名录页面真的按地区分区
{
	const ROOT = new URL('../', import.meta.url);
	const read = (name: string): string => readFileSync(new URL(name, ROOT), 'utf8');

	const api = read('src/lib/liquipediaApi.ts');
	assert.match(api, /TEAM_PORTAL_CACHE_FILE/, '门户要落盘缓存');
	assert.match(api, /Portal:Teams/, '抓的是 Portal:Teams 这一页');
	assert.match(api, /parseTeamPortal\(html\)/, '解析要走 parseTeamPortal');
	assert.match(api, /reportSource\('liquipedia-teams'/, '门户的抓取结果要进构建汇总（静默失败看不出来）');

	const index = read('src/lib/tournamentIndex.ts');
	assert.match(index, /getTeamPortal\(\)/, '索引要把门户并进来，否则门户独有队伍没有页面');
	assert.match(index, /portalIds/, '要留一份"门户收录过谁"，名录页靠它分「其他」');

	/*
	 * 这一条守的是「一队两页」：门户里的显示名与页面标题不一样（IC x Insanity /
	 * Inner Circle x Insanity），谁把 id 改成按 `team.name` 算，同一支队就会多出一个页面。
	 * 单看 `liquipediaTeamId()` 本身是拦不住的——判据在调用点。
	 */
	const portal = read('src/lib/teamPortal.ts');
	assert.match(
		portal,
		/liquipediaTeamId\(team\.wiki \?\? team\.name\)/,
		'门户里的队伍 id 要按页面标题算（显示名会变），否则同一支队会有两个页面',
	);

	const page = read('src/pages/teams.astro');
	assert.match(page, /index\.regions/, '名录页按门户的地区分区');
	assert.doesNotMatch(page, /from '\.\.\/lib\/leagueTier'/, '名录页不该再依赖档位模块');
	assert.doesNotMatch(page, /LEAGUE_TIER_META|bestTierOf|isFirstTier/, '名录页不再用档位给队伍分层（档位只留在赛事页）');
	ok('接线：缓存、构建汇总、索引、名录页四处一致');
}

console.log(`teamPortal 全部断言通过（${cases} 组）`);
