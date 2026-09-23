/**
 * MCP 打包入口：只做转发。
 *
 * MCP 里**不能**另抄一份 BP 顺序表或打分口径——那是两套数字迟早对不上的开始。
 * 所以打包时直接从 `src/lib/` 里取：
 *
 * ```sh
 * pnpm mcp:build   # → mcp/dist/engine.mjs
 * ```
 *
 * 好在被取用的这六个文件是干净的：`draftOrder` / `draftLanes` / `draftMatchup` /
 * `draftFoe` 零 import，`draftScore` 与 `draftVerdict` 只互相引用，
 * 对 `draftData` 全是 `import type`（类型在打包时被擦掉）。没有 `node:fs`、没有网络请求，
 * 所以打出来的包不依赖任何运行时。
 *
 * 这个文件本身不进 npm 包：`mcp/package.json` 的 `files` 只列了运行时要用的那几个。
 */

// 顺序表与进度：反推「现在轮到第几手」要用
export {
	CM_STEPS,
	CM_STEP_COUNT,
	CM_PHASE_STARTS,
	DRAFT_BANS_PER_SIDE,
	DRAFT_PICKS_PER_SIDE,
	snapshot,
	otherSide,
	sideOfOwner,
	sideOfStep,
	handsOf,
	canPlay,
} from '../src/lib/draftOrder.ts';

// 候选打分与阵容画像
export { advise, lineupReport, lineupCounter, compositionDimensions, COUNTER_WEIGHT } from '../src/lib/draftScore.ts';

// 双方锁定后的对比与胜率
export { buildVerdict } from '../src/lib/draftVerdict.ts';

// 对位表
export { matchupRate } from '../src/lib/draftMatchup.ts';

// 线上对位
export {
	LANE_MIN_GAMES,
	LANE_POSITIONS,
	LANE_PARTNER_POSITION,
	laneEdge,
	laneEdgeEither,
	lanePartnerEdge,
	lanePartnerPosition,
	formatNet,
} from '../src/lib/draftLanes.ts';

// 对手近期偏好
export { TEAM_FORM_WINDOW_DAYS, summarizeTeamForm, foeWinRate, foeHeroOf, foeHighlights, foeHeroLine } from '../src/lib/draftFoe.ts';
