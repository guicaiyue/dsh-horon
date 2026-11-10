# 部署方式：用户不碰源库、不构建

dsh-horon 把 Horon 服务当成**已发布的产物**来取用，而不是让用户克隆源库、装 venv、构建前端。
两种受管方式，产物都由 CI 从同一个锁定 commit 生成：

| 方式 | 用户侧前置 | 取什么 | 数据目录 |
| --- | --- | --- | --- |
| `artifact` | Python 3.12 | GitHub Release 里的 `horon-app-<platform>-<commit8>.tar.gz` | `~/.horon/docker` |
| `docker` | Docker | Docker Hub 上 `<image.name>:<tag>` | `~/.horon/docker` |
| `spawn` | 本机 Horon 克隆 | 直接跑 `root/frontend/cli.py`（开发用） | 克隆目录 |
| `url` | 一个跑着的服务 | 只记地址 | — |

`artifact` 与 `docker` 共用同一个数据目录，所以随时换方式、换版本都不会丢记忆库；
`artifact` 的每个版本解包到 `~/.horon/runtime/<commit8>-<platform>/`，回滚就是把
`horon.lock.json` 的 commit 改回去。

## 唯一事实源：`horon.lock.json`

```jsonc
{
  "horon":    { "repo": "…", "branch": "master", "commit": "<40 位 SHA>" },
  "image":    { "name": "<命名空间>/horon-service", "tag": "1.0.0", "digest": "" },
  "artifact": { "release": "horon-<commit8>", "baseUrl": "…/releases/download/horon-<commit8>",
                "asset": "horon-app-{platform}-<commit8>.tar.gz", "sha256": { "win-x64": "…" } },
  "platforms": ["win-x64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]
}
```

插件在运行时读它：默认镜像名、构建物 URL、期望的 sha256 都来自这里。**运行时不联网查版本**，
也不会自动升级——升级是一次锁文件改动 + 一次发布。

## CI 三段

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| `.github/workflows/image.yml` | `horon.lock.json` / `docker/**` 变更 | 多架构镜像推 Docker Hub，然后拉下来跑 `/api/cli` 与 `/api/hook/Stop` 的契约冒烟 |
| `.github/workflows/release.yml` | `horon.lock.json` / `scripts/**` 变更 | 五个平台的 `horon-app-*.tar.gz` + `.sha256`，发 GitHub Release，并把 sha256 汇总到 job summary |
| `.github/workflows/publish.yml` | 推 `v*` 标签 | 从锁定 commit 同步 `skills/` 后 `npm publish`（带 provenance） |

三段都不在插件仓库里存源库代码：`release` 与 `image` 都用 `actions/checkout` 或
`git fetch --depth 1 origin <SHA>` 把锁定 commit 取进构建环境。`scripts/assemble.mjs` 是唯一的
组装器，镜像和构建物因此看到同一棵树。

## 构建物里有什么

```
horon-app-<platform>-<commit8>.tar.gz
  manifest.json             plugin 版本、horon commit、平台、文件数
  app/                      HORON_ROOT
    backend/  frontend/  .agents/skills/{horon-cli,horon-circuit,horon-plugin}
    horon_web_app.py        /api/cli 与 /api/hook/* 的桥（跟插件版本走）
    run_gateway.py  requirements.txt  LICENSE  NOTICE  opencode.json
    web/dist/               打包好的控制台
  wheels/                   该平台的 python 轮子（离线安装用）
  requirements.lock.txt     锁定的依赖版本
  bootstrap.py              建 venv + 离线装依赖 + 写 .ready.json
```

`bootstrap.py` 是幂等的：第二次启动只看 `.ready.json` 的指纹就跳过。没有 `venv` 模块的机器
（某些精简 Debian）会退到 `app/vendor`，插件把该目录放进 `PYTHONPATH`。

平台要求：`wheels/` 按平台预下（Windows x64、Linux x64/arm64、macOS x64/arm64）。Linux 包里的
numpy 只提供 `manylinux_2_28` 轮子，所以 Linux 构建物要求 **glibc ≥ 2.28**（Debian 10+ /
Ubuntu 20.04+ / 主流发行版）；Python 3.12 本身已经隐含这个下限。`pip download` 一旦指定
`--platform` 就不再走兼容列表，因此每个平台都得把可接受的标签列全，否则会出现「某个包突然
找不到匹配版本」。

## 插件侧执行顺序

1. 挂载时若 `mode` 为空且本机没有 `~/horon` 克隆 → **不启动任何东西**，面板显示「先选一种运行方式」。
2. 选 `artifact`：`POST /dsh-horon/_dsh/provision` → 下载 → 校验 sha256 → 解包 → bootstrap；
   日志走 `/provision-log`，与 docker 部署的日志同一个查看器。
3. 选 `docker`：`POST /dsh-horon/_dsh/deploy` → `docker pull` → 替换同名容器 → 等 `/api/sessions` 就绪。
4. 保存 `mode` 会改写 profile patch 并重挂插件，重挂时 artifact 已就绪 → 直接 spawn。

## 升级流程（维护者）

```bash
# 1. 选新的上游 commit
git -C ~/horon fetch && git -C ~/horon log --oneline -5

# 2. 改 horon.lock.json 的 commit（release / baseUrl / asset 里的 {commit8} 会自动跟着变）
# 3. 本地先自检一遍再推
node scripts/assemble.mjs --repo ~/horon --out .build/artifact --platform win-x64 --wheels --build-web
node test/host-smoke.mjs
#   只想验证前端复制/目录布局时可以跳过 npm：--web-dist <已构建的 dist 目录>
# 4. 推 main：image 与 release 两个工作流分别出镜像与构建物
# 5. 把 release 汇总的 sha256 填回 horon.lock.json 的 artifact.sha256
# 6. 打标签发 npm：git tag v1.0.1 && git push origin v1.0.1
```

`docker/requirements.lock.txt` 是照上游 `.venv` 抄的固定版本；换 commit 时要重生成，
`image.yml` 的冒烟会替你把「装不上/起不来」挡在发布之前。

## 上架市场

市场索引是静态 JSON（例如 `awesome-dsh-plugin.com/plugins.json`），格式由
`@deepseek-ai/dsh-plugin-market-index` 校验：条目要给 `name`、`versions[]`（每个版本带
`registry` 版本号或固定提交的 `git+https`）、`engines.dsh`、以及中英文描述与分类。
**别手写这份 JSON**：先用 `parseMarketIndex` 校验，再提 PR 或让索引生成器跑一遍。
npm 已发布是前提——市场里点「安装」最终就是 `pnpm add <name>@<version>`。

`package.json` 这边要成立的条件：`private` 已去掉、`files` 只列运行时必需文件、
`engines.dsh` 覆盖目标版本。`npm pack --dry-run` 现在是 22 个文件 / 83 kB，构建上下文与上游源码都不在里面。

## 许可

上游 Horon 是 Apache-2.0 **加一条附加条件**：把它（或衍生作品）用在给组织以外的人使用的产品或
服务里，必须在显眼位置显示

```
This product uses Horon (https://github.com/Dataojitori/horon)
```

镜像与构建物都带 `app/NOTICE`；插件 README、npm 页面和市场条目也写了这句。分发镜像即触发该条件，
不要删。
