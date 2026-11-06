#!/bin/sh
# 容器入口：准备好可写目录，再交给 CMD（默认是 uvicorn）。
set -eu

DB_DIR="$(dirname "${HORON_DB:-/data/horon.db}")"
mkdir -p "$DB_DIR" /app/.horon-local /app/backend/tag_plugins

# tag_plugins 挂的是卷，第一次启动时是空的。把镜像自带的系统插件补进去，
# 已有的同名文件不覆盖（用户/agent 改过的插件留着）。
for f in /opt/horon-seed/tag_plugins/*.py; do
  [ -e "$f" ] || continue
  dest="/app/backend/tag_plugins/$(basename "$f")"
  [ -e "$dest" ] || cp "$f" "$dest"
done

exec "$@"
