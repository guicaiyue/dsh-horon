# Horon service image: the console (/api), the built front end, and the two endpoints the dsh
# dsh-horon plugin calls (/api/cli and /api/hook/*).
#
# The image contains no repository checkout of its own. It is built from two inputs:
#   - this plugin at the built commit (its bridge horon_web_app.py, entrypoint, pinned requirements)
#   - the Horon commit pinned in horon.lock.json, fetched here by SHA
# CI passes HORON_SHA from that lock file, so the image identity is (plugin commit, horon commit).
#
# No `.env`, no database, no venv: the database lives on a bind mount at /data and every machine
# keeps its own.
#
# Optional build args:
#   HORON_REPO     https://github.com/Dataojitori/horon.git
#   HORON_SHA      the pinned commit (required; CI reads it from horon.lock.json)
#   BUILD_PROXY    proxy for npm / PyPI / apt during the build, e.g. http://host.docker.internal:7890
#   NPM_REGISTRY   npm mirror, e.g. https://registry.npmmirror.com
#   PIP_INDEX      PyPI mirror, e.g. https://mirrors.aliyun.com/pypi/simple
#
# Do not add `# syntax=docker/dockerfile:1`: some hosts can only reach base images through a
# registry mirror, and the buildkit frontend image then fails with 401. Nothing below needs
# BuildKit-only syntax.

# ---- 1. fetch the pinned Horon commit -----------------------------------------------------------
# No git and no apt: the commit archive is one HTTPS request, and `tar`/`gzip` are in the base
# image. That keeps the build off Debian mirrors entirely (they were the slowest and most fragile
# part) and still locks the exact commit.
FROM node:24.13.0-slim AS source
ARG HORON_REPO=https://github.com/Dataojitori/horon.git
ARG HORON_SHA
ARG BUILD_PROXY=
WORKDIR /src
RUN set -eu; \
    test -n "$HORON_SHA" || { echo "HORON_SHA is required (see horon.lock.json)"; exit 1; }; \
    host=$(printf '%s' "$HORON_REPO" | sed -E 's#^[a-z]+://([^/]+)/.*#\1#; s#^git@([^:]+):.*#\1#'); \
    path=$(printf '%s' "$HORON_REPO" | sed -E 's#^[a-z]+://[^/]+/##; s#^git@[^:]+:##; s#\.git$##'); \
    case "$host" in \
      github.com) url="https://codeload.github.com/$path/tar.gz/$HORON_SHA" ;; \
      *) url="https://$host/$path/archive/$HORON_SHA.tar.gz" ;; \
    esac; \
    echo "fetching $url"; \
    node -e 'const [url,out]=process.argv.slice(1);fetch(url,{redirect:"follow"}).then(async r=>{if(!r.ok){console.error("HTTP",r.status);process.exit(1)}require("fs").writeFileSync(out,Buffer.from(await r.arrayBuffer()))})' "$url" /tmp/src.tar.gz; \
    tar -xzf /tmp/src.tar.gz -C /src --strip-components=1; \
    rm -f /tmp/src.tar.gz; \
    test -f /src/frontend/cli.py

# ---- 2. assemble + build the console ------------------------------------------------------------
# One assembler for both deployables: the release artifact and this image see the same tree.
FROM node:24.13.0-slim AS assemble
ARG NPM_REGISTRY=
ARG BUILD_PROXY=
WORKDIR /plugin
COPY . /plugin
COPY --from=source /src /src
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
    node scripts/assemble.mjs --repo /src --out /out --platform linux-x64 --build-web

# ---- 3. service ---------------------------------------------------------------------------------
FROM python:3.12-slim
ARG BUILD_PROXY=
ARG PIP_INDEX=

# _now() writes local timestamps into the audit log, so the timezone database is needed.
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    sed -i 's#http://deb.debian.org#https://mirrors.aliyun.com#g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata; \
    rm -rf /var/lib/apt/lists/*

COPY --from=assemble /out/requirements.lock.txt /tmp/requirements.lock.txt
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    if [ -n "$PIP_INDEX" ]; then export PIP_INDEX_URL="$PIP_INDEX"; fi; \
    pip install --no-cache-dir -r /tmp/requirements.lock.txt; \
    rm /tmp/requirements.lock.txt

WORKDIR /app
COPY --from=assemble /out/app/ /app/
COPY docker/entrypoint.sh /usr/local/bin/horon-entrypoint
# tag_plugins is covered by a volume, so the system plugins are also stashed for the entrypoint to
# seed into it. The entrypoint may arrive with CRLF from a Windows checkout; normalise it.
RUN set -eu; \
    sed -i 's/\r$//' /usr/local/bin/horon-entrypoint; \
    chmod 755 /usr/local/bin/horon-entrypoint; \
    mkdir -p /opt/horon-seed/tag_plugins /data /app/.horon-local; \
    cp /app/backend/tag_plugins/*.py /opt/horon-seed/tag_plugins/ 2>/dev/null || true

# HORON_DB as an absolute path is used as-is by cli.py, run_gateway.py and the service.
# Environment wins over .env: load_dotenv never overrides an existing variable, and the image has
# no .env anyway.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONPATH=/app \
    TZ=Asia/Shanghai \
    HORON_ROOT=/app \
    HORON_DB=/data/horon.db \
    HORON_MANUAL_LOCATION="the horon-cli skill (registered by the dsh dsh-horon plugin)"

VOLUME ["/data", "/app/.horon-local", "/app/backend/tag_plugins"]
EXPOSE 8710

# The health check bypasses HTTP(S)_PROXY: the container may be configured with a proxy, and
# 127.0.0.1 must not go through it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request as u; u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8710/api/sessions', timeout=4)"

ENTRYPOINT ["horon-entrypoint"]
CMD ["python", "-m", "uvicorn", "horon_web_app:app", "--host", "0.0.0.0", "--port", "8710"]
