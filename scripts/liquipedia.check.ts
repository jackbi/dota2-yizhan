import assert from 'node:assert/strict';
import { parseBracketMatches, parseMatches } from '../src/lib/liquipediaParse.ts';

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

console.log('liquipedia.check: 赛程解析 4 组用例通过');
