/**
 * MCP 工具的清单与实现。
 *
 * 每个工具的输出都是**给人看、也给模型读的文本**，数字一律带场次：这套数据里最容易出错的
 * 读法就是「看到 53% 就当结论」，而那些胜率背后可能只有两百场。工具描述里也写明这一点，
 * 让模型知道该照抄数字，不要自己推算。
 */

import { draftData, lanes, resolveTeamId, teamForm } from './data.mjs';
import { findHeroes, resolveHero } from './heroes.mjs';
import {
	CM_STEPS,
	advise,
	buildVerdict,
	matchupRate,
	otherSide,
} from './dist/engine.mjs';

// ---------------------------------------------------------------- 排版小工具

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const num = (value) => Number(value).toLocaleString('zh-CN');
const POSITION_LABEL = ['一', '二', '三', '四', '五'];
const positionLabel = (position) => `${POSITION_LABEL[position - 1] ?? position}号位`;

const ROLE_NAMES = ['核心', '辅助', '爆发', '控制', '打野', '耐久', '逃生', '推进', '先手'];

const ATTR_NAMES = { STR: '力量', AGI: '敏捷', INT: '智力', UNI: '全才' };

/**
 * 只做横向对比、不进胜率的那些行。
 *
 * 用于「胜率与结构打架」时的提醒：胜率只看号位偏差加对位偏差，一个四近战、没有团战点、
 * 还塞了三个纯核的阵容照样可能算出高胜率——单独看那个数字会得出完全错的结论。
 */
const STRUCTURE_KEYS = new Set([
	'control', 'burst', 'initiate', 'push', 'front', 'support',
	'ranged', 'teamfight', 'clear', 'phaseEarly', 'phaseLate', 'greedyCore', 'melee',
]);

/** 这一行离参考值差多远（按相对量算，越大越糟）。已经达标的返回 0，不参与提醒。 */
function shortfall(row, value) {
	if (row.target <= 0) return 0;
	return row.lowerIsBetter ? Math.max(0, (value - row.target) / row.target) : Math.max(0, (row.target - value) / row.target);
}

/** 一行口径说明。每个工具的输出结尾都带上它，模型才知道这批数字是什么时候的。 */
function caliber(data) {
	const patch = data.patch?.version ? `版本 ${data.patch.version}` : '版本未知';
	const straddle = data.patch?.straddles ? '（这 7 天里跨了一次版本更新，胜率是新旧混算的）' : '';
	return [
		`数据口径：${patch}${straddle} · 近 ${data.windowDays} 天 · ${data.bracketLabel}`,
		`每个号位至少 ${num(data.minPositionMatches)} 场 · 对位至少 ${num(data.matchupMinGames)} 场 · 抓取于 ${data.updatedAt}`,
	].join('\n');
}

function heroLine(hero) {
	const attr = ATTR_NAMES[hero.attr] ?? hero.attr;
	const attack = hero.attack === 'melee' ? '近战' : '远程';
	return `${hero.name}（${hero.nameEn}）id=${hero.id} · ${attr} · ${attack}`;
}

/** 线上对位是可选增强：拿不到就少一条依据，不该让整次调用失败。 */
async function tryLanes() {
	try {
		return await lanes();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- 工具实现

/** 把 hero 参数解析成 id 列表，并按输入顺序报告用了哪个名字。 */
function resolveIds(data, values) {
	return values.map((value) => {
		const { hero, via } = resolveHero(value, data);
		return { hero, via, input: value };
	});
}

async function searchHero({ query, limit = 5 }) {
	const data = await draftData();
	const { matches, via, note } = findHeroes(query, data, limit);
	if (matches.length === 0) {
		return `没找到叫「${query}」的英雄${note ? `（${note}）` : ''}。\n换官方中文名（灰烬之灵）、英文名（Ember Spirit）或常见俗称（火猫）再试。`;
	}
	const lines = matches.map(
		(row, index) => `${index + 1}. ${heroLine(row.hero)} · 命中方式：${row.via}`,
	);
	return [`按「${query}」找到 ${matches.length} 个英雄（命中方式：${via}）：`, ...lines].join('\n');
}

async function getHeroStats({ hero: heroQuery }) {
	const data = await draftData();
	const { hero, via } = resolveHero(heroQuery, data);

	const roles = hero.roles
		.map((level, index) => ({ name: ROLE_NAMES[index], level }))
		.filter((row) => row.level > 0)
		.sort((a, b) => b.level - a.level)
		.map((row) => `${row.name}${row.level}`)
		.join(' · ');

	const traits = [
		`召唤/幻象 ${hero.summon ? '有' : '无'}`,
		`范围清兵 ${hero.aoe ? '有' : '无'}`,
		`团战点 ${hero.teamfight ? '有' : '无'}`,
	].join(' · ');

	const positionRows = hero.positions
		.map((cell, index) =>
			cell
				? `${positionLabel(index + 1)} ${num(cell[0])} 场 · 胜率 ${pct(cell[1] / cell[0])}`
				: `${positionLabel(index + 1)} 样本不足`,
		)
		.filter(Boolean);

	const [proPicks, proWins, proBans] = hero.pro;
	const proLine =
		proPicks > 0
			? `职业样本：出场 ${num(proPicks)}（胜 ${num(proWins)}）· 被禁 ${num(proBans)}`
			: '职业样本：这周没有';

	const timeline =
		hero.timeline?.[0] > 0
			? `时间曲线：5 分钟 ${pct(hero.timeline[0])} → 35 分钟 ${pct(hero.timeline[1])}`
			: '时间曲线：拿不到';

	return [
		heroLine(hero),
		`命中方式：${via}`,
		`官方定位：${roles || '没有数据'}`,
		`特征：${traits}`,
		timeline,
		'',
		'各号位胜率（按场次门槛留存）：',
		...positionRows.map((row) => `- ${row}`),
		'',
		proLine,
		caliber(data),
	].join('\n');
}

async function getMatchup({ hero: heroQuery, vs, limit = 8 }) {
	const data = await draftData();
	const { hero } = resolveHero(heroQuery, data);

	if (vs?.length) {
		const rows = vs.map((name) => {
			const { hero: foe } = resolveHero(name, data);
			const cell = matchupRate(data.matchups, hero.id, foe.id);
			const text = cell
				? `${hero.name} 打 ${foe.name}：${pct(cell.rate)}（${num(cell.games)} 场）`
				: `${hero.name} 打 ${foe.name}：没有留存的对位（样本没过 ${num(data.matchupMinGames)} 场，或这一对没抓到）`;
			return `- ${text}`;
		});
		return [`${hero.name} 的指定对位：`, ...rows, '', caliber(data)].join('\n');
	}

	// 不带对手时，把整张表里这个英雄的对位全算一遍，取最好与最差两端。
	const all = [];
	for (const foe of data.heroes) {
		if (foe.id === hero.id) continue;
		const cell = matchupRate(data.matchups, hero.id, foe.id);
		if (cell) all.push({ foe, ...cell });
	}
	if (all.length === 0) {
		return `${hero.name} 这次没有可用的对位数据（门槛 ${num(data.matchupMinGames)} 场）。\n${caliber(data)}`;
	}
	all.sort((a, b) => b.rate - a.rate);
	const top = all.slice(0, limit);
	const bottom = all.slice(-limit).reverse();

	return [
		`${hero.name} 的对位（共 ${num(all.length)} 个对手过了门槛）：`,
		'',
		'最好打：',
		...top.map((row) => `- 打 ${row.foe.name} ${pct(row.rate)}（${num(row.games)} 场）`),
		'',
		'最难打：',
		...bottom.map((row) => `- 打 ${row.foe.name} ${pct(row.rate)}（${num(row.games)} 场）`),
		'',
		'注：这是整局的对位（谁克谁），不分路。线上谁打谁、和谁走一路要看另一份数据，会出现在 analyze_lineup 的结果里。',
		caliber(data),
	].join('\n');
}

async function analyzeLineup({ radiant, dire, firstPicker = 'radiant' }) {
	const data = await draftData();
	if (radiant?.length !== 5 || dire?.length !== 5) {
		throw new Error(`两边各要 5 个英雄（现在收到天辉 ${radiant?.length ?? 0} 个、夜魇 ${dire?.length ?? 0} 个）。`);
	}
	const ourRows = resolveIds(data, radiant);
	const theirRows = resolveIds(data, dire);
	const laneData = await tryLanes();

	const verdict = buildVerdict({
		data,
		ourIds: ourRows.map((row) => row.hero.id),
		theirIds: theirRows.map((row) => row.hero.id),
		ourSide: 'radiant',
		selfTeam: '天辉',
		foeTeam: '夜魇',
		lanes: laneData,
	});
	if (!verdict) throw new Error('这套阵容算不出对比结果，检查一下是不是有重复英雄。');

	const rowLines = verdict.rows.map((row) => {
		const mark = row.better === 'ours' ? '天辉优' : row.better === 'theirs' ? '夜魇优' : '持平';
		return `- ${row.label} ${row.text.replace(`${row.label} `, '')} → ${mark}`;
	});

	const laneLines = verdict.laneEdges.map((edge) => {
		const opponents = edge.opponents
			.slice(0, 2)
			.map((row) => `${row.hero.name}(${row.net >= 0 ? '+' : ''}${(row.net * 100).toFixed(1)}%)`)
			.join('、');
		return `- ${edge.side === 'ours' ? '天辉' : '夜魇'} ${positionLabel(edge.position)} ${edge.hero.name} 线上遇 ${opponents}`;
	});

	/*
	 * 胜率与结构打架时说清楚。
	 *
	 * 胜率 = 50% + 号位偏差 + 对位偏差，**不含**团战点、清场、近战数、纯核数这些结构项。
	 * 实测过一套阵容：四个近战、团战点 0、清场 0、三个纯核，胜率照样算出 76.5%。
	 * 只把那个数字递给模型，它就会理直气壮地说这套阵容很强。
	 */
	const rateEdge = verdict.winRate.ours - 0.5;
	const favored = rateEdge >= 0 ? '天辉' : '夜魇';
	const structureRow = verdict.rows.find((row) => row.key === 'structure');
	const gaps = [];
	if (Math.abs(rateEdge) > 0.05 && structureRow) {
		for (const row of verdict.rows) {
			if (!STRUCTURE_KEYS.has(row.key)) continue;
			// 只看「被胜率看好的那一边反而更差」的项，方向一致就不用提醒。
			const [favoredValue, otherValue] = rateEdge >= 0 ? [row.ours, row.theirs] : [row.theirs, row.ours];
			const gap = shortfall(row, favoredValue);
			if (gap <= 0) continue;
			gaps.push({ row, favoredValue, otherValue, gap });
		}
		gaps.sort((a, b) => b.gap - a.gap);
	}
	const structureWarning =
		gaps.length > 0
			? [
					`注意：${favored}的胜率占优，但同一份数据里它的结构项明显不达标：`,
					gaps
						.slice(0, 6)
						.map((item) => `${item.row.label} ${item.favoredValue} : ${item.otherValue}（参考 ${item.row.target}）`)
						.join('、'),
					`。结构分 ${structureRow.ours.toFixed(2)} : ${structureRow.theirs.toFixed(2)}（参考 ${structureRow.target}）。`,
					'胜率只由号位偏差与对位偏差相加，不包含上面这些结构项，所以两者可以完全相反。',
					'回答时要把这组矛盾一起讲出来，不要只念胜率。',
			].join('')
			: '';

	return [
		`天辉胜率 ${pct(verdict.winRate.ours)} ｜ 夜魇 ${pct(verdict.winRate.theirs)}`,
		`胜率 = 50% + 号位偏差 ${(verdict.edge.position * 100).toFixed(1)}% + 对位偏差 ${(verdict.edge.counter * 100).toFixed(1)}%`,
		'（这两项都是实测胜率；下面的结构分与时间曲线只做横向对比，没有算进胜率。）',
		...(structureWarning ? ['', structureWarning] : []),
		'',
		`天辉：${ourRows.map((row) => row.hero.name).join('、')}`,
		`夜魇：${theirRows.map((row) => row.hero.name).join('、')}`,
		'',
		'维度对比（天辉 : 夜魇）：',
		...rowLines,
		...(laneLines.length ? ['', '线上对位：', ...laneLines] : []),
		...(verdict.notes.length ? ['', '需要说明的：', ...verdict.notes.map((note) => `- ${note}`)] : []),
		'',
		caliber(data),
	].join('\n');
}

/**
 * 把「双方已经拿到哪些英雄」还原成 24 手记录。
 *
 * 顺序表是固定的（`CM_STEPS`），所以只要按顺序把两边各自的 ban / pick 依次填进去就行：
 * 填到某一手时那一方没有剩下的英雄，说明 BP 就停在这里，那就是当前手号。
 *
 * 填完之后如果还有英雄没排进去，说明输入和顺序对不上（比如先选方在首抢之前就给了两个 pick），
 * 这种情况**报错而不是猜**——猜错会让后面所有建议都建立在错误的手号上。
 */
export function reconstructRecord({ ourSide, firstPicker, ourBans, ourPicks, theirBans, theirPicks }) {
	const theirs = otherSide(ourSide);
	const queue = {
		[ourSide]: { ban: [...ourBans], pick: [...ourPicks] },
		[theirs]: { ban: [...theirBans], pick: [...theirPicks] },
	};

	const recorded = [];
	for (const step of CM_STEPS) {
		const side = step.owner === 'first' ? firstPicker : otherSide(firstPicker);
		const pending = queue[side][step.action];
		if (pending.length === 0) break;
		recorded.push(pending.shift());
	}

	const leftover = [];
	for (const side of [ourSide, theirs]) {
		for (const action of ['ban', 'pick']) {
			for (const heroId of queue[side][action]) {
				leftover.push({ side: side === ourSide ? '我方' : '对方', action: action === 'ban' ? '禁用' : '挑选', heroId });
			}
		}
	}
	return { recorded, leftover };
}

async function suggestPick({ ourSide, firstPicker, ourPicks = [], theirPicks = [], ourBans = [], theirBans = [], foeTeam, limit = 3 }) {
	const data = await draftData();
	if (ourSide !== 'radiant' && ourSide !== 'dire') throw new Error('ourSide 只能是 radiant 或 dire。');
	if (firstPicker !== 'radiant' && firstPicker !== 'dire') throw new Error('firstPicker 只能是 radiant 或 dire。');

	const toIds = (values) => resolveIds(data, values).map((row) => row.hero.id);
	const ourPickIds = toIds(ourPicks);
	const theirPickIds = toIds(theirPicks);
	const ourBanIds = toIds(ourBans);
	const theirBanIds = toIds(theirBans);

	const { recorded, leftover } = reconstructRecord({
		ourSide,
		firstPicker,
		ourBans: ourBanIds,
		ourPicks: ourPickIds,
		theirBans: theirBanIds,
		theirPicks: theirPickIds,
	});
	const byId = new Map(data.heroes.map((hero) => [hero.id, hero]));
	const nameOf = (id) => byId.get(id)?.name ?? `英雄 id=${id}`;
	if (leftover.length > 0) {
		/*
		 * 报错要能让模型自己改对：把「排到第几手、那一手之前两边各该有几个 ban / pick」写出来。
		 * 只说「对不上」的话，模型多半会把同一份输入再原样试一遍。
		 */
		const ourOwner = firstPicker === ourSide ? 'first' : 'second';
		const upTo = recorded.length + 1;
		const countAt = (owner, action) =>
			CM_STEPS.slice(0, upTo).filter((step) => step.owner === owner && step.action === action).length;
		const ownerName = (owner) => (owner === ourOwner ? '我方' : '对方');
		const expected = [
			`${ownerName('first')}（先选方）${countAt('first', 'ban')} 禁 ${countAt('first', 'pick')} 选`,
			`${ownerName('second')}（后选方）${countAt('second', 'ban')} 禁 ${countAt('second', 'pick')} 选`,
		].join('、');
		const detail = leftover
			.map((row) => `${row.side}多出的${row.action}：${nameOf(row.heroId)}`)
			.join('、');
		throw new Error(
			[
				`给出的英雄与队长模式的顺序排不下去：按顺序排到第 ${upTo} 手时，${detail}。`,
				`排到这一手时，双方最多只能有 ${expected}（${firstPicker === 'radiant' ? '天辉' : '夜魇'}先选）。`,
				'请核对 firstPicker 是不是给反了，以及各边的 ban / pick 数量与游戏里是否一致。',
			].join(''),
		);
	}

	// 对面近期偏好：填了队名才取，取不到不影响建议。
	let foeForm = null;
	let foeNote = '';
	if (foeTeam) {
		try {
			const teamId = await resolveTeamId(foeTeam);
			if (teamId === null) {
				foeNote = `没查到「${foeTeam}」这支队伍，这一手不带「对面擅长什么」。`;
			} else {
				const payload = await teamForm(teamId);
				if (payload?.ok) foeForm = payload.form;
				else foeNote = `「${foeTeam}」的近期偏好取不到（${payload?.reason ?? '未知原因'}）。`;
			}
		} catch (error) {
			foeNote = `「${foeTeam}」的近期偏好取不到（${error.message}）。`;
		}
	}

	const laneData = await tryLanes();
	const advice = advise({
		data,
		recorded,
		ourSide,
		firstPicker,
		limit,
		foeForm,
		lanes: laneData,
	});
	if (!advice) throw new Error('这一手算不出建议，可能 BP 已经录满了（24 手）。');

	const candidateBlock = (rows) =>
		rows.map((row, index) => {
			const head = `${index + 1}. ${nameOf(row.heroId)} 打 ${positionLabel(row.position)} · 该号位胜率 ${pct(row.rate)}${row.hasSample ? '' : '（这个号位没有采样，按 50% 处理）'}`;
			const reasons = row.reasons.map((reason) => `   - ${reason}`);
			return [head, ...reasons, `   - 风险：${row.risk}`].join('\n');
		});

	const ownerText = advice.owner === 'first' ? '先选方' : '后选方';
	const tailBan = advice.tail.ban === 'ours' ? '我方' : '对面';
	const tailPick = advice.tail.pick === 'ours' ? '我方' : '对面';

	return [
		`第 ${advice.step} 手 · ${ownerText} ${advice.action === 'ban' ? '禁用' : '挑选'}${advice.ours ? '（我方）' : '（对面）'}`,
		`我方还剩 ${advice.remaining.ours.bans} 禁 ${advice.remaining.ours.picks} 选 · 对面还剩 ${advice.remaining.theirs.bans} 禁 ${advice.remaining.theirs.picks} 选`,
		`最后一手禁用归${tailBan}、最后一手挑选归${tailPick}`,
		'',
		advice.ours ? '轮到我方，候选：' : '轮到对面（可以替对面落子，看看它会拿什么）：',
		...candidateBlock(advice.candidates),
		...(advice.foeCandidates.length
			? ['', '对面近期真的在拿、但没进上面候选的：', ...candidateBlock(advice.foeCandidates.slice(0, 3))]
			: []),
		'',
		`阵容现状：${advice.composition.text}`,
		...(advice.composition.enemySummon ? ['对面有召唤/幻象体系，清幻象与清兵能力要单独算一项。'] : []),
		'',
		`一句话：${advice.summary}`,
		...(foeNote ? ['', foeNote] : []),
		'',
		caliber(data),
	].join('\n');
}

// ---------------------------------------------------------------- 清单

/** 统一的一句提醒：这些数字是实测的，别让模型自己再算一遍。 */
const HONESTY = '输出里的胜率与场次都来自本站实测数据，请原样引用，不要自己推算或补充你没看到过的数字。';

export const TOOLS = [
	{
		name: 'search_hero',
		description: `把英雄名解析成英雄 id。支持官方中文名、英文名、常见俗称（火猫、AM、剑圣）与数字 id。\n其他工具都接受名字，所以一般不用先调它；拿不准名字怎么写、或者要确认是哪一个人的时候用它。${HONESTY}`,
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '英雄名、俗称或 id' },
				limit: { type: 'integer', description: '最多返回几个，默认 5' },
			},
			required: ['query'],
		},
		run: searchHero,
	},
	{
		name: 'get_hero_stats',
		description: `查一个英雄当前版本的实测数据：各号位胜率与场次、职业样本的出场与被禁、官方定位等级、近战/远程、有没有召唤与团战能力、5 到 35 分钟的时间曲线。\n用于回答「这英雄现在强不强」「它适合打几号位」这类问题。${HONESTY}`,
		inputSchema: {
			type: 'object',
			properties: {
				hero: { type: 'string', description: '英雄名、俗称或 id' },
			},
			required: ['hero'],
		},
		run: getHeroStats,
	},
	{
		name: 'get_matchup',
		description: `查英雄对位（谁克谁）。不带 vs 时给出这个英雄最好打与最难打的对手；带上 vs 时只报指定那几个对手的胜率。\n这是整局口径的对位，不分路。每条的场次都会列出来，样本小的要照实说明。${HONESTY}`,
		inputSchema: {
			type: 'object',
			properties: {
				hero: { type: 'string', description: '英雄名、俗称或 id' },
				vs: { type: 'array', items: { type: 'string' }, description: '可选。指定要查的对手，不填就返回两端' },
				limit: { type: 'integer', description: '两端各返回几个，默认 8' },
			},
			required: ['hero'],
		},
		run: getMatchup,
	},
	{
		name: 'analyze_lineup',
		description: `双方各五个英雄的阵容分析：胜率、16 行维度对比（号位胜率、对位、控制/爆发/先手/上高/前排/辅助、近战数、纯核数、时间曲线…）、线上谁打谁。\n胜率只由实测的号位偏差与对位偏差相加；结构分与时间曲线只做横向对比、不含在胜率里。回答时必须把这条口径讲清楚，不要把它说成「模型预测的胜率」。${HONESTY}`,
		inputSchema: {
			type: 'object',
			properties: {
				radiant: { type: 'array', items: { type: 'string' }, description: '天辉五个英雄' },
				dire: { type: 'array', items: { type: 'string' }, description: '夜魇五个英雄' },
				firstPicker: { type: 'string', enum: ['radiant', 'dire'], description: '谁先选，默认 radiant' },
			},
			required: ['radiant', 'dire'],
		},
		run: analyzeLineup,
	},
	{
		name: 'suggest_pick',
		description: `BP 陪练：给出当前已经拿到的英雄，返回这一手该禁谁或该选谁，每个候选都带理由（号位胜率、对位、线上对位、对面熟手）与风险。\n不用自己排 24 手的顺序，只要给双方已有的 ban / pick，服务端会按队长模式的固定顺序反推现在轮到第几手。填了 foeTeam 会额外带上对面近期的英雄偏好。\n建议排序是本地算出来的，不是模型拍的；请把理由里的数字原样引用。${HONESTY}`,
		inputSchema: {
			type: 'object',
			properties: {
				ourSide: { type: 'string', enum: ['radiant', 'dire'], description: '我方是哪个阵营' },
				firstPicker: { type: 'string', enum: ['radiant', 'dire'], description: '谁先选' },
				ourPicks: { type: 'array', items: { type: 'string' }, description: '我方已经拿到的英雄' },
				theirPicks: { type: 'array', items: { type: 'string' }, description: '对方已经拿到的英雄' },
				ourBans: { type: 'array', items: { type: 'string' }, description: '我方已经禁的英雄' },
				theirBans: { type: 'array', items: { type: 'string' }, description: '对方已经禁的英雄' },
				foeTeam: { type: 'string', description: '可选。对面队名，填了就带上他们近期的英雄偏好' },
				limit: { type: 'integer', description: '返回几个候选，默认 3' },
			},
			required: ['ourSide', 'firstPicker'],
		},
		run: suggestPick,
	},
];

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));
