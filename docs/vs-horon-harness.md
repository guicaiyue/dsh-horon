# dsh-horon 与上游自带插件 horon-harness 的分工

> 取证：本仓库 `main` @ `b77d95c`（2026-11-27），上游 `Dataojitori/horon` @ `b098914`，
> `backend/harness/dsh-plugin/` 与根 `package.json`（`horon-harness@0.1.0`）。
> 上游这份插件是 2026-11-17 随 `416efea` / `1a4640d` 进仓库的。

## 一句话

上游的 `horon-harness` 是**宿主适配层**：让 `horon` 工具和钩子在没有仓库、没有 Python 的机器上也能跑起来。
本仓库的 `dsh-horon` 是**带运行时的发行版**：把 Horon 当服务管起来（固定 commit 的构建物或镜像）、提供控制台与设置页、附带技能与 tag 插件。

两者不是版本关系，是职责不同。**不要同时装**：两边都 `insert` 一行、都注册名为 `horon` 的工具，行 id 虽然不同（`horon` / `dsh-horon`），工具名会撞。

## 事实对比

| 维度 | `dsh-horon` 1.4.0（本仓库） | `horon-harness` 0.1.0（上游） |
| --- | --- | --- |
| 行 id / 工具名 | `dsh-horon` / `horon` | `horon` / `horon` |
| 配置 schema | 裸对象 + `settings()` 手写解析 | schemastery `Config`（`.volatile()`、`role('credential-ref')`） |
| Python 从哪来 | `artifact`：CI 构建物内置 venv（`bootstrap.py` 离线装轮子）；`docker`：镜像 | 插件自己下 uv 0.13.8，`uv venv --python 3.12`，`uv pip sync requirements.lock.txt`，全在 `~/.horon/runtime` |
| 依赖前提 | artifact 只需 Python 3.12；docker 只需 Docker | 只需联网；无 git / npm / Docker / 现成 Python |
| 运行形态 | 常驻服务（`horon_web_app.py` 提供 `/api/cli`、`/api/hook/{event}`、控制台前端），dsh 反代 `/dsh-horon/` | 无常驻服务：每次调用直接 spawn `frontend/cli.py` / `run_gateway.py`，不占端口 |
| 面板 | 侧栏面板 + 主区 iframe 控制台 + 设置页 | 只有设置页 |
| 设置页能力 | 运行时选择（构建物 / Docker）、数据目录、代理、部署进度与日志、重置 | 数据目录、开场提醒、子代理开关、两个 key |
| 密钥存放 | `<dataDir>/.env` 明文（容器与构建物共用） | dsh 凭据库（`credentials.set/unset`，可单独「移除 key」） |
| 云端记忆 | 不支持 | 支持 AISoulKeeper（`HORON_REMOTE_KEY`）+ 规则库本地缓存（`HORON_LOCAL_DIR`）+ 审计行上送 |
| 开场行为 | 自动跑 `login`，把 boot 节点注入上下文 | 发一条开场提醒，让模型自己跑 `login` 并整篇读手册 |
| 子代理 | 跳过 boot 注入与「先查再答」，工具与钩子仍生效 | 默认静音：从子会话隐藏 `horon` 工具，提醒与钩子全跳过 |
| 钩子映射 | 六个事件全映射，另有 Interrupt、先查再答 nudge、Stop 补查、拦截链降级横幅 | 六个事件全映射 |
| 额外能力 | skills provider（注册三本手册）、内置 tag 插件「记忆入库」、容器生命周期、构建物校验与回滚 | 无 |
| 发布 | 4 个 workflow（ci / image / publish / release）+ `horon.lock.json` 单一事实源 + npm 市场条目 | 仓库根 `package.json` 即 bundle，无独立发布物与 lock |
| 许可 | Apache-2.0 + 附加署名条件，产物带 `NOTICE`，README 与市场条目都写 | 同一份许可（`SEE LICENSE IN LICENSE`） |

## 各自多出来的东西

**只有本仓库有**：受控运行时（锁定 commit 的五平台构建物 / 镜像，可回滚）、控制台与侧栏面板、部署状态与日志、skills 注册、内置写时门禁 tag 插件、`/dsh-horon/_dsh/*` 设置页接口。

**只有上游有**：零依赖安装（uv 管 Python）、凭据库存 key、云端记忆与规则库同步、子代理默认静音、开场提醒（比自动注入省 token）。

## 选型判据

- 想在一个已经有 Python 的机器上最快接上记忆与钩子，且不介意 key 落在凭据库、记忆走云端 → 上游 `horon-harness`。
- 要给多台机器统一版本、要控制台、要固定 commit 可回滚、要 docker、要凭据以外的 `.env` 部署（容器场景） → 本仓库 `dsh-horon`。
- 已经装了 `dsh-horon`：不要装 `horon-harness`，反过来也一样。切换前先在插件页卸载对方。

## 本仓库该吸收 / 不该吸收

值得吸收（按收益）：

1. **凭据库存 key**：`role('credential-ref')` + `credentials.set/unset`，替代 `<dataDir>/.env` 明文。容器场景仍要 `.env`，所以是「两处可选」而不是替换。
2. **子代理静音开关**：`subagents` 默认 false，隐藏工具 + 跳过钩子，与本仓库已有的 `isChild()` 跳过逻辑合并。
3. **`HORON_LOCAL_DIR`**：本仓库 docker 模式靠把 `~/.horon/docker/local` 挂到 `/app/.horon-local` 持久化规则库，artifact 模式则落在解包目录里——升级解包会带走未送出的审计行。显式设到 `<dataDir>/local` 更稳。
4. **云端模式**：只有在真要接 AISoulKeeper 时才做；它同时要求上游服务端支持 `audit_rows` 上送。

不该吸收：

- **uv 自管 Python**：与本仓库的构建物重复，多养一条安装路径；要覆盖「CI 还没出包」的窗口才值得。
- **用提醒代替自动 login**：本仓库的 boot 注入是有意的（模型不会漏跑），代价是每会话多几 KB。

## 换上游 commit 时的连带项

`backend/harness/dsh-plugin/` 在 `scripts/assemble.mjs` 里被显式排除——构建物不带上游那份插件，两者不会互相覆盖。上游改这个目录时，需要跟的是 `run_gateway.py`、`backend/harness/adapters/`、`backend/hook_gateway.py` 的协议，不是它。
