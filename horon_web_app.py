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

import asyncio
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from contextlib import asynccontextmanager, closing
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


def _hook_rules(db_path: Path) -> dict:
    """每条 sensor_hook / tool_guard 的近况：命中次数、点火次数、最后一次时间。

    read_hook 在 CLI 里逐条打印这些数字，但要在终端里翻；面板要的是一张表。
    数字来自 backend/hook_hits.py 记在 cli_audit_log 的行，口径与 read_hook 完全一致。
    连接在这个函数里开：sqlite3 的连接不能跨线程用，而它整个跑在线程池里。
    """
    import sqlite3

    from backend.hook_hits import HIT_WINDOW_DAYS, hit_summary, quiet_sensor_report

    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        conn.row_factory = sqlite3.Row
        rows = []
        for r in conn.execute(
            "SELECT c.id, c.name, h.event_type, h.tool, h.adapter, h.created_at, h.jev_question "
            "FROM sensor_hooks h JOIN concepts c ON c.id = h.sensor_concept_id ORDER BY c.id"):
            kind = 'sensor_jev' if r["jev_question"] else 'sensor'
            rows.append({
                'id': r["id"], 'name': r["name"], 'kind': 'sensor_hook', 'event': r["event_type"],
                'tool': r["tool"], 'adapter': r["adapter"], 'setAt': r["created_at"],
                'summary': hit_summary(conn, r["id"], r["created_at"], kind),
            })
        for r in conn.execute(
            "SELECT c.id, c.name, g.tool, g.adapter, g.created_at "
            "FROM tool_guards g JOIN concepts c ON c.id = g.guard_concept_id ORDER BY c.id"):
            rows.append({
                'id': r["id"], 'name': r["name"], 'kind': 'tool_guard', 'event': None,
                'tool': r["tool"], 'adapter': r["adapter"], 'setAt': r["created_at"],
                'summary': hit_summary(conn, r["id"], r["created_at"], 'tool_guard'),
            })
        quiet = quiet_sensor_report(conn)
        return {
            'windowDays': HIT_WINDOW_DAYS,
            'rules': rows,
            # 设下满 N 天一次没点火、或以前点过火但很久没再点的传感器；守卫不在里面（见 hook_hits 的说明）。
            'quiet': quiet,
            # 同一份报告里的节点 id，供界面标黄；报告本身是给人读的，别让前端去解析文字。
            'quietIds': [int(m) for m in re.findall(r"\[(\d+)\]", quiet or "")],
        }


@app.get("/api/hooks")
async def get_hooks() -> dict:
    """传感器与守卫的命中统计，给 dsh 面板用；没有库或没升级到带 hook_hits 的版本时给空表。"""
    if _db_path is None or not _db_path.exists():
        return {'windowDays': 0, 'rules': [], 'quiet': None, 'reason': 'no database yet'}
    try:
        return await run_in_threadpool(_hook_rules, _db_path)
    except Exception as e:  # 旧版本没有 hook_hits 模块、或表结构不同：面板显示原因，不报 500
        return {'windowDays': 0, 'rules': [], 'quiet': None, 'reason': str(e)}


# ---- 重建书腰向量 ---------------------------------------------------------------------------
# 换嵌入模型之后必须重建：不同模型的向量维度相同但语义空间不同，混在一张表里检索会返回
# 看似正常实则错误的结果。`integrity.stale_embeddings` 已经把「模型不匹配」算进待重建集合，
# 所以这里只要把它跑完即可。重建按批进行，节点多时几分钟，因此放到后台线程并用一个状态对象
# 汇报进度，界面轮询 /api/embeddings/rebuild。

_embed_job: dict = {'running': False, 'total': 0, 'written': 0, 'failed': 0, 'startedAt': None,
                    'finishedAt': None, 'ok': None, 'error': None, 'model': None}


def _embedding_status(db_path: Path) -> dict:
    """库里的向量现状：用了哪个模型、有多少节点缺向量、重建任务跑到哪了。"""
    import sqlite3

    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
        models = [r[0] for r in conn.execute(
            "SELECT DISTINCT embedding_model FROM concept_embeddings WHERE embedding_model IS NOT NULL")]
        covered = conn.execute("SELECT COUNT(*) FROM concept_embeddings").fetchone()[0]
        total = conn.execute(
            "SELECT COUNT(*) FROM concepts WHERE when_to_read IS NOT NULL AND when_to_read != ''").fetchone()[0]
    return {**_embed_job, 'models': models, 'covered': covered, 'nodes': total,
            'missing': max(total - covered, 0)}


def _run_rebuild(db_path: Path) -> None:
    """把 stale_embeddings 跑完，边跑边更新 _embed_job。跑在线程池里。"""
    from backend.db import HoronDB
    from backend.integrity import iter_repair_embeddings, stale_embeddings
    from backend.llm import EMBEDDING_MODEL

    db = None
    try:
        db = HoronDB(db_path=db_path, session_id=OFFLINE_DEV_SESSION_ID)
        _embed_job['total'] = len(stale_embeddings(db))
        _embed_job['model'] = EMBEDDING_MODEL
        for batch in iter_repair_embeddings(db):
            _embed_job['written'] += batch.written
            _embed_job['failed'] += batch.failed
        _embed_job['ok'] = _embed_job['failed'] == 0
    except Exception as e:  # 缺密钥、网络、模型不存在：都记在状态里给界面看
        _embed_job['ok'] = False
        _embed_job['error'] = str(e)
    finally:
        _embed_job['running'] = False
        _embed_job['finishedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        if db is not None:
            db.close()


@app.get("/api/embeddings")
async def get_embeddings() -> dict:
    """向量现状与重建进度。没有库时给空状态而不是 500。"""
    if _db_path is None or not _db_path.exists():
        return {**_embed_job, 'models': [], 'covered': 0, 'nodes': 0, 'missing': 0, 'reason': 'no database yet'}
    try:
        return await run_in_threadpool(_embedding_status, _db_path)
    except Exception as e:
        return {**_embed_job, 'models': [], 'covered': 0, 'nodes': 0, 'missing': 0, 'reason': str(e)}


@app.post("/api/embeddings/rebuild")
async def rebuild_embeddings() -> dict:
    """按当前嵌入模型重建全部书腰向量。已经在跑就返回现有进度，不排队第二次。"""
    if _db_path is None or not _db_path.exists():
        raise HTTPException(status_code=409, detail="no database yet")
    if _embed_job['running']:
        return {'started': False, **_embed_job}
    _embed_job.update(running=True, total=0, written=0, failed=0, ok=None, error=None,
                      startedAt=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                      finishedAt=None)
    asyncio.create_task(run_in_threadpool(_run_rebuild, _db_path))
    return {'started': True, **_embed_job}


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
