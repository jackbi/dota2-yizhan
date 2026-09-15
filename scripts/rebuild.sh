#!/bin/sh
#
# 定时重建：构建到暂存目录，成功后再整体换上去。
#
# ## 为什么不能就地重建
#
# 加了 @astrojs/node 之后，`dist/` 不再是「一堆静态文件」，而是「静态资源 + 一个常驻
# 服务进程」。实测过两件事：
#
# 1. 服务进程是**按请求从磁盘读** `dist/client` 的。就地重建会让旧的哈希资源（如
#    `_astro/Layout.BQUakPPC.css`）立刻消失，而页面 HTML 仍引用着它 —— 实测取该资源
#    当场变 404，页面直接掉样式。
# 2. 进程启动时就把 `dist/server` 的模块 import 进内存了。就地重建后，**服务端跑的还是
#    旧代码**，客户端却换成了新资源：旧服务端 + 新客户端，比单纯 404 更难查。
#
# 所以：构建写进 `dist-next`，`dist` 在构建期间保持完好；只有构建成功了才切换，
# 切换后**必须重启服务进程**。
#
# 用法：
#   scripts/rebuild.sh                    # 构建 + 切换，之后自己重启服务
#   RESTART_CMD='systemctl restart dota2-news' scripts/rebuild.sh
#
# 注意 `dist-next` / `dist-prev` 都在 `.gitignore` 里，别提交。

set -eu

cd "$(dirname "$0")/.."

STAGING=dist-next
PREVIOUS=dist-prev

# 上一轮失败可能留下半成品，先清干净，免得把它当成本次产物。
rm -rf "$STAGING"

echo "[rebuild] 构建到 $STAGING/（$PWD 仍是正在服务的那份）"
if ! pnpm exec astro build --outDir "$STAGING"; then
	echo "[rebuild] 构建失败，$STAGING/ 不切换，线上保持原样" >&2
	exit 1
fi

# 产物基本校验：少了 server 入口就说明这次构建是残的，宁可不上。
if [ ! -f "$STAGING/server/entry.mjs" ] || [ ! -d "$STAGING/client" ]; then
	echo "[rebuild] 产物不完整（缺 server/entry.mjs 或 client/），不切换" >&2
	exit 1
fi

# 两次 rename。严格说这不是一个原子操作，中间有一瞬 $PWD 不存在——但这一刻服务本来就要
# 重启，且构建全程没碰过它，比「就地重建把资源挖空」安全得多。
rm -rf "$PREVIOUS"
if [ -d dist ]; then
	mv dist "$PREVIOUS"
fi
mv "$STAGING" dist

echo "[rebuild] 已切换到新产物（上一版留在 $PREVIOUS/，可回滚：mv $PREVIOUS dist）"

if [ -n "${RESTART_CMD:-}" ]; then
	echo "[rebuild] 重启服务：$RESTART_CMD"
	sh -c "$RESTART_CMD"
	echo "[rebuild] 完成"
else
	echo "[rebuild] 还没生效——服务进程持有的是旧的服务端代码，需要重启："
	echo "          systemctl restart <你的服务>   或   pm2 restart <name>   或   手动重起 node"
	echo "          也可以直接设 RESTART_CMD 让本脚本代劳。"
fi
