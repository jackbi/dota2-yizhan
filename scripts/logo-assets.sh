#!/bin/sh
# 把 logo 母版转成站点实际发布的三份图标资源。
#
#   src/assets/logo.png  --(本脚本)-->  public/logo.webp            页眉 / 页脚
#                                       public/favicon.png          标签页图标
#                                       public/apple-touch-icon.png iOS 加到主屏
#
# 换 logo 时：替换 src/assets/logo.png（1254px 见方或更大的方图）→ 跑一遍这个脚本 →
# 提交 public/ 下重新生成的三份。母版刻意**不放在 public/**：public/ 会原样进发布产物，
# 而站点一个字节都不需要那份 1254px / 590 KB 的原图。
#
# 为什么标签页图标是 PNG 而不是 WebP：Safari 至今不支持 WebP 的 favicon。
#
# 依赖：macOS 自带的 sips，以及 cwebp（brew install webp）。
set -e
cd "$(dirname "$0")/.."

SRC=src/assets/logo.png
if [ ! -f "$SRC" ]; then
	echo "找不到 logo 母版 $SRC" >&2
	exit 1
fi

# 128px：40px 的显示在 3 倍屏上也就 120px，够用。
cwebp -quiet -q 88 -m 6 -resize 128 128 "$SRC" -o public/logo.webp
# 96px：浏览器把这一张缩到 16 / 32 / 48px 的标签页上。
sips -Z 96 "$SRC" --out public/favicon.png >/dev/null
sips -Z 180 "$SRC" --out public/apple-touch-icon.png >/dev/null

ls -l public/logo.webp public/favicon.png public/apple-touch-icon.png
