"""
Horon Web 服务：一个进程同时提供控制台 /api 接口、打包好的前端（web/dist），以及给 dsh 插件
远程调用的两个执行接口。

    python -m uvicorn horon_web_app:app --host 127.0.0.1 --port 8710

两种跑法：
  - 本机：由 dsh 的 dsh-horon 插件拉起。HORON_ROOT 指向 Horon 仓库根目录，PYTHONPATH 里同时带上
    仓库根和本文件所在目录，所以 `backend.*` 和 `horon_web_app` 都能导入。只监听回环地址。
  - Docker：见 docker/Dockerfile。插件配置 url 指向这个服务，horon 工具和 Hook 都走下面两个接口。

执行接口（每次请求起一个子进程：cli.py 在导入时就按环境变量定下会话，不能在一个进程里复用）：
  POST /api/cli          {"args": [...], "session_id": "...", "stdin": "..."}
                         -> 跑 `python frontend/cli.py <args>`，返回 {code, stdout, stderr}
  POST /api/hook/{event} 请求体原样作为 stdin
                         -> 跑 `python run_gateway.py <event> --adapter dsh`，返回 {code, stdout, stderr}

接口没有鉴权，只给本机或内网用。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from backend._db_common import OFFLINE_DEV_SESSION_ID
from backend.db import HoronDB, create_database, database_exists
from backend.web_api import make_router

ROOT = Path(os.environ.get("HORON_ROOT") or Path.cwd()).resolve()
DIST = ROOT / "web" / "dist"
CLI = ROOT / "frontend" / "cli.py"
GATEWAY = ROOT / "run_gateway.py"
# audit 会逐个节点问 Jev，可能跑几分钟；Hook 由插件那边另有 45 秒超时，这里只兜底。
CLI_TIMEOUT_S = float(os.environ.get("HORON_CLI_TIMEOUT") or 900)
HOOK_TIMEOUT_S = float(os.environ.get("HORON_HOOK_TIMEOUT") or 120)
_EVENT = re.compile(r"[A-Za-z]+")
# 本地这一个库的路径，服务启动时（lifespan）从 .env 的 HORON_DB 读一次。
_db_path: Path | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_path
    load_dotenv(ROOT / ".env")
    _db_path = ROOT / os.environ["HORON_DB"]  # 绝对路径时就是它本身
    if not database_exists(_db_path):  # 和 cli.py 一样：第一次用就在 HORON_DB 指的位置建一个空库
        create_database(_db_path)
    HoronDB(db_path=_db_path, session_id=OFFLINE_DEV_SESSION_ID).close()  # 库坏了就让服务启动时直接报错
    yield


app = FastAPI(title="Horon Console", lifespan=lifespan)
# 只放行回环来源：控制台自己（同源）以及本机的 dsh / vite 页面。经 dsh 反代访问时是同源，用不到 CORS。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(make_router(lambda _request: _db_path, remote=False), prefix="/api")


class CliRequest(BaseModel):
    args: list[str]
    session_id: str | None = None  # dsh 的会话 ID；cli.py 按它记读取记录和审计日志
    stdin: str | None = None  # 只给 `batch`（不带 --file）用：每行一条命令


def _run(argv: list[str], stdin: str, env: dict[str, str], timeout: float) -> dict:
    try:
        done = subprocess.run(
            argv, input=stdin.encode("utf-8"), capture_output=True, cwd=ROOT, env=env, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"code": 124, "stdout": "", "stderr": f"Horon service: timed out after {timeout:g}s"}
    return {
        "code": done.returncode,
        "stdout": done.stdout.decode("utf-8", errors="replace"),
        "stderr": done.stderr.decode("utf-8", errors="replace"),
    }


def _child_env(session_id: str | None = None) -> dict[str, str]:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    env.pop("HORON_DSH_SESSION_ID", None)
    if session_id:
        env["HORON_DSH_SESSION_ID"] = session_id
    return env


@app.post("/api/cli")
async def run_cli(body: CliRequest) -> dict:
    argv = [sys.executable, str(CLI), *body.args]
    return await run_in_threadpool(_run, argv, body.stdin or "", _child_env(body.session_id), CLI_TIMEOUT_S)


@app.post("/api/hook/{event}")
async def run_hook(event: str, request: Request) -> dict:
    if not _EVENT.fullmatch(event):
        raise HTTPException(status_code=400, detail="invalid event name")
    payload = (await request.body()).decode("utf-8", errors="replace")
    argv = [sys.executable, str(GATEWAY), event, "--adapter", "dsh"]
    return await run_in_threadpool(_run, argv, payload, _child_env(), HOOK_TIMEOUT_S)


if DIST.is_dir():
    # 挂在 / 上，html=True 会把 / 交给 index.html；前端用相对路径请求 api，所以不用改代码。
    # 这条路由在 /api 之后匹配，不会挡住接口。
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
else:
    @app.get("/", response_class=HTMLResponse)
    async def _missing_frontend() -> str:
        return (
            "<h1>Horon 控制台前端还没构建</h1>"
            f"<p>请在 <code>{ROOT / 'web'}</code> 下运行 "
            "<code>npm install &amp;&amp; npm run build</code>。</p>"
            '<p>接口本身已经在 <a href="api/sessions">api/sessions</a> 可用。</p>'
        )
