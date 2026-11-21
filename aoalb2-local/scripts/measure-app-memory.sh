#!/usr/bin/env bash
# Linux（WebKitGTK）でアプリ全体（中核＋WebViewの全プロセス）のメモリを計測する。
# 使い方：scripts/measure-app-memory.sh <アプリ実行ファイル> <工事フォルダ> <出力フォルダ>
set -euo pipefail
APP="$1"; PROJECT="$2"; OUT="$3"
mkdir -p "$OUT"
export AOALB2_E2E_PROJECT="$PROJECT" AOALB2_E2E_OUT="$OUT/e2e-result.json"
"$APP" > "$OUT/app.log" 2>&1 &
PID=$!
echo "time,processes,rss_mb,pss_mb" > "$OUT/memory.csv"
echo "time,process,pss_mb" > "$OUT/memory-by-process.csv"
tree() { local p=$1; echo "$p"; for c in $(pgrep -P "$p" || true); do tree "$c"; done; }
while kill -0 "$PID" 2>/dev/null; do
  pids=$(tree "$PID")
  rss=0; pss=0; n=0
  for p in $pids; do
    r=$(awk '/^VmRSS:/{print $2}' /proc/$p/status 2>/dev/null || echo 0)
    s=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null || echo 0)
    rss=$((rss + ${r:-0})); pss=$((pss + ${s:-0})); n=$((n + 1))
    echo "$(date -u +%H:%M:%S),$(cat /proc/$p/comm 2>/dev/null),$(( ${s:-0} / 1024 ))" >> "$OUT/memory-by-process.csv"
  done
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ),$n,$((rss / 1024)),$((pss / 1024))" >> "$OUT/memory.csv"
  sleep 0.5
done
echo "peak rss/pss (MB):" $(awk -F, 'NR>1{if($3>r)r=$3; if($4>s)s=$4} END{print r, s}' "$OUT/memory.csv")
