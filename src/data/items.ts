import type { Item } from './types';

/** 装备资料 —— 示例数据。可替换为官方 datafeed（/datafeed/itemdata?language=schinese）。 */
export const ITEMS: Item[] = [
	{ id: 'blink', name: 'Blink Dagger', cn: '闪烁匕首', type: 'utility', cost: 2250, active: true, components: ['闪烁匕首配方'], short: '主动瞬移，核心先手神器。' },
	{ id: 'bkb', name: 'Black King Bar', cn: '黑皇杖', type: 'utility', cost: 4050, active: true, components: ['奥术法杖', '黑皇杖卷轴'], short: '主动获得法术免疫，后期团战保命。' },
	{ id: 'butterfly', name: 'Butterfly', cn: '蝴蝶', type: 'carry', cost: 4975, active: false, components: ['鹰歌弓', '闪避护符', '卷轴'], short: '敏捷 + 闪避，远程核心神装。' },
	{ id: 'satanic', name: 'Satanic', cn: '撒旦之邪力', type: 'carry', cost: 5100, active: true, components: ['大剑', 'morbid mask', '卷轴'], short: '主动吸血，大幅提升生存与续航。' },
	{ id: 'aeon', name: 'Aeon Disk', cn: '永恒法盘', type: 'utility', cost: 2575, active: false, components: ['能量之球', '卷轴'], short: '受到高额伤害时获得护盾，辅助保命。' },
	{ id: 'mekansm', name: 'Mekansm', cn: '梅肯斯姆', type: 'support', cost: 1775, active: true, components: ['相-之球', '治疗指环', '卷轴'], short: '团队治疗，中前期团战关键。' },
	{ id: 'glimmer', name: 'Glimmer Cape', cn: '微光披风', type: 'support', cost: 2150, active: true, components: ['暗影斗篷', '抗魔斗篷', '卷轴'], short: '利用魔法免疫逃命或保队友。' },
	{ id: 'orchid', name: 'Orchid Malevolence', cn: '邪恶之心', type: 'caster', cost: 2725, active: true, components: ['空明杖', '法师长袍', '卷轴'], short: '主动沉默，克制高爆发法师。' },
	{ id: 'sheepstick', name: 'Scythe of Vyse', cn: '邪恶镰刀', type: 'caster', cost: 5675, active: true, components: ['神秘法杖', '空明杖', '卷轴'], short: '主动变形控制，后期团战定海神针。' },
	{ id: 'force', name: 'Force Staff', cn: '原力法杖', type: 'support', cost: 2250, active: true, components: ['空明杖', '卷轴'], short: '主动位移，救人或逃生。' },
	{ id: 'power_treads', name: 'Power Treads', cn: '动力鞋', type: 'boots', cost: 1400, active: true, components: ['速度之靴', '三套属性件'], short: '属性切换鞋，适用面最广。' },
	{ id: 'phase', name: 'Phase Boots', cn: '相位鞋', type: 'boots', cost: 1400, active: true, components: ['速度之靴', '相位', '卷轴'], short: '主动相位移动，追击与穿透。' },
	{ id: 'guardian', name: 'Arcane Boots', cn: '奥术之靴', type: 'boots', cost: 1300, active: true, components: ['速度之靴', '能量之球'], short: '主动回蓝，辅助续航。' },
	{ id: 'tranquils', name: 'Tranquil Boots', cn: '秘法之靴', type: 'boots', cost: 1150, active: false, components: ['速度之靴', '守护指环'], short: '回复巨量移动速度与生命，辅助首选。' },
	{ id: 'heavens', name: 'Heaven\'s Halberd', cn: '天堂之戟', type: 'offlane', cost: 3350, active: true, components: ['奥术战刃', '锁魂锤', '卷轴'], short: '缴械近战核心，克制物理输出。' },
	{ id: 'pipe', name: 'Pipe of Insight', cn: '洞察之杖', type: 'offlane', cost: 3525, active: true, components: ['流浪之杖', '卷轴'], short: '团队魔抗护盾，针对法系阵容。' },
];

export const ITEM_TYPES = [
	{ id: 'carry', label: '核心装' },
	{ id: 'support', label: '辅助装' },
	{ id: 'caster', label: '法师装' },
	{ id: 'utility', label: '功能性' },
	{ id: 'offlane', label: '三号位' },
	{ id: 'boots', label: '鞋类' },
	{ id: 'neutral', label: '中立' },
] as const;
