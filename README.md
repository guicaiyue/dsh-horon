# dsh-horon

把 [Horon](https://github.com/guicaiyue) 记忆图谱接进 **DeepSeek Harness（dsh）** 的插件：一个包同时提供宿主侧（`horon` 工具、生命周期钩子、控制台反向代理、设置页接口）和客户端侧（侧栏面板、设置页区块）。

> 本仓库原名 `horon-web`（包名 `@local/horon-web`），2026-11-06 改名为 `dsh-horon`。改名只改插件的标识、路由和包名；`horon` 工具名与 `horon-cli` / `horon-circuit` / `horon-plugin` 三个 skill 保持不变，已有记忆里的调用方式不受影响。

## 它做了什么

一行 loader 配置（`dsh-horon`）挂四件事：

1. **`horon` 工具**（`harness.js`）—— 参数就是 Horon CLI 的参数列表，等价于在 Horon 仓库根目录跑 `python frontend/cli.py <args>`。命令和开关写在 `horon-cli` skill 里，这里不重复一遍 schema。
2. **生命周期钩子** —— dsh 事件转成 Horon 的 `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`。**这里带的是通道，不是规则**：工具拦不拦由 Horon 库里的 guard 电路决定，见下面「拦截（guard）随安装生效吗」。
3. **控制台**（`index.js` + `client.js`）—— dsh web 服务器上的 `/dsh-horon/` 反向代理，把 Horon 控制台塞进侧栏 iframe；它和 dsh 自己的路由走同一道 Host/Origin + 登录栅栏，所以跨机器打开 dsh 也能用。`/dsh-horon/_dsh/*` 是设置页用的状态、配置、预览、部署、日志接口。
4. **skills 注册**（可选）—— 宿主读不到 Horon 仓库时（docker / url 模式），从本包的 `skills/` 注册 `horon-cli` / `horon-circuit` / `horon-plugin`。

## 三种服务运行方式

`config.mode` 决定 Horon 服务从哪来（不写 `mode` 时：有 `url` 就是 `url`，否则 `spawn`）：

| mode | 做法 | 关键配置 |
| --- | --- | --- |
| `spawn` | 插件自己拉起一个 `python -m uvicorn horon_web_app:app`，插件卸载时跟着退出 | `root`、`python`、`host`、`port` |
| `docker` | 服务是本机 Docker 容器；插件不创建容器，`autostart` 只负责 `docker start` | `dataDir`、`dbFile`、`envFile`、`tagPluginsDir`、`dockerBind`、`dockerPort`、`image`、`container`、`buildProxy` |
| `url` | 服务跑在别处，插件只记地址，不启动也不部署 | `url` |

服务本身没有鉴权，默认只绑回环地址；要跨机器用请自行加一层可信网络。

## 安装

插件走 dsh profile 的 `link:` 依赖，不进 npm：

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

然后在 profile 的 `cordis.patch.yml` 里给这一行写配置（设置页「设置 → Horon 服务」写的是同一个位置）：

```yaml
- id: dsh-horon
  name: 'dsh-horon'
  config:
    mode: docker
    autostart: true
    hooks: true
    dbFile: '~/.horon/horon.db'
    envFile: '~/.horon/docker/.env'
```

改完 profile 配置 dsh 会热重载；改本仓库的宿主侧代码（`index.js` / `harness.js` / `docker.js`）需要重启 dsh。

`root` 和 `python` 可以完全不写：默认 `~/horon`，解释器默认取 `<root>/.venv/...`（Windows 是 `.venv\Scripts\python.exe`，其它平台是 `.venv/bin/python`），没有 venv 才退回 PATH 上的 `python`。换机器克隆下来不用改配置就能跑 spawn 模式。

## 拦截（guard）随安装生效吗

**不。装上的是通道，不是策略。**

- 插件这一侧（`harness.js` 的 `tools/pre-execute`）只做一件事：把每次工具调用的名字和参数交给 Horon 的 `PreToolUse`，Horon 回 `deny` 才拦。
- 拦不拦由**数据库**决定：`tool_guards` 表里的规则（`tool` 正则 + `args_pattern` + `adapter`）指向一个 `guard` 概念，guard 的输入电路通电才放行，未通电或被抑制就拦。这些行是使用者在自己的库里一条条 `set <guard> tool_guard ...` 建出来的，**不在代码里、也不随包发布**。
- 同类还有两件也不随包走：个人 tag 插件（写时门禁，如「记忆入库」）放在 `tagPluginsDir`，`docker/build.mjs` 的白名单只带 `state.py / action.py / result.py / exit.py` 四个系统插件；`docker/context/` 和任何 `*.db` 也不进 git。
- 所以别人装完的默认状态是：hooks 开着，每次工具调用都问一次 Horon，库里没有规则 → `guard()` 直接放行，**零拦截**。工具名还是 dsh 的原样（`pwsh`、`edit`、`read`、`horon`），照着 Claude Code 写的规则在这里不匹配。

**想让规则跟着走**，把库里的东西显式带过去（读 `horon-circuit` / `horon-plugin` 说明书）：

```bash
horon list_concepts | grep -E '\((guard|logic|sensor)'   # 看这个库里到底有几条电路
horon read_hook <guard 名或 ID>                            # 看它的 tool_guard 规则、on_fire 文本
horon set <guard 名> tool_guard 'pwsh' --args-pattern 'git\s+push'   # 在目标库里重建同一条规则
```

电路之间的依赖（`AND` / `OR` / `CHAIN` / 抑制边）不会被一条 `tool_guard` 带过来，得按 `compile --target <guard>` 的依赖树逐个补；`docker/build.mjs` 也不复制 `tag_plugins` 里的个人插件，需要就手工拷进 `tagPluginsDir`。

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
index.js          宿主侧入口：三种模式的服务生命周期、/dsh-horon/ 路由与设置页接口
harness.js        horon 工具、记忆策略提示词段落、dsh 生命周期钩子（含工具门禁通道）
docker.js         docker 模式的配置解析、compose/Dockerfile 渲染、部署与日志
test/host-smoke.mjs  宿主侧冒烟测试（假 cordis 上下文，不需要 dsh：node test/host-smoke.mjs）
client.js         客户端 bundle：侧栏面板 + 设置页区块（window.__ModuleLoader__ 工厂壳）
cordis.patch.yml  本包自带的 loader 行（id/name/config 默认值）
horon_web_app.py  容器/本机进程里的 FastAPI 入口：/api 路由 + 打包好的前端
locale/           zh/en 文案
skills/           horon-cli / horon-circuit / horon-plugin 说明书（构建时同步）
docker/           Dockerfile、compose、入口脚本、构建上下文生成器
```

## 构建 Docker 镜像

`docker/context/` 是按白名单从 Horon 仓库复制出来的构建上下文（不含 `.env`、数据库、venv、个人 tag 插件），**不进 git**，克隆后先生成：

```bash
node docker/build.mjs <Horon 仓库路径>     # 默认取 HORON_REPO 或 ~/horon
docker compose -f docker/docker-compose.yml up -d --build
```

同一条命令顺带刷新 `skills/`。设置页里的一键部署生成的就是同一份 compose 和命令。

## 配置项一览

| key | 默认 | 说明 |
| --- | --- | --- |
| `mode` | 由 `url` 推断，否则 `spawn` | `spawn` / `docker` / `url` |
| `url` | — | 运行中的 Horon 服务地址，例如 `http://127.0.0.1:8710` |
| `root` | `~/horon` | Horon 仓库根目录（`.env`、`web/dist`、`.agents/skills`） |
| `python` | `<root>/.venv/...`，没有 venv 时 `python` | 带 fastapi + uvicorn 的解释器（Horon 的 venv） |
| `host` / `port` | `127.0.0.1` / `8710` | spawn 模式的绑定地址 |
| `autostart` | `true` | `false` 只挂插件，不拉起服务/容器 |
| `hooks` | `true` | `false` 只留 `horon` 工具，不挂钩子（也可用环境变量 `HORON_HOOKS=off`） |
| `skills` | spawn 模式外默认开 | 是否注册三个 horon skill |
| `dataDir` | `~/.horon/docker` | docker 模式下宿主机数据目录的根 |
| `dbFile` | `<dataDir>/data/horon.db` | SQLite 库；所在目录挂到容器 `/data` |
| `envFile` | `<dataDir>/.env` | API key / 代理；缺失时从 `docker/env.example` 复制 |
| `tagPluginsDir` | `<dataDir>/tag_plugins` | tag 插件目录 |
| `dockerBind` / `dockerPort` | `127.0.0.1` / `8710` | 容器发布地址 |
| `image` / `container` | `horon-service:local` / `horon` | 镜像与容器名 |
| `buildProxy` | — | 构建时给 `BUILD_PROXY` 的代理（构建网络内可达） |

## License

MIT
