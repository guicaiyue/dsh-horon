# 二开环境：`horon-dev` profile

本机把 dsh-horon 挂成 `link:` 依赖的开发 profile，改完源码重启这个 profile 即生效，不污染日常用的 `web` profile。

## 位置

| 项 | 值 |
| --- | --- |
| 源码 | `/home/xirizhi/Projects/dsh-horon`（origin `git@github.com:guicaiyue/dsh-horon.git`，二开分支 `dev`） |
| profile | `~/.dsh/profiles/horon-dev`（`dsh --from-default-profile web` 生成） |
| 依赖 | `~/.dsh/profiles/horon-dev/node_modules/dsh-horon` → `../../../../Projects/dsh-horon` 软链 |
| dsh 工作区 | workspaceId `35733a5e-924e-4716-bc16-3ffb1662d831`，path 指向源码目录 |

## 启动

```bash
cd /home/xirizhi/work/upstream/dsh
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile horon-dev \
  --host 127.0.0.1 --port 13099 --no-open --trusted-host 127.0.0.1:13099
```

注意 `--profile` 之后**不要**再写 `web`：profile 已经决定了 app 类型，多写一个位置参数会报
`too many arguments. Expected 0 arguments but got 1: web`。

登录 token 打在启动日志 `dsh web: http://127.0.0.1:13099/?token=...`；curl 需先用它换 cookie。

## 配置

`~/.dsh/profiles/horon-dev/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-horon
      name: 'dsh-horon'
      config:
        mode: docker
        autostart: true
        hooks: true
        dataDir: '/home/xirizhi/.horon/docker'
```

沿用本机已有的 `horon` 容器（`xirizhi/horon-service:1.0.0`，127.0.0.1:8710），二开时和日常用的记忆库是同一份，不另起数据目录。

`pnpm-workspace.yaml` 里给 `dsh-horon` 写 `skills: false`：本插件的 skills 由它自己注册 provider（读仓库 `skills/`），不走 pnpm 的 agent skill dir 链接，否则 install 会撞 `ERR_PNPM_NO_AGENT_SKILLS_DIR`。

## 验证基线（2026-11-13）

- `node test/host-smoke.mjs` → `smoke ok`，healthy service `{"enabled":true,"denied":0,"failed":0,"degraded":false}`
- CI 同款检查全过：`node --check` 8 个 js/mjs、`py_compile` 两个 py、`horon.lock.json` 四个 jq 断言、`market-entry.mjs` 版本一致、`npm pack --dry-run` 23 文件 83 kB
- dev profile 实测：`/` 200、`/dsh-horon/` 200（控制台代理通）、`/dsh-horon/_dsh/status` 返回 `mode: docker`、`serving: true`、容器 `running/healthy`

## 二开节奏

1. 改 `index.js` / `harness.js` / `client.js` / `docker.js` / `artifact.js` / `horon_web_app.py`
2. `node test/host-smoke.mjs`（宿主半边，不需要 dsh）
3. 起 `horon-dev` profile 看客户端半边；客户端改动需刷新浏览器，宿主改动需重启该 profile
4. 涉及锁定产物（镜像 tag / 构建物 sha256 / Horon commit）时同步改 `horon.lock.json`，并跑 `node scripts/lock-sync.mjs`
