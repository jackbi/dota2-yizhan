import assert from 'node:assert/strict';
import {
	parseBracketMatches,
	parseLeagueTier,
	parseMatches,
	parseTeamDarkLogo,
	parseTeamRoster,
} from '../src/lib/liquipediaParse.ts';

/**
 * Liquipedia 赛程解析的自检。
 *
 * 这里守的是三件会**静默丢数据**的事，页面上看不出来——只会少几场比赛：
 *
 * 1. **队标 span 的 class 不是固定的**。只有亮色队标的队伍会多一个 `team-template-lightmode`，
 *    早先要求 class 恰好等于 `team-template-image-icon`，于是那半边的队伍解析成空，而调用方是
 *    「一方未定就跳过整场」，连对手一起丢（实测主赛程页 100 场里丢 56 场，其中 29 场是这个
 *    原因，包括 Xtreme Gaming vs Team Nemesis）。
 * 2. **主赛程页与赛事页是两套模板**：前者 `<div class="match-info">`，后者 bracket 的弹层
 *    `brkts-match-info-popup`，内层同构。只认前者的话，赛事页一场都解析不出来。
 * 3. **阶段子页要归到父赛事**：`PGL/Wallachia/9/Group_Stage` 与 `PGL/Wallachia/9` 是同一届，
 *    不归并就会被拆成两个赛事，赛事页只剩一角。
 *
 * 夹具是照着真实页面的 markup 缩写的（保留解析真正依赖的那几个属性），所以不需要联网。
 */

/** 主赛程页里的一场：客队只有亮色队标（回归 1），已完赛，主队赢。 */
const MATCHLIST_BLOCK = `
<div class="match-info"><span class="match-info-countdown"><span class="timer-object" data-format="full" data-timestamp="1790233200" data-finished="finished">September 24, 2026</span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left match-info-header-winner"><div class="block-team flipped"><span class="team-template-image-icon team-template-lightmode"><a href="/dota2/Team_Nemesis" title="Team Nemesis"><img alt="" src="/commons/images/thumb/e/ed/Team_Nem_lightmode.png/56px-Team_Nem_lightmode.png" /></a></span><span class="name"><a href="/dota2/Team_Nemesis" title="Team Nemesis">Nem</a></span></div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-icon"></span><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper">2 : 1</span><span class="match-info-header-scoreholder-lower">(Bo3)</span></span><span class="match-info-header-scoreholder-icon"></span></div><div class="match-info-header-opponent"><div class="block-team"><span class="team-template-image-icon"><a href="/dota2/Xtreme_Gaming" title="Xtreme Gaming"><img alt="" src="/commons/images/thumb/7/72/Xtreme_Gaming_allmode.png/50px-Xtreme_Gaming_allmode.png" /></a></span><span class="name"><a href="/dota2/Xtreme_Gaming" title="Xtreme Gaming">XG</a></span></div></div></div><div class="match-info-tournament"><span><span class="league-icon-small-image"><a href="/dota2/PGL/Wallachia/9/Group_Stage#Round_5" title="PGL Wallachia 9 Group Stage"><img alt="" src="/commons/x.png" /></a></span></span></div></div>
`;

/** 对阵未定：一方是 TBD，没有 `block-team`，整场跳过而不是编一个占位队名。 */
const TBD_BLOCK = `
<div class="match-info"><span class="match-info-countdown"><span class="timer-object" data-format="full" data-timestamp="1790319600">September 25, 2026</span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left"><div class="block-team flipped"><span class="team-template-image-icon"><span class="name">TBD</span></span></div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-upper">vs</span><span class="match-info-header-scoreholder-lower">(Bo3)</span></div></div><div class="match-info-tournament"><span><span class="league-icon-small-image"><a href="/dota2/PGL/Wallachia/9" title="PGL Wallachia 9"><img alt="" src="/commons/x.png" /></a></span></span></div></div>
`;

/** 赛事页里的一场：bracket 的隐藏弹层，内层与主赛程页同构。 */
const BRACKET_BLOCK = `
<div class="brkts-popup brkts-popup-container brkts-match-info-popup" data-analytics-name="Match popup"><span class="match-info-countdown"><span class="timer-object" data-format="full" data-timestamp="1789986300" data-finished="finished">September 16, 2026</span></span><div class="match-info-header"><div class="match-info-header-opponent match-info-header-opponent-left"><div class="block-team flipped"><span class="team-template-image-icon"><a href="/dota2/MOUZ" title="MOUZ"><img alt="" src="/commons/images/thumb/m/MOUZ.png/50px-MOUZ.png" /></a></span></div></div><div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-scorewrapper"><span class="match-info-header-scoreholder-upper">1 : 2</span><span class="match-info-header-scoreholder-lower">(Bo3)</span></span></div><div class="match-info-header-opponent"><div class="block-team"><span class="team-template-image-icon team-template-lightmode"><a href="/dota2/Team_Nemesis" title="Team Nemesis"><img alt="" src="/commons/images/thumb/e/ed/Team_Nem_lightmode.png" /></a></span></div></div></div></div>
`;

/** 固定「现在」，让状态判定可复现：夹具里的三场分别是已完赛 / 未开赛。 */
const NOW = 1790233300;

const list = parseMatches(MATCHLIST_BLOCK + TBD_BLOCK, NOW);
assert.equal(list.length, 1, 'TBD 的那一场应当被跳过，只解析出有对阵的那一场');
const [match] = list;
assert.equal(match.home.name, 'Team Nemesis', '只有亮色队标的队伍也要能解析出来');
assert.equal(match.away.name, 'Xtreme Gaming');
assert.equal(match.status, 'completed', 'data-finished=finished 应当判成已完赛');
assert.deepEqual([match.home.score, match.away.score], [2, 1]);
assert.equal(match.winner, 'home', '胜方看比分区的高亮，不是比大小');
assert.equal(match.bo, 3);
assert.equal(match.eventId, 'pgl-wallachia-9', '阶段子页要归到父赛事');
assert.equal(match.eventName, 'PGL Wallachia 9');
assert.equal(match.sourceUrl, 'https://liquipedia.net/dota2/PGL/Wallachia/9/Group_Stage', 'sourceUrl 指回这一场所在的页面，赛事页补全靠它取路径');
assert.equal(match.id, 'lp-1790233200-team-nemesis-xtreme-gaming');

/** 区域子赛不是「阶段」，保持独立赛事，不该并进上一级。 */
const regional = parseMatches(
	MATCHLIST_BLOCK.replace('/dota2/PGL/Wallachia/9/Group_Stage', '/dota2/BLAST/SLAM/9/Southeast_Asia'),
	NOW,
);
assert.equal(regional[0]?.eventId, 'blast-slam-9-southeast-asia', '区域子赛保持自己的赛事 id');

/** 赛事页：切块靠 `brkts-match-info-popup`，解析走同一份字段逻辑。 */
const bracket = parseBracketMatches(BRACKET_BLOCK, 'PGL/Wallachia/9/Group_Stage', NOW);
assert.equal(bracket.length, 1, 'bracket 弹层里的一场要能解析出来');
assert.equal(bracket[0]?.home.name, 'MOUZ');
assert.equal(bracket[0]?.away.name, 'Team Nemesis');
assert.deepEqual([bracket[0]?.home.score, bracket[0]?.away.score], [1, 2]);
assert.equal(bracket[0]?.status, 'completed');
assert.equal(bracket[0]?.eventId, 'pgl-wallachia-9');

/*
 * 档位：`Liquipedia Tier` 那一行。夹具照抄实测到的两种写法——
 * 正式赛事是一个带链接的 `Tier N`，表演赛会先写类型再在括号里给档位（两个字段）。
 */
const TIER_T1 = '<div class=""><div class="infobox-cell-2 infobox-description">Liquipedia Tier:</div><div><a href="/dota2/Tier_1_Tournaments" title="Tier 1 Tournaments">Tier 1</a></div></div>';
const TIER_SHOWMATCH =
	'<div class=""><div class="infobox-cell-2 infobox-description">Liquipedia Tier:</div><div><a href="/dota2/Show_Matches" title="Show Matches">Showmatch</a>&#160;(<a href="/dota2/Tier_3_Tournaments" class="mw-redirect" title="Tier 3 Tournaments">Tier 3</a>)</div></div>';
/** 阶段子页没有 Infobox——档位要去根页面取，这里钉住"别把子页的空当成人家的档位"。 */
const TIER_ABSENT = '<div class="infobox"><div>Patch:</div><div>7.41f</div></div>';

assert.deepEqual(parseLeagueTier(TIER_T1), { tier: 1 }, '正式赛事读档位');
assert.deepEqual(
	parseLeagueTier(TIER_SHOWMATCH),
	{ tier: 3, showmatch: true },
	'表演赛的档位与类型是两个字段：`liquipediatiertype` 也在，但档位照样要读出来',
);
assert.equal(parseLeagueTier(TIER_ABSENT), undefined, '没有那一行就是没有档位，不要猜一个默认值');
// `title="Tier 1 Tournaments"` 是属性，去掉标签之后不该被当成档位文字。
assert.equal(parseLeagueTier('<div>Liquipedia Tier:</div><div><a title="Tier 1 Tournaments">Misc</a></div>'), undefined);

/*
 * 战队名单。夹具照抄 Team Spirit 与 Team Liquid 两页的实测结构，
 * 三段各自对应一个必须成立的规则：离队整块不要、教练组单独归、替补在注释外时才认。
 */
const TEAM_PAGE = `
==Players of Team Spirit==
===Active Roster===
{{Squad|status=active
|{{Person|flag=ua|id=Yatoro|name=Illya Mulyarchuk|position=1|joindate=2020-12-19<ref name="ts 20201219"/>}}
|{{Person|flag=ru|id=Larl|name=Denis Sigitov|position=2|joindate=2022-12-08}}
|{{Person|flag=ru|id=not me|name=Alexey Kosmynin|position=5|captain=yes|joindate=2026-05-12}}
}}
===Coaching Staff===
{{Squad|type=staff|status=active
|{{Person|flag=at|id=Tobi|link=Tobi (Austrian player)|name=Tobias Buchner|role=Coach|joindate=2026-06-20}}
}}
{{box|end}}<!--
{{stand-ins table|
}}-->
===Inactive Roster===
{{Squad|status=inactive
|{{Person|flag=ru|id=Collapse|name=Magomed Khalilov|position=3|joindate=2020-12-19|inactivedate=2026-09-21}}
}}
`;

const spirit = parseTeamRoster(TEAM_PAGE);
assert.deepEqual(
	spirit.players.map((p) => [p.nick, p.position]),
	[
		['Yatoro', 1],
		['Larl', 2],
		['not me', 5],
	],
	'现役按号位排；昵称里的空格要保留',
);
assert.equal(spirit.players[0]?.joined, '2020-12-19', '`<ref>` 要从加入日期里去掉');
assert.equal(spirit.players[2]?.captain, true, 'captain=yes 要读出来');
assert.equal(spirit.players[0]?.realName, 'Illya Mulyarchuk');
assert.equal(
	spirit.players[0]?.page,
	'Yatoro',
	'没有 link= 时选手页标题就是昵称本身（MediaWiki 首字母不区分大小写，查账号靠它）',
);
assert.equal(
	spirit.staff[0]?.page,
	'Tobi (Austrian player)',
	'写了 `link=` 就用它当页面标题——昵称撞名时只有 link 指得准',
);
assert.deepEqual(
	spirit.staff.map((s) => [s.nick, s.role]),
	[['Tobi', 'Coach']],
	'`type=staff` 归教练组，不要混进选手',
);
assert.equal(
	spirit.players.some((p) => p.nick === 'Collapse'),
	false,
	'`status=inactive` 是离队名单，一个人都不该进来',
);
assert.deepEqual(
	spirit.standins,
	[],
	'被注释掉的替补表不算数（形状断言：换个顺序也过，切片本身由下面「现役段之后」那组钉住）',
);

/** Team Liquid 那种：替补表是活的，而且 `tournament=` 里嵌了模板、后面还跟着内链。 */
const LIQUID_PAGE = `
===Active Roster===
{{Squad|status=active
|{{Person|flag=se|id=miCKe|name=Michael Vu|position=1|joindate=2019-10-02}}
|{{Person|flag=se|id=Boxi|name=Samuel Svahn|position=4|joindate=2019-10-02}}
}}
{{stand-ins table|
{{stand-in|flag=my|id=MidOne|name=Yeik Nai Zheng|tournament={{LeagueIconSmall/blast slam|link=BLAST/SLAM/8|name=BLAST SLAM VIII}} [[BLAST/SLAM/8|BLAST SLAM VIII]]}}
}}
<!--
===Inactive Roster===
{{Squad|status=inactive
|{{Person|flag=se|id=Insania|name=Aydin Sarkohi|position=5|inactivedate=2026-09-20}}
}}
-->
`;

const liquid = parseTeamRoster(LIQUID_PAGE);
assert.deepEqual(liquid.players.map((p) => p.nick), ['miCKe', 'Boxi']);
assert.deepEqual(
	liquid.standins.map((s) => [s.nick, s.realName]),
	[['MidOne', 'Yeik Nai Zheng']],
	'替补表里的 `tournament=` 嵌了模板、又跟了一条内链，参数切割要能扛住',
);
assert.equal(
	liquid.players.some((p) => p.nick === 'Insania'),
	false,
	'整段被注释掉的离队名单同样不该进来',
);

/*
 * 历史段：**这两组才是真的钉住 `activeSectionEnd` 的**（上面两组里，历史名单要么被注释掉、
 * 要么靠 `status=former` 就挡住了——实测把切片整个去掉，那两组照样通过）。
 *
 * 判据来自真实页面：`===Former Players===` 后面塞着大量历史 `{{stand-in}}`（OG 一页 27 条、
 * 同一个人出现 5 次），照单全收就会渲染成「替补：Ceb、Ceb、Ceb…」。
 */
const FORMER_STANDINS_PAGE = `
===Active Roster===
{{Squad|status=active
|{{Person|flag=cn|id=Ame|name=Wang Chunyu|position=1}}
}}
===Former Players===
{{stand-ins table|
{{stand-in|flag=se|id=OldOne|name=Old One}}
{{stand-in|flag=se|id=OldTwo|name=Old Two}}
}}
`;

const former = parseTeamRoster(FORMER_STANDINS_PAGE);
assert.deepEqual(former.players.map((p) => p.nick), ['Ame'], '现役段照旧');
assert.deepEqual(former.standins, [], '历史段里的替补表要整块丢掉，否则会出现「Ceb、Ceb、Ceb…」');

/*
 * 教练组不受切片影响：页面顺序不统一，`===Coaching Staff===` 排在 `===Former===` 之后的
 * 队伍真实存在，一刀切下去那些队伍的教练组会整块消失（而页面上"教练组"这一栏本来就没几个字，
 * 少了看不出来是丢了还是本来没有）。离职的那位仍然靠 `status=former` 挡住。
 */
const STAFF_AFTER_FORMER_PAGE = `
===Active Roster===
{{Squad|status=active
|{{Person|flag=ua|id=Yatoro|name=Illya Mulyarchuk|position=1}}
}}
===Former Players===
{{Squad|status=former|title=Former Player
|{{Person|flag=se|id=OldGuy|name=Old Guy|position=2}}
}}
===Coaching Staff===
{{Squad|type=staff|status=active
|{{Person|flag=ru|id=sikle|name=Mark Lerman|role=Analyst}}
}}
{{Squad|type=staff|status=former
|{{Person|flag=ru|id=ExCoach|name=Ex Coach|role=Coach}}
}}
`;

const lateStaff = parseTeamRoster(STAFF_AFTER_FORMER_PAGE);
assert.deepEqual(lateStaff.players.map((p) => p.nick), ['Yatoro'], '离队的那位不进选手名单');
assert.deepEqual(
	lateStaff.staff.map((s) => [s.nick, s.role]),
	[['sikle', 'Analyst']],
	'教练组写在历史段之后也要认；离职的教练仍然被 status 挡住',
);

/*
 * 深色版队标：站点是纯深色主题，而赛程页给的缩略图常常是 `_lightmode`——实测叠在
 * `#2f140f` 上 Team Spirit 只有 13.9、Team Lynx 12.6、Team Nemesis 25.9（可看的 NAVI 是 73.2）。
 * 换成 Infobox 的 `imagedark` 之后分别是 154.5 / 131.0 / 40.9。这里钉住"拿得到文件名"这一步，
 * 拿到之后才谈得上问 API 换成地址。
 */
{
	assert.equal(
		parseTeamDarkLogo('{{Infobox team\n|image=Team Spirit 2022 full lightmode.png\n|imagedark=Team Spirit 2022 full darkmode.png\n|teamid=7119388\n}}'),
		'Team Spirit 2022 full darkmode.png',
		'`imagedark` 要原样读出来（带空格），它是给深色背景的那一版',
	);
	assert.equal(
		parseTeamDarkLogo('|imagedark=Team Lynx full darkmode.png<ref>{{cite web|url=https://x|title=y}}</ref>'),
		'Team Lynx full darkmode.png',
		'值里跟着 `<ref>` 时要清掉，别把引用塞进文件名',
	);
	assert.equal(parseTeamDarkLogo('|image=Team Liquid 2024 full lightmode.png'), undefined, '没写就不猜');
	assert.equal(parseTeamDarkLogo('|imagedark=\n'), undefined, '空值等于没写');
}

console.log('liquipedia.check 通过：赛程解析、档位解析与战队名单');
