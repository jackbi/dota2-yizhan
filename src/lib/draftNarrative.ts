import type { Advice } from './draftScore.ts';

/**
 * 没接模型时的那段解释。
 *
 * 它只做一件事：把已经算好的依据串成人话。**这里不产生任何新数字**——每一句的出处都在
 * 候选卡的「依据」里，所以它不会像模型那样凭空给出一个胜率来。界面上有模型时的位置由模型
 * 占据，没模型（或调用失败）时由它顶上，两边的职责是同一个：给一串数字配一句话。
 */

/** 一句话说清「这一手为什么是它」。`heroName` 由调用方给，因为英雄名只在页面那份数据里。 */
export function adviceNarrative(advice: Advice, heroName: (heroId: number) => string): string {
	const top = advice.candidates[0];
	if (!top) return '';
	const verb = advice.action === 'ban' ? '优先禁' : '优先拿';
	const head = `${verb} ${heroName(top.heroId)}，打 ${top.position} 号位。`;
	// 只取前两条：理由本身有五六条，全铺开就退化成候选卡的复读。
	const points = top.reasons.slice(0, 2).join('；');
	const body = points ? `${points}。` : '';
	const risk = top.risk ? `要留意：${top.risk}。` : '';
	return `${head}${body}${risk}`;
}

export interface OpponentMoveInput {
	action: 'ban' | 'pick';
	position: number;
	rate: number;
	/** 这个号位有没有真实样本；没有就别把中性估值写成实测胜率。 */
	hasSample: boolean;
	/** 这个英雄在它近期比赛里的出场次数；够不上熟手传 null。 */
	foePicks: number | null;
	windowDays: number;
}

/**
 * 对手这一手为什么这么走。
 *
 * 不复用候选卡的 `reasons`：那些句子是按**出招方的视角**生成的，里面有「我方」「对面」，
 * 直接贴到日志行上会指反。这里只用结构化的字段重写一遍，人称就不会翻车。
 *
 * 禁用与挑选的 `position` 含义**不一样**，这不是笔误：`draftScore` 里禁用是按「对面拿了能涨
 * 多少」算的，那个号位属于**被禁的一方**；挑选才是出招方自己的号位。所以禁用的措辞里不写
 * 「它的几号位」（那会读成出招方自己的位置，正好说反），只说它是那个号位上的一个高点。
 */
export function opponentMoveReason(input: OpponentMoveInput): string {
	const rateText = input.hasSample
		? `该号位近期胜率 ${(input.rate * 100).toFixed(1)}%`
		: '该号位样本不足，只能按中性估';
	const head = input.action === 'ban' ? `它是 ${input.position} 号位上的一个高点（${rateText}）` : `打 ${input.position} 号位（${rateText}）`;
	if (input.foePicks === null) return head;
	return `${head}，它近 ${input.windowDays} 天拿过 ${input.foePicks} 场`;
}
