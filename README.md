# dsh-horon

把 [Horon](https://github.com/Dataojitori/horon) 记忆图谱接进 **DeepSeek Harness（dsh）** 的插件：一个包同时提供宿主侧（`horon` 工具、生命周期钩子、控制台反向代理、设置页接口）和客户端侧（侧栏面板、设置页区块）。

> 本仓库原名 `horon-web`（包名 `@local/horon-web`），2026-11-06 改名为 `dsh-horon`。改名只改插件的标识、路由和包名；`horon` 工具名与 `horon-cli` / `horon-circuit` / `horon-plugin` 三个 skill 保持不变，已有记忆里的调用方式不受影响。

## 它做了什么

一行 loader 配置（`dsh-horon`）挂四件事：

1. **`horon` 工具**（`harness.js`）—— 参数就是 Horon CLI 的参数列表，等价于在 Horon 仓库根目录跑 `python frontend/cli.py <args>`。命令和开关写在 `horon-cli` skill 里，这里不重复一遍 schema。
2. **生命周期钩子** —— dsh 事件转成 Horon 的 `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`。**这里带的是通道，不是规则**：工具拦不拦由 Horon 库里的 guard 电路决定，见下面「拦截（guard）随安装生效吗」。
3. **控制台**（`index.js` + `client.js`）—— dsh web 服务器上的 `/dsh-horon/` 反向代理，把 Horon 控制台塞进侧栏 iframe；它和 dsh 自己的路由走同一道 Host/Origin + 登录栅栏，所以跨机器打开 dsh 也能用。`/dsh-horon/_dsh/*` 是设置页用的状态、配置、预览、部署、日志接口。
4. **skills 注册**（可选）—— 宿主读不到 Horon 仓库时（`artifact` / `docker` / `url` 模式），从本包的 `skills/` 注册 `horon-cli` / `horon-circuit` / `horon-plugin`；`artifact` 模式解包后也有 `app/.agents/skills`，两处内容同源（都来自锁定的 commit）。

## 四种服务运行方式

`config.mode` 决定 Horon 服务从哪来（不写 `mode` 时：有 `url` 就是 `url`，否则 `spawn`）：

| mode | 做法 | 关键配置 |
| --- | --- | --- |
| `artifact` | **推荐**。按 `horon.lock.json` 下载 CI 发布的构建物（后端 + 打包好的控制台 + 依赖轮子），校验 sha256、解包、离线装运行时，再当本机进程跑。不需要 Horon 仓库，也不需要 git / npm / Docker，只要 Python 3.12 | `artifactDir`、`artifactUrl`、`dataDir` |
| `docker` | **推荐**。服务是本机上的容器，镜像由 CI 按同一个 commit 构建并推到 Docker Hub；插件只 `docker pull`，不构建 | `dataDir`、`dbFile`、`envFile`、`tagPluginsDir`、`dockerBind`、`dockerPort`、`image`、`container` |
| `spawn` | 开发用。插件自己拉起本机克隆里的 `python -m uvicorn horon_web_app:app` | `root`、`python`、`host`、`port` |
| `url` | 服务跑在别处，插件只记地址，不启动也不部署 | `url` |

`artifact` 与 `docker` 共用 `dataDir`（默认 `~/.horon/docker`）：数据库、`.env`、tag 插件都在那里，所以换方式、换版本都不丢记忆；构建物按 `<commit8>-<platform>` 解包，回滚就是把锁文件的 commit 改回去。

服务本身没有鉴权，默认只绑回环地址；要跨机器用请自行加一层可信网络。

**首次安装没有 `mode`**：插件不启动任何东西，Horon 面板会先问「下载构建物 / 拉取 Docker 镜像」。
本机已有 `~/horon` 克隆的机器视为已选择 `spawn`，升级不会被重新询问。

## 安装

上架后走市场或 npm：

```bash
dsh plugin add dsh-horon        # 或在 Web 插件市场里点安装
```

开发时仍可挂本地目录（`link:` 依赖，不进 npm）：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-horon": "link:D:/projects/blog/dsh-plugins/dsh-horon"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-horon"]   // 必须列出，才会作为 bundle 加载
    }
  }
}
```

`cordis.patch.yml` 里这一行不必写 `mode`（面板会问）；想直接定死就写（设置页「设置 → Horon 服务」写的是同一个位置）：

```yaml
- id: dsh-horon
  name: 'dsh-horon'
  config:
    mode: artifact      # 或 docker / spawn / url
    autostart: true
    hooks: true
```

改完 profile 配置 dsh 会热重载；改本仓库的宿主侧代码（`index.js` / `harness.js` / `docker.js` / `artifact.js`）需要重启 dsh。

`artifact` 模式下的 `root` / `python` 不用写：解包目录和它自己的 venv 由插件决定。
`spawn` 模式的 `root` 默认 `~/horon`，解释器默认取 `<root>/.venv/...`。

## 拦截（guard）随安装生效吗

**不。装上的是通道，不是策略。**

- 插件这一侧（`harness.js` 的 `tools/pre-execute`）只做一件事：把每次工具调用的名字和参数交给 Horon 的 `PreToolUse`，Horon 回 `deny` 才拦。
- 拦不拦由**数据库**决定：`tool_guards` 表里的规则（`tool` 正则 + `args_pattern` + `adapter`）指向一个 `guard` 概念，guard 的输入电路通电才放行，未通电或被抑制就拦。这些行是使用者在自己的库里一条条 `set <guard> tool_guard ...` 建出来的，**不在代码里、也不随包发布**。
- 同类还有两件也不随包走：个人 tag 插件（写时门禁，如「记忆入库」）放在 `tagPluginsDir`，组装器（`scripts/assemble.mjs`）的白名单只带 `state.py / action.py / result.py / exit.py` 四个系统插件；任何 `*.db` 也不进 git、不进镜像、不进构建物。
- 所以别人装完的默认状态是：hooks 开着，每次工具调用都问一次 Horon，库里没有规则 → `guard()` 直接放行，**零拦截**。工具名还是 dsh 的原样（`pwsh`、`edit`、`read`、`horon`），照着 Claude Code 写的规则在这里不匹配。

**想让规则跟着走**，把库里的东西显式带过去（读 `horon-circuit` / `horon-plugin` 说明书）：

```bash
horon list_concepts | grep -E '\((guard|logic|sensor)'   # 看这个库里到底有几条电路
horon read_hook <guard 名或 ID>                            # 看它的 tool_guard 规则、on_fire 文本
horon set <guard 名> tool_guard 'pwsh' --args-pattern 'git\s+push'   # 在目标库里重建同一条规则
```

电路之间的依赖（`AND` / `OR` / `CHAIN` / 抑制边）不会被一条 `tool_guard` 带过来，得按 `compile --target <guard>` 的依赖树逐个补；组装器也不复制 `tag_plugins` 里的个人插件，需要就手工拷进 `tagPluginsDir`（构建物模式下是 `<artifactDir>/<commit8>-<platform>/app/backend/tag_plugins`）。

**怎么当场确认它在不在跑**：设置页「Horon 服务」那行现在多一个「拦截链」读数——`已挂载 · 本次共拒绝 N · 网关失败 M`，鼠标悬停看说明；`/dsh-horon/_dsh/status` 的 `hooks` 字段是同一份数据。

**唯一无条件生效的**是系统提示里那段记忆策略（`MEMORY_POLICY`，`harness.js`，主会话注入、子代理不注入），它管的是「怎么写记忆」，不拦工具。

拦截链是 **fail-open** 的：Horon 服务不可达时插件不会卡住工具（否则一次服务崩溃就把 dsh 锁死），但会把这次会话标记为降级，在会话里播一条「拦截链未生效」的 banner 并计入上面的「网关失败」，不让「没拦」被误读成「规则放行」。

### 从 horon-web 迁移

1. 目录 `horon-web/` → `dsh-horon/`，包名 `@local/horon-web` → `dsh-horon`。
2. profile `package.json`：依赖键和 `bundles` 里的 `@local/horon-web` 换成 `dsh-horon`，重装一次 `link:`。
3. profile `cordis.patch.yml`：`- id: horon-web` 那一行改成 `- id: dsh-horon`，`name` 改成 `'dsh-horon'`（`config` 整段照抄）。
4. 控制台路由从 `/horon-web/` 变成 `/dsh-horon/`，旧书签失效。

## 目录结构

```
index.js          宿主侧入口：四种模式的服务生命周期、/dsh-horon/ 路由与设置页接口
harness.js        horon 工具、记忆策略提示词段落、dsh 生命周期钩子（含工具门禁通道）
artifact.js       构建物模式：下载 → 校验 sha256 → 解包 → bootstrap → 交给同一个 spawn 路径
docker.js         docker 模式的配置解析、compose/命令渲染、pull + run 部署与日志
horon.lock.json   唯一事实源：锁定 commit、镜像名与 tag、构建物 URL 与期望摘要
scripts/assemble.mjs 组装器：从一个 Horon 检出生成镜像上下文或某平台的构建物（CI 与本地共用）
scripts/bootstrap.py 构建物内的运行时安装器：建 venv + 离线装轮子（幂等）
test/host-smoke.mjs  宿主侧冒烟测试（假 cordis 上下文，不需要 dsh：node test/host-smoke.mjs）
test/artifact-smoke.mjs  构建物端到端冒烟：本地起静态服务 → 下载 → 安装 → 起服务 → 打两个接口
client.js         客户端 bundle：侧栏面板（含首次选择运行方式的引导）+ 设置页区块
cordis.patch.yml  本包自带的 loader 行（id/name/config 默认值，不带 mode）
horon_web_app.py  容器/本机进程里的 FastAPI 入口：/api 路由 + 打包好的前端
locale/           zh/en 文案
skills/           三份说明书；git 忽略，发布前由组装器从锁定 commit 同步
docker/           Dockerfile（按 SHA 自取源库）、入口脚本、锁定依赖、compose
docs/deployment.md  发布链路、构建物内容与升级流程
```

## 发布与部署（维护者）

用户不克隆源库、不构建：`artifact` 模式下载 GitHub Release 里的构建物，`docker` 模式拉 Docker Hub
上的镜像，两者都由 CI 从 `horon.lock.json` 里锁定的同一个 commit 生成。

```bash
# 本地先自检（等价于 CI 做的事）
node scripts/assemble.mjs --repo ~/horon --out .build/a2 --platform win-x64 --wheels
node test/host-smoke.mjs && node test/artifact-smoke.mjs      # 只跑纯函数检查
```

完整链路（镜像工作流、构建物工作流、npm 发布、升级步骤、许可义务）见 [docs/deployment.md](docs/deployment.md)。

## 配置项一览

| key | 默认 | 说明 |
| --- | --- | --- |
| `mode` | 由 `url` 推断，否则 `spawn`（首次安装面板会问） | `artifact` / `docker` / `spawn` / `url` |
| `url` | — | 运行中的 Horon 服务地址，例如 `http://127.0.0.1:8710` |
| `artifactDir` | `~/.horon/runtime` | 构建物解包目录，每个版本一个 `<commit8>-<platform>` 子目录 |
| `artifactUrl` / `artifactBaseUrl` / `artifactSha256` | 取自 `horon.lock.json` | 换镜像站或本地路径时用；后两者一般不用写 |
| `horonCommit` | `horon.lock.json` 的 commit | 临时钉到别的上游 commit（高级） |
| `root` | `~/horon` | `spawn` 模式的 Horon 仓库根目录 |
| `python` | `<root>/.venv/...`，没有 venv 时 `python` | 解释器；`artifact` 模式下是 bootstrap 的基础解释器 |
| `host` / `port` | `127.0.0.1` / `8710` | `artifact` / `spawn` 模式的绑定地址 |
| `autostart` | `true` | `false` 只挂插件，不拉起服务/容器 |
| `hooks` | `true` | `false` 只留 `horon` 工具，不挂钩子（也可用环境变量 `HORON_HOOKS=off`） |
| `skills` | `spawn` / `artifact` 模式外默认开 | 是否注册三个 horon skill |
| `dataDir` | `~/.horon/docker` | `artifact` 与 `docker` 共用的宿主数据目录（库、`.env`、tag 插件） |
| `dbFile` | `<dataDir>/data/horon.db` | SQLite 库；`docker` 模式挂到容器 `/data`，`artifact` 模式写进 `app/.env` 的 `HORON_DB`。从 docker 切过来时**显式写这一行**，否则会指向另一个库 |
| `envFile` | `<dataDir>/.env` | API key / 代理；`docker` 模式缺失时从 `docker/env.example` 复制，`artifact` 模式作为 `app/.env` 的种子（`HORON_DB` 由 `dbFile` 覆盖） |
| `tagPluginsDir` | `<dataDir>/tag_plugins` | tag 插件目录（`docker` 模式挂到 `/app/backend/tag_plugins`） |
| `dockerBind` / `dockerPort` | `127.0.0.1` / `8710` | 容器发布地址 |
| `image` / `container` | `<horon.lock.json image>` / `horon` | 镜像与容器名 |

## License

插件本身 MIT。它下载的 Horon 服务是 Apache-2.0 **加一条附加条件**：向组织以外的人提供产品或服务
时必须显眼展示

```
This product uses Horon (https://github.com/Dataojitori/horon)
```

镜像与构建物里带 `app/NOTICE`，别删。
