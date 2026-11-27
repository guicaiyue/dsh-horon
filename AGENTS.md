# AGENTS.md — dsh-horon

把 Horon 记忆图谱接进 DeepSeek Harness（dsh）的插件。宿主侧（`horon` 工具、生命周期钩子、控制台反代、设置页接口）+ 客户端侧（侧栏面板、设置页区块）。npm 包名 `dsh-horon`，上游是 `Dataojitori/horon`。

## 怎么跑

```bash
node --check index.js && node --check harness.js && node --check client.js   # 语法
node test/host-smoke.mjs                                                     # 宿主半边门禁（CI 跑这个）
node test/artifact-smoke.mjs --remote                                       # 构建物下载与校验（较慢）
npm pack --dry-run                                                           # 发布物清单，缺文件会在这里露出来
```

没有构建步骤：`index.js` / `harness.js` / `client.js` 就是发布物，`cordis.patch.yml` 被 dsh 当作 bundle patch 读。

## 技术栈

Node 22+ ESM（无打包器、无运行时依赖）；`client.js` 是 dsh 客户端插件的预打包脚本（`require` 由宿主注入）；服务端是 Python 3.12 + FastAPI（`horon_web_app.py`，上游 `backend/web_api.py` 的包装）；`docker/` 是镜像构建上下文。

## 目录与约定

- `horon.lock.json` 是**唯一事实源**：锁定的上游 commit、镜像 tag、五个平台的构建物名与 sha256。改它就会触发 CI 的镜像与构建物两条链路，不要手填 sha256。
- `skills/` 是**生成物**（`scripts/assemble.mjs --skills` 从锁定 commit 复制），不要手改；`.gitignore` 已列，但 git 索引里仍有旧副本（见「当前状态」）。
- `docker/requirements.lock.txt` 是构建物与镜像共用的依赖锁，换上游 commit 要重生成。
- 发布链路：`ci.yml`（语法 + lock + 市场条目 + 冒烟）、`release.yml`（五平台构建物）、`image.yml`（镜像 + 契约冒烟）、`publish.yml`（打 tag 时刷 skills 后 `npm publish`）。
- 上游 `backend/harness/dsh-plugin/` 被 `assemble.mjs` 排除：本仓库取代它，不要把两份插件混进同一份产物。

## 当前状态（2026-11-27）

- 锁定在上游 `1c62240`（11-09）；上游 HEAD 是 `b098914`（11-17，15 个 commit，无 DB 迁移）。升级清单见 `docs/deployment.md`。
- `harness.js` 的 MEMORY_POLICY 与工具描述已改成分词版 `search_keyword`（上游 11-15 改的语义），**尚未发版**。
- 与上游 npm 包 `horon-harness@0.1.0` 的关系、共存冲突与选型判据：`docs/vs-horon-harness.md`。
- 待办：`git rm -r --cached skills` 让生成物真的不被跟踪；`HORON_LOCAL_DIR` 在 artifact/spawn 模式下显式指向 `<dataDir>/local`；面板展示 `read_hook`/`audit` 的钩子命中统计（需先升到含 `hook_hits.py` 的 commit）。
