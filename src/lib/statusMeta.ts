import type { MatchStatus } from '../data/types';

export interface StatusMeta {
	label: string;
	cls: string;
	/** 是否显示呼吸圆点（仅进行中）。 */
	dot?: boolean;
}

/**
 * 单场比赛的状态展示。
 * 与赛事状态分开：同一状态在比赛和赛事两种语境下的措辞不同。
 */
export const MATCH_STATUS_META: Record<MatchStatus, StatusMeta> = {
	live: { label: '进行中', cls: 'bg-[#22c55e]/15 text-[#4ade80]', dot: true },
	upcoming: { label: '未开始', cls: 'bg-dota/15 text-dota-light' },
	completed: { label: '已结束', cls: 'bg-zinc-600/15 text-zinc-400' },
	postponed: { label: '延期', cls: 'bg-amber-500/15 text-amber-400' },
};

/** 赛事层面的状态展示。 */
export const EVENT_STATUS_META: Record<MatchStatus, StatusMeta> = {
	live: { label: '进行中', cls: 'bg-[#22c55e]/15 text-[#4ade80]' },
	upcoming: { label: '即将开始', cls: 'bg-dota/15 text-dota-light' },
	completed: { label: '已结束', cls: 'bg-zinc-600/15 text-zinc-400' },
	postponed: { label: '延期', cls: 'bg-amber-500/15 text-amber-400' },
};
