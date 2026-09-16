import assert from 'node:assert/strict';
import {
	groupByMajor,
	hasPatchContent,
	referencedEntities,
	renderPatchNotes,
	sanitizeNote,
	summarizePatch,
	type PatchNames,
	type PatchNotes,
} from '../src/lib/patchNotes.ts';

/**
 * 更新日志渲染的自检。
 *
 * 这份 HTML 是拿第三方字符串拼出来、再走 `set:html` 注进页面的，所以两条底线
 * 都要钉住：**认不出的标签必须落成文本**（不能从数据里带出可执行的东西），
 * **认得出的标签必须原样保留**（否则官方标注的重点色、加粗全没了）。
 * 渲染结构同理：空板块不能输出，否则老版本页面会出现一堆空标题。
 */

// --- 消毒：白名单内的标签保留 ---
assert.equal(sanitizeNote('普通文本'), '普通文本');
assert.equal(sanitizeNote('<b>重点</b>'), '<b>重点</b>');
assert.equal(sanitizeNote('<strong>重点</strong>'), '<b>重点</b>', 'strong 收成 b，闭合才对得上');
assert.equal(sanitizeNote('a<br>b'), 'a<br>b');
assert.equal(sanitizeNote('<BR />'), '<br>');
assert.equal(sanitizeNote("<font color='#e03e2e'>红</font>"), '<span style="color:#e03e2e">红</span>');
assert.equal(sanitizeNote('<font color="#7CA1CC">蓝</font>'), '<span style="color:#7CA1CC">蓝</span>');
assert.equal(sanitizeNote('<font>无颜色</font>'), '<span>无颜色</span>');

// --- 消毒：属性里的颜色只认十六进制 ---
assert.equal(sanitizeNote('<font color="red">x</font>'), '<span>x</span>', '颜色名不在白名单');
assert.equal(
	sanitizeNote('<font color="red;background:url(javascript:alert(1))">x</font>'),
	'<span>x</span>',
);
assert.equal(sanitizeNote('<font color=#abc>x</font>'), '<span style="color:#abc">x</span>');

// --- 消毒：官方那两种 span 换成自己的 class，其他 span 整个丢掉 ---
assert.equal(
	sanitizeNote('<span class="Subtitle">地图改动</span>'),
	'<span class="pn-inline-title">地图改动</span>',
);
assert.equal(sanitizeNote('<span class="New">全新物品</span>'), '<span class="pn-new">全新物品</span>');
assert.equal(sanitizeNote('<span class="Evil">x</span>'), 'x', '匿名 span 不留标签也不留孤立的 </span>');

// --- 消毒：其余标签一律丢掉（连属性），正文留下 ---
assert.equal(sanitizeNote('<script>alert(1)</script>'), 'alert(1)');
assert.equal(sanitizeNote('<img src=x onerror=alert(1)>'), '');
assert.equal(sanitizeNote('<a href="/x">链接</a>'), '链接');
assert.equal(sanitizeNote('</div>'), '', '没有对应开放标签的闭合标签直接丢掉');
// 标签被丢掉时属性也不能漏成文本，否则页面里会出现半截 `onerror=` 这样的垃圾。
assert.equal(sanitizeNote('<img src=x onerror=alert(1)>').includes('onerror'), false);
assert.equal(sanitizeNote('<a onclick="x()">y</a>').includes('onclick'), false);

// --- 消毒：实体与裸 & ---
assert.equal(sanitizeNote('攻速 &nbsp;+10'), '攻速 &nbsp;+10');
assert.equal(sanitizeNote('A & B'), 'A &amp; B');
assert.equal(sanitizeNote('伤害 < 100'), '伤害 &lt; 100');

// --- 消毒：写坏的标签也要能收尾 ---
assert.equal(sanitizeNote('<b>没闭合'), '<b>没闭合</b>');
assert.equal(sanitizeNote('</span><b>x'), '<b>x</b>', '孤立闭合标签不该把后面的标签也带歪');

// ---------------------------------------------------------------- 渲染

const names: PatchNames = {
	heroes: new Map([
		[1, { key: 'antimage', name: '敌法师' }],
		[3, { key: 'bane', name: '祸乱之源' }],
		[1961, { key: '', name: '熊灵' }],
	]),
	items: new Map([
		[141, { key: 'greater_crit', name: '代达罗斯之殇' }],
		[236, { key: 'dragon_lance', name: '魔龙枪' }],
	]),
	abilities: new Map([
		[5003, { key: 'antimage_mana_break', name: '法力损毁' }],
		[543, { key: 'antimage_mana_overload', name: '' }],
	]),
};

const notes: PatchNotes = {
	patch_number: '7.41f',
	general_notes: [{ title: '全局改动', generic: [{ indent_level: 1, note: '这次是真的<b>大改</b>' }] }],
	items: [
		{ ability_id: -1, title: '商店调整', is_general_note: true, ability_notes: [{ indent_level: 1, note: '重排了' }] },
		{ ability_id: 141, ability_notes: [{ indent_level: 1, note: '图纸涨价', info: '含总价' }] },
		{
			ability_id: 236,
			ability_notes: [
				{ indent_level: 2, note: '图纸售价从450金增加至550金' },
				{ indent_level: 1, note: '顺带一提', hide_dot: true },
				{ indent_level: 1, note: '<br>', hide_dot: true },
			],
		},
	],
	neutral_items: [{ ability_id: 1593, ability_notes: [{ indent_level: 1, note: '中立改动' }] }],
	neutral_creeps: [{ name: 'npc_dota_neutral_kobold', localized_name: '狗头人', neutral_creep_notes: [{ indent_level: 1, note: '攻击力提升' }] }],
	heroes: [
		{
			hero_id: 1,
			abilities: [{ ability_id: 5003, ability_notes: [{ indent_level: 1, note: '损毁魔法值的伤害系数提升', aghanims: 'scepter' }] }],
			talent_notes: [{ indent_level: 1, note: '10级天赋加强' }],
		},
		{
			hero_id: 3,
			subsections: [
				{
					title: '变形',
					style: 'hero_facet ReworkedFacet',
					general_notes: [{ indent_level: 1, note: '重做了' }],
				},
			],
		},
		{ hero_id: 1961, hero_notes: [{ indent_level: 1, note: '熊灵改动' }] },
	],
};

const icons = new Map([
	['hero:antimage', '/patch-heroes/hero-antimage-1234.jpg'],
	['item:greater_crit', '/patch-items/item-greater_crit-5678.jpg'],
]);

const html = renderPatchNotes(notes, names, icons);

// --- 名字解析：id 要落到中文名上，图标只在拿得到时才渲染 ---
assert.match(html, /敌法师/);
assert.match(html, /法力损毁/);
assert.match(html, /代达罗斯之殇/);
assert.match(html, /魔龙枪/);
assert.match(html, /狗头人/, '中立生物用 localized_name');
assert.match(html, /熊灵/, '名字表里没有的英雄用补的别名');
assert.match(html, /src="\/patch-heroes\/hero-antimage-1234\.jpg"/);
assert.match(html, /src="\/patch-items\/item-greater_crit-5678\.jpg"/);
// 四个条目拿不到图标（祸乱之源、熊灵、魔龙枪、中立生物），它们都该退化成占位方块而不是破图。
assert.equal((html.match(/pn-icon-empty/g) ?? []).length, 4);
assert.equal(html.includes('src=""'), false);

// --- 空能力名不该冒出一段空标题 ---
assert.equal(html.includes('pn-ability-name"></div>'), false);

// --- 结构：分组、缩进、隐藏圆点、i 说明、神杖标记、命石徽标 ---
assert.match(html, /pn-group">全局改动</);
assert.match(html, /pn-group">技能</);
assert.match(html, /pn-group">天赋</);
assert.match(html, /--pn-indent:0/);
assert.match(html, /--pn-indent:1/, 'indent_level 2 变成第二档缩进');
assert.match(html, /pn-line pn-nodot/);
assert.match(html, /pn-line pn-blank/);
assert.match(html, /pn-info">含总价</);
assert.match(html, /pn-tag">神杖</);
assert.match(html, /pn-badge">重做命石</);
assert.match(html, /<b>大改<\/b>/, '白名单标签在渲染后依然保留');

// --- 空板块不输出：老版本常常只有英雄改动 ---
const heroesOnly = renderPatchNotes(
	{ patch_number: '7.08', heroes: [{ hero_id: 1, hero_notes: [{ indent_level: 1, note: 'x' }] }] },
	names,
	new Map(),
);
assert.equal(heroesOnly.includes('物品'), false);
assert.equal(heroesOnly.includes('中立物品'), false);
assert.equal(heroesOnly.includes('全局改动'), false);
assert.match(heroesOnly, /英雄/);
assert.equal(renderPatchNotes({ patch_number: '7.08' }, names, new Map()), '<div class="patch-notes"></div>');

// --- 有没有正文：7.23 / 7.28 那种只有专题站链接的空壳 ----
assert.equal(hasPatchContent(notes), true);
assert.equal(hasPatchContent({ patch_number: '7.23', patch_website: 'outlanders' }), false);
assert.equal(
	hasPatchContent({ patch_number: '7.23', general_notes: [{ title: 'x', generic: [] }] }),
	false,
	'只有空分组也算没正文',
);
assert.equal(hasPatchContent({ patch_number: 'x', heroes: [{ hero_id: 1 }] }), true, '有一个英雄条目就算有正文');

// ---------------------------------------------------------------- 摘要与分组

assert.equal(
	summarizePatch(notes),
	'3 名英雄 · 2 件物品 · 1 件中立物品 · 1 条通用改动',
	'分组说明（ability_id: -1）不算进物品数',
);
assert.equal(summarizePatch({ patch_number: '7.08' }), '小幅调整');

const refs = referencedEntities(notes, names);
assert.deepEqual(
	refs.heroes.map((h) => h.name),
	['敌法师', '祸乱之源', '熊灵'],
);
assert.deepEqual(
	refs.items.map((i) => i.name),
	['代达罗斯之殇', '魔龙枪'],
	'分组说明和中立物品里查不到 id 的条目都不进图标清单',
);

const list = [
	{ major: '7.41', version: '7.41f' },
	{ major: '7.41', version: '7.41' },
	{ major: '7.40', version: '7.40c' },
];
const groups = groupByMajor(list);
assert.deepEqual(groups.map((g) => g.major), ['7.41', '7.40'], '按首次出现的顺序，不重排');
assert.deepEqual(groups[0].items.map((i) => i.version), ['7.41f', '7.41']);
assert.deepEqual(groupByMajor([]), []);

console.log('patchNotes 全部断言通过');
