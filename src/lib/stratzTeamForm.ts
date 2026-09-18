import { cached } from './ssrCache';
import { stratzGql } from './stratzRuntime';
import type { FoeForm, RawFormMatch } from './draftFoe';
import { TEAM_FORM_WINDOW_DAYS, summarizeTeamForm } from './draftFoe';

/**
 * 「对面擅长什么」——某支队伍近期比赛里的英雄偏好。
 *
 * 为什么要这一层：`draftScore` 手里只有**全局**的号位胜率，它知道「潮汐猎人这周三号位过得不错」，
 * 但不知道「这场对面是三号位只玩潮汐和兽王的那支队」。BP 里这两种信息的用法完全不同：
 * 前者决定这一手值不值，后者决定该不该把他们的招牌直接禁掉。所以这里把**队伍**维度的数据
 * 单独取一份，交给打分层和模型，而不是塞进全局胜率里搅在一起。
 *
 * 一次查询就够：`team.matches` 支持把 `pickBans` 一起带回来（实测过），所以 50 场 BP 是**一个**
 * 请求，不用按比赛逐场补。窗口取 30 天，理由是队伍的人员与版本都在变，再长就会把上个阵容的
 * 习惯算成现在的能力。
 *
 * 口径上有一件事必须说清：给**队伍**统计出场次数，比给选手统计要不精确——同一个英雄这场打
 * 一号位、下场打四号位，这里分不出来。所以界面与提示词里只说「他们拿了多少场、赢了多少」，
 * 不写「这是几号位英雄」。
 */

/**
 * 窗口内最多算多少场。30 天里一线队大概打 20–50 场，50 场足够覆盖，
 * 也让单次响应保持在几十 KB 以内（其中只有 pickBans 有用）。
 */
export const TEAM_FORM_TAKE = 50;

/** 缓存 30 分钟：一场比赛打完到数据进库有延迟，更短的 TTL 只会白烧额度。 */
const TEAM_FORM_TTL_MS = 30 * 60 * 1000;

/**
 * 30 天里一场都没取到时退到 90 天。
 *
 * 休赛期回来的队伍、换过 id 的队伍很常见，这时候「没有依据」比「依据旧一点」更糟：
 * 观众看的是正在打的这场，对手一定在近期打过，查不到多半是窗口太窄。
 * 放宽之后窗口天数会写进数据里（界面上就是「近 90 天」），不会假装还是 30 天。
 */
export const TEAM_FORM_FALLBACK_WINDOW_DAYS = 90;

/** 队伍偏好就是公共形状再加一个队伍 id（页面要拿它区分是哪支队的数据）。 */
export interface TeamForm extends FoeForm {
	teamId: number;
}

interface RawTeamForm {
	id?: number | null;
	name?: string | null;
	matches?: RawFormMatch[] | null;
}

const TEAM_FORM_DOCUMENT = `query TeamForm($id: Int!, $from: Long!) {
	team(teamId: $id) {
		id
		name
		matches(request: { startDateTime: $from, take: ${TEAM_FORM_TAKE}, skip: 0 }) {
			id
			radiantTeamId
			direTeamId
			didRadiantWin
			pickBans {
				heroId
				isPick
				isRadiant
			}
		}
	}
}`;

/**
 * 取一支队伍近期的英雄偏好。取不到返回 null（STRATZ 里没有这支队伍），
 * 上游故障则抛错——调用方要能把「查不到」和「暂时取不到」分开说。
 */
export async function loadTeamForm(teamId: number): Promise<TeamForm | null> {
	return cached(`team-form:${teamId}`, TEAM_FORM_TTL_MS, async () => {
		const primary = await loadWindow(teamId, TEAM_FORM_WINDOW_DAYS);
		// STRATZ 里没有这支队伍，放宽窗口也还是没有。
		if (!primary || primary.matches > 0) return primary;
		return (await loadWindow(teamId, TEAM_FORM_FALLBACK_WINDOW_DAYS)) ?? primary;
	});
}

async function loadWindow(teamId: number, days: number): Promise<TeamForm | null> {
	const from = Math.floor(Date.now() / 1000) - days * 24 * 3600;
	const data = await stratzGql<{ team: RawTeamForm | null }>(TEAM_FORM_DOCUMENT, { id: teamId, from });
	if (!data.team) return null;
	return { teamId, ...summarizeTeamForm(teamId, data.team.name ?? '', data.team.matches ?? [], days) };
}
