# 不要加 `# syntax=docker/dockerfile:1`：NAS 上的 docker 只能经镜像加速器拉基础镜像，
# 拉 buildkit 前端镜像（docker.io/docker/dockerfile）会 401，整次构建直接失败。
# 这份 Dockerfile 没用到任何 BuildKit 专属语法，经典构建器一样能构建。
#
# Horon 服务镜像：控制台 /api、打包好的前端、以及给 dsh dsh-horon 插件用的 /api/cli 与 /api/hook/*。
# 构建上下文是 docker/context/，由 `node docker/build.mjs <Horon 仓库>` 组装：
#   context/app/  Horon 后端 + CLI + 说明书 + horon_web_app.py
#   context/web/  控制台前端的构建输入
# 镜像里没有 .env 和任何数据库；库在 /data（宿主目录的绑定挂载），每台机器各用各的。
#
# 可选构建参数（都可留空）：
#   BUILD_PROXY   构建时访问 npm / PyPI / apt 用的代理，如 http://host.docker.internal:7890
#   NPM_REGISTRY  npm 镜像源，如 https://registry.npmmirror.com
#   PIP_INDEX     PyPI 镜像源，如 https://mirrors.aliyun.com/pypi/simple

# ---- 1. 前端 -----------------------------------------------------------------------------------
# 锁定生成 web/package-lock.json 的那版 Node/npm（npm 11.6.2）：npm 10.x 和更新的 11.x 的 npm ci 认为这份锁文件缺 @emnapi/*，直接拒绝。
FROM node:24.13.0-slim AS web
ARG BUILD_PROXY=
ARG NPM_REGISTRY=
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
    npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. 服务 -----------------------------------------------------------------------------------
FROM python:3.12-slim
ARG BUILD_PROXY=
ARG PIP_INDEX=

# _now() 用本地时间写审计日志和时间戳，所以要有时区数据。
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    sed -i 's#http://deb.debian.org#https://mirrors.aliyun.com#g' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata; \
    rm -rf /var/lib/apt/lists/*

COPY requirements.lock.txt /tmp/requirements.lock.txt
RUN set -eu; \
    if [ -n "$BUILD_PROXY" ]; then export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY"; fi; \
    if [ -n "$PIP_INDEX" ]; then export PIP_INDEX_URL="$PIP_INDEX"; fi; \
    pip install --no-cache-dir -r /tmp/requirements.lock.txt; \
    rm /tmp/requirements.lock.txt

WORKDIR /app
COPY app/ /app/
COPY --from=web /web/dist /app/web/dist
COPY entrypoint.sh /usr/local/bin/horon-entrypoint
# tag_plugins 会被宿主目录盖住：镜像自带的系统插件另存一份，由入口脚本补进挂载目录里。
# 入口脚本可能带着 Windows 换行同步过来，这里统一成 LF。
RUN set -eu; \
    sed -i 's/\r$//' /usr/local/bin/horon-entrypoint; \
    chmod 755 /usr/local/bin/horon-entrypoint; \
    mkdir -p /opt/horon-seed/tag_plugins /data /app/.horon-local; \
    cp /app/backend/tag_plugins/*.py /opt/horon-seed/tag_plugins/ 2>/dev/null || true

# HORON_DB 是绝对路径时，cli.py / run_gateway.py / 服务都直接用它（不拼仓库根）。
# 环境变量优先于 .env：load_dotenv 不覆盖已有变量。镜像里本来也没有 .env。
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

# 健康检查绕开 HTTP(S)_PROXY：容器里可能配了代理，而 127.0.0.1 不能走代理。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request as u; u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8710/api/sessions', timeout=4)"

ENTRYPOINT ["horon-entrypoint"]
CMD ["python", "-m", "uvicorn", "horon_web_app:app", "--host", "0.0.0.0", "--port", "8710"]
