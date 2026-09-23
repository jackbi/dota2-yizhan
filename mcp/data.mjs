/**
 * 线上那几份公开数据的读取层。
 *
 * **MCP 不自己抓 STRATZ / OpenDota。** 那个 token 绑调用方 IP，额度每天一万次——如果每个用户
 * 的 MCP 各自去抓，等于把「一台固定出口的机器」这个前提拆掉，谁也用不成。站点每 30 分钟
 * 重建一轮，已经把整理好的结果发成静态 JSON，这里只读那几份：
 *
 * | 路径 | 内容 |
 * | --- | --- |
 * | `/draft-data.json` | 127 个英雄的号位胜率、职业样本、2740 条对位、版本口径 |
 * | `/draft-lanes.json` | 线上对位（谁在线上打谁、和谁走一路） |
 * | `/draft-teams.json` | 队名 → OpenDota 队伍 id |
 * | `/api/draft/foe?id=` | 某支队近 30/90 天的英雄偏好（服务端带 token 取） |
 *
 * 换自建域名时用 `DOTA2_MCP_BASE` 覆盖。缓存 10 分钟：上游本来就是 30 分钟一轮，
 * 这里没必要每个工具调用都重下一遍（`/draft-data.json` 有 95KB）。
 */

const BASE = (process.env.DOTA2_MCP_BASE ?? 'https://dota2.hiwenbin.com').replace(/\/+$/, '');
const TTL_MS = Number(process.env.DOTA2_MCP_TTL_MS ?? 600_000);

export const BASE_URL = BASE;

/** path → `{ at, value }`（已就绪）或 `{ pending }`（正在取）。 */
const cache = new Map();

function load(path, { ttl = TTL_MS } = {}) {
	const entry = cache.get(path);
	if (entry?.pending) return entry.pending;
	if (entry && Date.now() - entry.at < ttl) return Promise.resolve(entry.value);

	const pending = (async () => {
		const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
		if (!response.ok) throw new Error(`${BASE}${path} 返回 HTTP ${response.status}`);
		const value = await response.json();
		cache.set(path, { at: Date.now(), value });
		return value;
	})().catch((error) => {
		// 取失败不留半截缓存，下次调用重来。
		cache.delete(path);
		throw new Error(`取 ${BASE}${path} 失败：${error.message}`);
	});

	cache.set(path, { pending });
	return pending;
}

/** 英雄、号位胜率、对位、版本口径。约 95KB。 */
export const draftData = () => load('/draft-data.json');

/** 线上对位。约 104KB，只有需要时才取。 */
export const lanes = () => load('/draft-lanes.json');

/** 队名索引：`[['n:teamspirit', 7119388], ...]`，键带 `n:`（全名）与 `t:`（缩写）两种前缀。 */
export const teamIndex = () => load('/draft-teams.json');

/**
 * 某支队近期的英雄偏好。**不跟着上面的 TTL 走**：它是运行时接口，服务端自己带缓存，
 * 这里只挡一下同一支队在一轮对话里被反复问。
 */
export const teamForm = (teamId) => load(`/api/draft/foe?id=${teamId}`, { ttl: 60_000 });

/**
 * 队名的正规化规则。
 *
 * **必须和 `src/scripts/draftBoard.ts` 里那行一模一样**：`/draft-teams.json` 的键就是按它生成的，
 * 差一个字符就会「页面上查得到、MCP 里查不到」。`scripts/mcp.check.mjs` 会拿真实的队名核对。
 */
export const normTeamName = (value) => String(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

/** 队名 → OpenDota 队伍 id。查不到返回 null（这是锦上添花的依据，不该让整个调用失败）。 */
export async function resolveTeamId(name) {
	const key = normTeamName(name);
	if (!key) return null;
	const rows = await teamIndex();
	const index = new Map(rows);
	return index.get(`n:${key}`) ?? index.get(`t:${key}`) ?? null;
}
