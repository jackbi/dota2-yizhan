#!/usr/bin/env bash
#
# 设置向导：让 Reddit 走官方 OAuth，而不是那个动不动 429 的匿名端点。
# 由 /wizard 技能按 template.sh 生成。
#
# 跑：bash scripts/reddit-oauth.setup.sh
# 浏览器那几步只有你能做；这个脚本负责把值抄回来、写进 .env 与 GitHub secret，最后帮你验一次。
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: 浏览器那几步只有你能做，脚本负责抄值与落盘。
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=4

# 一切路径都相对仓库根：.env 与 gh secret 都跟着当前目录走。
cd "$(dirname "$0")/.."
if [[ ! -d .git || ! -f package.json ]]; then
  printf '请从仓库根目录跑：bash scripts/reddit-oauth.setup.sh\n'
  exit 1
fi

banner "Reddit OAuth 凭据"

stage "在 Reddit 上建一个应用"
say "匿名端点连着抓两个版块，第二个就 429——0.3.1 那一轮「Reddit 赛事讨论」整栏是空的。"
say "配好 app-only 凭据后走 OAuth，不但稳，卡片上还能多出赞数与评论数。"
open_url "https://www.reddit.com/prefs/apps"
step "页面拉到底，点 “are you a developer? create an app...” 或 “create another app...”"
step "name 随便填，比如 dota2-yizhan"
step "类型选 script（app-only 用 script 就够，不需要填账号密码）"
step "redirect uri 必填一个，填 http://localhost:8080（app-only 流程用不到它）"
step "description / about url 留空即可，然后点 “create app”"
note "建好后会出现一张卡片：应用名下面那串是 client id，卡片里的 “secret” 那行是密钥。"
pause "建好了按回车继续"

stage "把 client id 抄回来"
say "卡片上应用名下面那串（十几位，没有前缀）就是 client id。它不是密钥，可以正常显示。"
ask REDDIT_CLIENT_ID "Paste the client id:"

stage "把 secret 抄回来"
say "卡片里 “secret” 那一行，点 edit 可以看到／修改。这串是密钥，输入时不回显。"
ask_secret REDDIT_CLIENT_SECRET "Paste the secret:"

stage "写到本地与 CI"
say "本地：写进 .env（在 .gitignore 里，不会进仓库），以后本机构建也走 OAuth。"
write_env REDDIT_CLIENT_ID "$REDDIT_CLIENT_ID"
write_env REDDIT_CLIENT_SECRET "$REDDIT_CLIENT_SECRET"
say "CI：写进仓库 secret。构建步骤已经在 workflow 里读它们了（.github/workflows/rebuild.yml）。"
set_secret REDDIT_CLIENT_ID "$REDDIT_CLIENT_ID"
set_secret REDDIT_CLIENT_SECRET "$REDDIT_CLIENT_SECRET"

finish

printf '\n'
if confirm "现在触发一次构建，看看有没有走 OAuth？"; then
  if gh workflow run rebuild.yml --ref main >/dev/null 2>&1; then
    sleep 8
    RUN=$(gh run list --workflow=rebuild.yml --limit 1 --json databaseId -q '.[0].databaseId')
    note "已触发 run $RUN · 约 3 分钟后跑完"
    note "验的时候看这一行（要出现 “来自 OAuth 接口”）："
    note "  gh run view $RUN --log | grep 'Reddit r/'"
    note "线上：https://dota2.hiwenbin.com/news#reddit"
  else
    warn "没触发成功，手动跑：gh workflow run rebuild.yml --ref main"
  fi
else
  note "稍后自己触发：gh workflow run rebuild.yml --ref main"
fi
