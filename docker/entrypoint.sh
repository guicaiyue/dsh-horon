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

# Two fixes to the model calls, applied at every start so they survive image pulls:
#  - `openai/gpt-6-luna` (NAMER_MODEL) answers 403 "not available in your region" from some
#    networks, so `suggest_name` and the name check inside `audit --concept` always failed.
#    deepseek/deepseek-v3.2 is reachable under the zero-retention policy.
#  - The chat call sent no max_tokens, so OpenRouter reserved room for the model's whole output
#    window and refused with HTTP 402 once the account could not cover it. A name is a few words.
python3 /usr/local/bin/horon-patch-llm >/dev/null 2>&1 || true

exec "$@"
