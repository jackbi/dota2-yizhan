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
	/**
	 * 出招方**这一手还没落之前**还剩几禁几选（含当前这一手）；拿不到就传 null。
	 *
	 * 替对面出招的日志行原先只有"为什么是它"，读者不知道这是第几轮、后面还有几手——
	 * 而这几个数字就在 BP 顺序表里（`draftOrder.snapshot().remaining`，它按"已记录的手数"
	 * 扣减，所以落子前读到的数**含**当前这一手），白拿的信息。
	 *
	 * 句子写的是"落完这手还剩"，所以扣减在这里做：调用方直接传快照里的原值就行，
	 * 免得每个调用点各减一次、减错一次（上一版就是忘了减，数字恒多 1）。
	 */
	remainingBefore?: { bans: number; picks: number } | null;
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
	const parts = [head];
	if (input.remainingBefore) {
		// 这一手落下之后：当前 action 的那一项减 1（快照给的是含当前手的数）。
		const bans = input.remainingBefore.bans - (input.action === 'ban' ? 1 : 0);
		const picks = input.remainingBefore.picks - (input.action === 'pick' ? 1 : 0);
		parts.push(`落完这手还剩 ${Math.max(0, bans)} 禁 ${Math.max(0, picks)} 选`);
	}
	if (input.foePicks !== null) parts.push(`它近 ${input.windowDays} 天拿过 ${input.foePicks} 场`);
	return parts.join('，');
}
