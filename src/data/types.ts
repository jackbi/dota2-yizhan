export type Platform = 'douyu' | 'huya' | 'bilibili' | 'youtube';

export interface Streamer {
	id: string;
	name: string;
	alias: string;
	platform: Platform;
	roomId: string;
	embedUrl: string;
	avatar?: string;
	tag: string;
	live: boolean;
	viewers: number;
	description: string;
}

export interface NewsItem {
	id: string;
	title: string;
	summary: string;
	source: string;
	category: 'news' | 'rumor';
	date: string;
	tag: string;
	readTime: string;
	featured?: boolean;
}

export interface Tournament {
	id: string;
	name: string;
	region: string;
	start: string;
	end: string;
	prize: string;
	teams: number;
	status: 'live' | 'upcoming' | 'completed';
	format: string;
	premium?: boolean;
}

export interface Patch {
	id: string;
	version: string;
	title: string;
	date: string;
	kind: 'major' | 'balance' | 'minor';
	summary: string;
	highlights: string[];
}

export type Attribute = 'STR' | 'AGI' | 'INT' | 'UNI';
export type Attack = 'melee' | 'ranged';

export interface Hero {
	id: string;
	name: string;
	cn: string;
	attribute: Attribute;
	attack: Attack;
	roles: string[];
	complexity: 1 | 2 | 3;
}

export type ItemType =
	| 'carry'
	| 'support'
	| 'caster'
	| 'utility'
	| 'offlane'
	| 'boots'
	| 'neutral';

export interface Item {
	id: string;
	name: string;
	cn: string;
	type: ItemType;
	cost: number;
	active: boolean;
	components: string[];
	short: string;
}
