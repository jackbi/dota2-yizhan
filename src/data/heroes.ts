import type { Hero } from './types';

/**
 * 英雄资料 —— 示例数据，覆盖三大属性与全能英雄。
 * 可替换为官方 datafeed（https://www.dota2.com/datafeed/herodata?language=schinese）。
 */
export const HEROES: Hero[] = [
	{ id: 'antimage', name: 'Anti-Mage', cn: '敌法师', attribute: 'AGI', attack: 'melee', roles: ['carry', 'escape'], complexity: 2 },
	{ id: 'axe', name: 'Axe', cn: '斧王', attribute: 'STR', attack: 'melee', roles: ['initiator', 'durable'], complexity: 1 },
	{ id: 'bane', name: 'Bane', cn: '祸乱之源', attribute: 'INT', attack: 'ranged', roles: ['disabler', 'support'], complexity: 2 },
	{ id: 'bloodseeker', name: 'Bloodseeker', cn: '血魔', attribute: 'AGI', attack: 'melee', roles: ['carry', 'nuker'], complexity: 2 },
	{ id: 'crystal_maiden', name: 'Crystal Maiden', cn: '水晶室女', attribute: 'INT', attack: 'ranged', roles: ['support', 'nuker'], complexity: 1 },
	{ id: 'drow_ranger', name: 'Drow Ranger', cn: '卓尔游侠', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'pusher'], complexity: 1 },
	{ id: 'earthshaker', name: 'Earthshaker', cn: '撼地者', attribute: 'STR', attack: 'melee', roles: ['initiator', 'disabler'], complexity: 2 },
	{ id: 'enigma', name: 'Enigma', cn: '谜团', attribute: 'UNI', attack: 'ranged', roles: ['initiator', 'jungler'], complexity: 2 },
	{ id: 'faceless_void', name: 'Faceless Void', cn: '虚空假面', attribute: 'AGI', attack: 'melee', roles: ['carry', 'escape'], complexity: 2 },
	{ id: 'gyrocopter', name: 'Gyrocopter', cn: '矮人直升机', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'nuker'], complexity: 2 },
	{ id: 'huskar', name: 'Huskar', cn: '哈斯卡', attribute: 'STR', attack: 'ranged', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'invoker', name: 'Invoker', cn: '祈求者', attribute: 'INT', attack: 'ranged', roles: ['nuker', 'disabler'], complexity: 3 },
	{ id: 'juggernaut', name: 'Juggernaut', cn: '主宰', attribute: 'AGI', attack: 'melee', roles: ['carry', 'pusher'], complexity: 1 },
	{ id: 'kunkka', name: 'Kunkka', cn: '昆卡', attribute: 'STR', attack: 'melee', roles: ['carry', 'initiator'], complexity: 2 },
	{ id: 'lich', name: 'Lich', cn: '巫妖', attribute: 'INT', attack: 'ranged', roles: ['support', 'nuker'], complexity: 1 },
	{ id: 'lina', name: 'Lina', cn: '莉娜', attribute: 'INT', attack: 'ranged', roles: ['nuker', 'carry'], complexity: 2 },
	{ id: 'lion', name: 'Lion', cn: '莱恩', attribute: 'INT', attack: 'ranged', roles: ['disabler', 'support'], complexity: 1 },
	{ id: 'luna', name: 'Luna', cn: '露娜', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'pusher'], complexity: 1 },
	{ id: 'mirana', name: 'Mirana', cn: '米拉娜', attribute: 'AGI', attack: 'ranged', roles: ['nuker', 'support'], complexity: 2 },
	{ id: 'morphling', name: 'Morphling', cn: '变体精灵', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'escape'], complexity: 3 },
	{ id: 'nevermore', name: 'Shadow Fiend', cn: '影魔', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'nuker'], complexity: 2 },
	{ id: 'phantom_assassin', name: 'Phantom Assassin', cn: '幻影刺客', attribute: 'AGI', attack: 'melee', roles: ['carry', 'escape'], complexity: 1 },
	{ id: 'phantom_lancer', name: 'Phantom Lancer', cn: '幻影长矛手', attribute: 'AGI', attack: 'melee', roles: ['carry', 'escape'], complexity: 1 },
	{ id: 'puck', name: 'Puck', cn: '帕克', attribute: 'INT', attack: 'ranged', roles: ['nuker', 'disabler'], complexity: 3 },
	{ id: 'pudge', name: 'Pudge', cn: '屠夫', attribute: 'STR', attack: 'melee', roles: ['disabler', 'initiator'], complexity: 2 },
	{ id: 'razor', name: 'Razor', cn: '剃刀', attribute: 'UNI', attack: 'ranged', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'riki', name: 'Riki', cn: '力丸', attribute: 'AGI', attack: 'melee', roles: ['escape', 'carry'], complexity: 2 },
	{ id: 'sand_king', name: 'Sand King', cn: '沙王', attribute: 'STR', attack: 'melee', roles: ['initiator', 'nuker'], complexity: 2 },
	{ id: 'skeleton_king', name: 'Wraith King', cn: '冥魂大帝', attribute: 'STR', attack: 'melee', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'storm_spirit', name: 'Storm Spirit', cn: '风暴之灵', attribute: 'INT', attack: 'ranged', roles: ['carry', 'nuker'], complexity: 3 },
	{ id: 'sven', name: 'Sven', cn: '斯温', attribute: 'STR', attack: 'melee', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'templar_assassin', name: 'Templar Assassin', cn: '圣堂刺客', attribute: 'AGI', attack: 'ranged', roles: ['carry', 'nuker'], complexity: 2 },
	{ id: 'tidehunter', name: 'Tidehunter', cn: '潮汐猎人', attribute: 'STR', attack: 'melee', roles: ['initiator', 'durable'], complexity: 1 },
	{ id: 'tiny', name: 'Tiny', cn: '小小', attribute: 'STR', attack: 'melee', roles: ['nuker', 'initiator'], complexity: 2 },
	{ id: 'vengefulspirit', name: 'Vengeful Spirit', cn: '复仇之魂', attribute: 'UNI', attack: 'ranged', roles: ['support', 'disabler'], complexity: 2 },
	{ id: 'windrunner', name: 'Windranger', cn: '风行者', attribute: 'INT', attack: 'ranged', roles: ['nuker', 'carry'], complexity: 2 },
	{ id: 'zuus', name: 'Zeus', cn: '宙斯', attribute: 'INT', attack: 'ranged', roles: ['nuker', 'carry'], complexity: 1 },
	{ id: 'lifestealer', name: 'Lifestealer', cn: '噬魂鬼', attribute: 'STR', attack: 'melee', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'slardar', name: 'Slardar', cn: '斯拉达', attribute: 'STR', attack: 'melee', roles: ['carry', 'initiator'], complexity: 1 },
	{ id: 'ursa', name: 'Ursa', cn: '熊战士', attribute: 'AGI', attack: 'melee', roles: ['carry', 'durable'], complexity: 1 },
	{ id: 'wisp', name: 'Io', cn: '艾欧', attribute: 'UNI', attack: 'ranged', roles: ['support', 'escape'], complexity: 3 },
	{ id: 'undying', name: 'Undying', cn: '不朽尸王', attribute: 'STR', attack: 'melee', roles: ['durable', 'support'], complexity: 1 },
	{ id: 'ogre_magi', name: 'Ogre Magi', cn: '食人魔魔法师', attribute: 'UNI', attack: 'melee', roles: ['support', 'nuker'], complexity: 1 },
	{ id: 'night_stalker', name: 'Night Stalker', cn: '暗夜魔王', attribute: 'STR', attack: 'melee', roles: ['carry', 'disabler'], complexity: 2 },
	{ id: 'mars', name: 'Mars', cn: '玛尔斯', attribute: 'STR', attack: 'melee', roles: ['initiator', 'durable'], complexity: 2 },
];

export const ATTRIBUTES = [
	{ id: 'STR', label: '力量', color: '#C0392B' },
	{ id: 'AGI', label: '敏捷', color: '#27AE60' },
	{ id: 'INT', label: '智力', color: '#2980B9' },
	{ id: 'UNI', label: '全能', color: '#E0A93F' },
] as const;

export const HERO_ROLES = ['carry', 'support', 'nuker', 'initiator', 'disabler', 'durable', 'escape', 'pusher', 'jungler'] as const;

export const ROLE_LABEL: Record<string, string> = {
	carry: '核心',
	support: '辅助',
	nuker: '爆发',
	initiator: '开团',
	disabler: '控制',
	durable: '肉盾',
	escape: '逃生',
	pusher: '推进',
	jungler: '打野',
};
