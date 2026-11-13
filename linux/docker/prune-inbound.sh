#!/bin/sh
set -eu

# 宿主机 cron 用：清 ~/aidy 布局下满 24 小时的 inbound 原件。
# 对应 compose 卷：./config → /home/node/.openclaw ，./workspace → .../workspace
# 因此这里是 $HOME/aidy/config/media/inbound 与 $HOME/aidy/workspace/media/inbound
# （不是容器内路径）。写入 crontab 见运维手册 10.4 / 10.4.1。

LOG="${HOME}/aidy/logs/inbound-prune.log"
LOCK="${HOME}/aidy/logs/inbound-prune.lock"

DIRS="
${HOME}/aidy/config/media/inbound
${HOME}/aidy/workspace/media/inbound
"

ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
mkdir -p "$(dirname "$LOG")"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(ts) SKIP already running" >> "$LOG"
  exit 0
fi

total=0
for dir in $DIRS; do
  [ -d "$dir" ] || { echo "$(ts) SKIP missing $dir" >> "$LOG"; continue; }
  n=$(find "$dir" -type f -mmin +1440 -print -delete | wc -l)
  find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  bytes=$(du -sb "$dir" 2>/dev/null | awk '{print $1}')
  echo "$(ts) dir=$dir deleted_files=$n remain_bytes=${bytes:-0}" >> "$LOG"
  total=$((total + n))
done
echo "$(ts) done total_deleted=$total" >> "$LOG"