# MCP：让 AI 直接用上站里的数据

站里的英雄胜率、对位、BP 建议，本来只有页面能用。`mcp/` 下是一个 MCP server，把这些做成
AI 能调的工具——Claude、Cursor、Codex 里问「这局该怎么 ban」，它去查的是同一份实测数据，
而不是模型凭记忆编。

```sh
claude mcp add dota2 -- npx -y dota2-yizhan
```

其他客户端写进 `mcpServers`：

```json
{
  "mcpServers": {
    "dota2": { "command": "npx", "args": ["-y", "dota2-yizhan"] }
  }
}
```

## 五个工具

| 工具 | 做什么 |
| --- | --- |
| `search_hero` | 名字 / 俗称 / id → 英雄 id。支持「火猫」「AM」「剑圣」这类叫法 |
| `get_hero_stats` | 某英雄各号位胜率与场次、职业样本、官方定位、时间曲线 |
| `get_matchup` | 对位：谁克谁。指定对手就报那几个，不指定就给最好打与最难打两端 |
| `analyze_lineup` | 双方各五个英雄：胜率、16 行维度对比、线上谁打谁 |
| `suggest_pick` | 当前已经拿了谁 → 这一手该禁谁或选谁，带理由与风险 |

做这五个、不做别的，是因为它们提供的都是**模型自己算不出来的东西**：实测胜率、
人工整理的结构维度、真实的线对位。至于「某选手最近比赛打得怎么样」这种，
`opendota-mcp-server` 和 `stratz-mcp` 已经做了，再包一层没有意义，所以没做。

## 数据从哪来：不自己抓上游

MCP **不**去连 STRATZ 或 OpenDota。那个 token 绑调用方 IP、额度每天一万次，
如果每个用户的 MCP 各自去抓，等于把「一台固定出口的机器」这个前提拆掉，谁也用不成。

所以它只读站点已经发布的那几份公开文件：

| 路径 | 内容 |
| --- | --- |
| `/draft-data.json` | 127 个英雄的号位胜率、职业样本、2500 条上下的对位、版本口径 |
| `/draft-lanes.json` | 线上对位（谁在线上打谁、和谁走一路） |
| `/draft-teams.json` | 队名 → OpenDota 队伍 id |
| `/api/draft/foe?id=` | 某支队近期的英雄偏好 |

站点每 30 分钟重建一轮，这几份跟着更新。MCP 端缓存 10 分钟（`DOTA2_MCP_TTL_MS`），
工具输出里都会带上抓取时间，模型照实说就行。

换自建域名用 `DOTA2_MCP_BASE`。

## 引擎是打包进去的，不是抄一份

BP 顺序表、打分权重、维度口径都在 `src/lib/` 里。MCP 里另抄一份是两套数字迟早对不上的开始，
所以打包时直接从源码取：

```sh
pnpm mcp:build   # → mcp/dist/engine.mjs
```

能这么做是因为被取的那六个文件很干净：`draftOrder` / `draftLanes` / `draftMatchup` /
`draftFoe` 零 import，`draftScore` 与 `draftVerdict` 只互相引用，对 `draftData` 全是
`import type`。没有 `node:fs`、没有网络请求，打出来的包不依赖任何运行时。

**改了引擎要重新打包**（`pnpm mcp:build`），否则发出去的还是旧口径。
`pnpm check` 里的 `mcp.check` 会把「产物与源码不一致」直接报出来，`mcp/package.json` 的
`prepublishOnly` 也会在发布前重打一次。

## 为什么不装官方 SDK

`@modelcontextprotocol/sdk` 的直接依赖有十七个（express、hono、jose、ajv、cors…），
而这台服务只需要 stdio 上的四个方法：`initialize`、`tools/list`、`tools/call`、`ping`。
多出来的依赖会实打实拖慢 `npx` 的冷启动，对「一行接入」的工具不划算。

`mcp/server.mjs` 就手写这一部分，不支持的能力明确报 `-32601`，不装作支持。
stdout 只走协议，日志一律去 stderr。

## 俗称表是唯一需要人工维护的东西

`mcp/heroAliases.mjs` 是手写的：官方数据里只有中文名和英文名，没有「火猫」「AM」这类叫法。
全网的公开数据集里也没有现成的（`dotaconstants` 没有，npm 上没有），所以只能自己攒。

收录标准写在文件头部，简单说两条：**只在社区里真的有人这么叫**，且**同一个俗称只挂一个英雄**。
「幻刺」挂幻影刺客、「猴子」挂齐天大圣，都有唯一性；「小娜迦」这种为了区分而造的前缀不收。

键是官方中文名而不是 id，这样表本身能被人直接读和改。代价是英雄改名时那一行会对不上——
`pnpm check` 里有一条会拿线上英雄表逐键核对，对不上就报出来。

## `suggest_pick` 为什么不要求排 24 手

引擎要的是完整的 24 手记录，但让模型手搓 24 手很容易出错。所以工具只收
「双方已经拿到的 ban 与 pick」，服务端按固定的 `CM_STEPS` 顺序反推现在轮到第几手：
依次把两边各自的英雄填进各自的手位，某一方填到没有剩余时就是当前进度。

填完之后如果还有英雄排不进去，说明输入和顺序对不上（比如第一手之前后选方就有了两次禁用），
这时**报错而不是猜**——猜错会让后面所有建议都建立在错误的手号上，而输出看起来完全正常。
这条逻辑在 `scripts/mcp.check.mjs` 里有用例守着。

## 发布

```sh
pnpm mcp:build                  # 重新打包引擎
git push                        # 先让仓库是干净的
cd mcp && npm publish            # prepublishOnly 会再打一次
```

发之前确认两件事：`mcp/package.json` 的版本号和根 `package.json` 一致（`pnpm check` 会核对），
以及 `files` 里列的文件都在（`dist/` 是构建产物，不进 git，但必须在包里）。

## 已知的取舍

- **英雄俗称靠人工维护**，新英雄出来要手动补一行，没补就只能用官方名或英文名找到它
- **数据跟着站点重建走**，最坏情况比上游晚 30 分钟；页面上的抓取时间就是它的新鲜度
- **个人战绩不在里面**：那条路要 Steam 登录，MCP 里没法授权
- **强依赖 `dota2.hiwenbin.com` 可用**。站点挂了，工具会报取数失败并说明是哪个地址，
  但不会有降级数据（本地缓存只在一次进程生命周期内，进程退出就没了）
