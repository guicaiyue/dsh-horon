# dsh-horon

把 [Horon](https://github.com/guicaiyue) 记忆图谱接进 **DeepSeek Harness（dsh）** 的插件：一个包同时提供宿主侧（`horon` 工具、生命周期钩子、控制台反向代理、设置页接口）和客户端侧（侧栏面板、设置页区块）。

> 本仓库原名 `horon-web`（包名 `@local/horon-web`），2026-11-06 改名为 `dsh-horon`。改名只改插件的标识、路由和包名；`horon` 工具名与 `horon-cli` / `horon-circuit` / `horon-plugin` 三个 skill 保持不变，已有记忆里的调用方式不受影响。

## 它做了什么

一行 loader 配置（`dsh-horon`）挂四件事：

1. **`horon` 工具**（`harness.js`）—— 参数就是 Horon CLI 的参数列表，等价于在 Horon 仓库根目录跑 `python frontend/cli.py <args>`。命令和开关写在 `horon-cli` skill 里，这里不重复一遍 schema。
2. **生命周期钩子** —— dsh 事件转成 Horon 的 `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`，因此 Horon 的 tag 插件、sensor 和 guard（工具门禁）在 dsh 里同样生效。
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

### 从 horon-web 迁移

1. 目录 `horon-web/` → `dsh-horon/`，包名 `@local/horon-web` → `dsh-horon`。
2. profile `package.json`：依赖键和 `bundles` 里的 `@local/horon-web` 换成 `dsh-horon`，重装一次 `link:`。
3. profile `cordis.patch.yml`：`- id: horon-web` 那一行改成 `- id: dsh-horon`，`name` 改成 `'dsh-horon'`（`config` 整段照抄）。
4. 控制台路由从 `/horon-web/` 变成 `/dsh-horon/`，旧书签失效。

## 目录结构

```
index.js          宿主侧入口：三种模式的服务生命周期、/dsh-horon/ 路由与设置页接口
harness.js        horon 工具、记忆策略提示词段落、dsh 生命周期钩子
docker.js         docker 模式的配置解析、compose/Dockerfile 渲染、部署与日志
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
node docker/build.mjs <Horon 仓库路径>     # 默认取 HORON_REPO 或 C:\Users\<你>\horon
docker compose -f docker/docker-compose.yml up -d --build
```

同一条命令顺带刷新 `skills/`。设置页里的一键部署生成的就是同一份 compose 和命令。

## 配置项一览

| key | 默认 | 说明 |
| --- | --- | --- |
| `mode` | 由 `url` 推断，否则 `spawn` | `spawn` / `docker` / `url` |
| `url` | — | 运行中的 Horon 服务地址，例如 `http://127.0.0.1:8710` |
| `root` | `C:\Users\<你>\horon` | Horon 仓库根目录（`.env`、`web/dist`、`.agents/skills`） |
| `python` | `python` | 带 fastapi + uvicorn 的解释器（Horon 的 venv） |
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
