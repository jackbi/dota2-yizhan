import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPlaceholderLogo, teamLogoSources } from '../src/lib/teamLogoSource.ts';

/**
 * 队标：哪些要去下载、哪些不该下。
 *
 * 队标地址来自 Liquipedia 赛程页里那段 HTML，"有没有队标"完全由它说了算。这里钉住的是
 * 从那堆地址里挑出「真的要去下的那些」的判据——挑错了界面上看不出来是判据错了：
 * 少下一个是一张破图，多下一个就是把 Valve 的通用标志当成某支队的队标。
 *
 * 下载本身（直连 → 代理 → 落盘 → 发布）归 `localImages.ts`，缓存完整性有
 * `buildCache.check.ts` 守着，这里不重复。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/teamLogos.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 实测的两个地址，照抄缓存里的形状。 */
const REAL_LOGO =
	'https://liquipedia.net/commons/images/thumb/d/db/Yangon_Galacticos_2021_allmode.png/55px-Yangon_Galacticos_2021_allmode.png';
const DEFAULT_LOGO =
	'https://liquipedia.net/commons/images/thumb/f/f4/Dota_2_default_allmode.png/50px-Dota_2_default_allmode.png';
const OTHER_LOGO = 'https://liquipedia.net/commons/images/thumb/b/b7/Ivory_2024_allmode.png/44px-Ivory_2024_allmode.png';

// 1. 占位图：Liquipedia 给"还没有队标"的队伍挂的是同一张 Valve 通用图
{
	assert.equal(isPlaceholderLogo(DEFAULT_LOGO), true, 'Valve 那张通用图要认出来');
	assert.equal(isPlaceholderLogo(REAL_LOGO), false, '真实队标不能误判成占位图');
	assert.equal(isPlaceholderLogo(undefined), false, '没有地址不叫占位图');
	assert.equal(isPlaceholderLogo(''), false, '空字符串不叫占位图');
	ok('占位图：只认 Liquipedia 那张通用图');
}

// 2. 收敛清单：空地址、占位图都不要，同一支队只留一个地址
{
	const sources = teamLogoSources([
		{ id: 'lp-team-no-logo', logo: undefined },
		{ id: 'lp-team-team-kinetix', logo: DEFAULT_LOGO },
		{ id: 'lp-team-ivory', logo: OTHER_LOGO },
		// 同一支队在另一场比赛里又出现一次，地址也换了一份（赛程页给不同版面配不同缩略图）。
		{ id: 'lp-team-ivory', logo: REAL_LOGO },
		{ id: 'lp-team-yangon-galacticos', logo: REAL_LOGO },
	]);

	assert.deepEqual(
		sources,
		[
			{ key: 'lp-team-ivory', url: REAL_LOGO },
			{ key: 'lp-team-yangon-galacticos', url: REAL_LOGO },
		],
		'只留下有真实队标的队伍，且每支队只下一次',
	);
	ok('清单：占位图与空地址不下，重复的队伍只留一份');
}

// 3. 同一支队有多个宽度的地址时，留下最宽的那张——且**与出现顺序无关**
{
	const NV_50 = 'https://liquipedia.net/commons/images/thumb/3/3f/Natus_Vincere_2021_lightmode.png/50px-Natus_Vincere_2021_lightmode.png';
	const NV_57 = 'https://liquipedia.net/commons/images/thumb/3/3f/Natus_Vincere_2021_lightmode.png/57px-Natus_Vincere_2021_lightmode.png';
	const LY_A = 'https://liquipedia.net/commons/images/thumb/4/43/Team_Lynx_allmode.png/37px-Team_Lynx_allmode.png';
	const LY_L = 'https://liquipedia.net/commons/images/thumb/4/43/Team_Lynx_lightmode.png/37px-Team_Lynx_lightmode.png';

	const once = teamLogoSources([
		{ id: 'lp-team-natus-vincere', logo: NV_50 },
		{ id: 'lp-team-natus-vincere', logo: NV_57 },
		{ id: 'lp-team-team-lynx', logo: LY_L },
		{ id: 'lp-team-team-lynx', logo: LY_A },
	]);
	assert.deepEqual(
		once,
		[
			{ key: 'lp-team-natus-vincere', url: NV_57 },
			{ key: 'lp-team-team-lynx', url: LY_A },
		],
		'宽度不同取最宽的那张；宽度相同的两张按地址定序（allmode 排在 lightmode 前面），别退回「看谁先出现」',
	);

	// 顺序换了结果必须一样：赛程顺序每轮都在变，判据不稳定就等于每轮换一个文件名。
	const reversed = teamLogoSources([
		{ id: 'lp-team-team-lynx', logo: LY_A },
		{ id: 'lp-team-team-lynx', logo: LY_L },
		{ id: 'lp-team-natus-vincere', logo: NV_57 },
		{ id: 'lp-team-natus-vincere', logo: NV_50 },
	]);
	assert.deepEqual(
		reversed,
		once,
		'同一批输入换个顺序必须挑出同一个地址，否则每轮构建都会换文件名、缓存全废',
	);
	ok('多个宽度：取最宽的，且与出现顺序无关');
}

// 4. 接线：判据、频道目录、发布目录三处必须对得上，少一处就是"图下回来了但页面是 404"
{
	const ROOT = new URL('../', import.meta.url);
	const read = (name: string): string => readFileSync(new URL(name, ROOT), 'utf8');

	const channel = read('src/lib/teamLogos.ts');
	assert.match(channel, /dir:\s*'teamlogos'/, '队标频道的目录叫 teamlogos');
	assert.match(channel, /localizeImages\(TEAM_LOGO_CHANNEL/, '队标也要走通用的本地化流程，不要自己写一套下载');
	assert.match(channel, /teamLogoSources\(teams\)/, '频道要用 teamLogoSource 那份判据，不能各挑各的');

	const config = read('astro.config.mjs');
	assert.match(
		config,
		/\{\s*dir:\s*'teamlogos',[^}]*\}/,
		'astro.config.mjs 的 IMAGE_CHANNELS 要有 teamlogos：少了这个目录不会被拷进 dist，dev 下也没有中间件兜底',
	);

	// 本地化必须发生在 assemble() 之后、任何页面拿到 bundle 之前：否则同一轮构建里，
	// 先渲染的页面拿到外链、后渲染的拿到本地路径。
	const api = read('src/lib/tournamentsApi.ts');
	assert.match(api, /assemble\(\)\.then\(localizeLogos\)/, '队标本地化要盖在 getTournaments 的单飞里');
	assert.match(api, /refs\.push\(match\.home, match\.away\)/, '要把每一场对阵的两支队都收进来');
	assert.match(
		api,
		/refs\.push\(\.\.\.event\.teams\)/,
		'赛事页「参赛队伍」那栏读的是 buildEvents() 归并出来的拷贝，不一起收就会漏掉一栏',
	);
	assert.match(
		api,
		/for \(const team of refs\)/,
		'要遍历**全部**引用去改写：同一支队在 bundle 里是一堆各自独立的对象，只改一个的话其余的还在热链',
	);
	assert.match(api, /if \(isPlaceholderLogo\(team\.logo\)\) delete team\.logo/, '占位图要清掉，否则页面会显示 Valve 的通用标志');
	ok('接线：判据、频道目录、发布目录、调用点四处一致');
}

// 5. 底板：队标必须放在浅色底板上，且不许裁切
{
	/*
	 * 这一组守的正是「页面上看得出来、但构建不会报错」的那两类：
	 *
	 * 1. **队徽本身是黑的**。实测 46 张里有 9 张（Team Spirit、Team Lynx、Team Nemesis、
	 *    MOUZ、Natus Vincere 这类）的图形像素几乎全黑，放在 `--color-surface-2` 上等于没画。
	 *    换成 `bg-plate` 之后黑队徽才看得见；谁把它改回深色底板，页面就退回「一片空白」。
	 * 2. **裁切**。`object-cover` 会把非方形的队标裁成方图：Team Spirit 那张
	 *    `Team_Spirit_2022_full_darkmode.png` 是 120×31 的文字组合，裁完只剩一个字母的碎片，
	 *    看起来就像"队标没加载出来"。`object-contain` 保留整张图，哪怕小一点。
	 */
	const ROOT = new URL('../', import.meta.url);
	const read = (name: string): string => readFileSync(new URL(name, ROOT), 'utf8');

	const pages = [
		'src/components/MatchRow.astro',
		// 战队名录的卡片抽成了组件（名录页自己不再画队标），它也是"一处队标"。
		'src/components/TeamCard.astro',
		'src/pages/matches/[id].astro',
		'src/pages/teams/[id].astro',
		'src/pages/tournaments/[id].astro',
	];

	let imgs = 0;
	for (const name of pages) {
		const source = read(name);
		assert.match(source, /bg-plate/, `${name} 的队标要用浅色底板（bg-plate），否则黑队徽在深色卡上看不见`);
		const marks = [...source.matchAll(/\.logo\s*\?\s*\(/g)];
		assert.ok(marks.length > 0, `${name} 里没找到队标的 img，页面结构变了就要同步这个自检`);
		for (const mark of marks) {
			const block = source.slice(mark.index ?? 0, (mark.index ?? 0) + 600);
			assert.match(block, /object-contain/, `${name} 的队标要用 object-contain，别把宽队标裁成方图`);
			assert.doesNotMatch(block, /object-cover/, `${name} 的队标不能用 object-cover：非方形的队标会被裁成碎片`);
			imgs += 1;
		}
	}
	assert.equal(imgs, 7, '场次行两处、对阵页两处、战队卡、战队详情、赛事页各一处，共 7 处队标');
	ok('底板：五个文件、七张队标都用浅色底板且不裁切');
}

console.log(`teamLogos 全部断言通过（${cases} 组）`);
