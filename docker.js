// Docker deployment of the Horon service for the dsh-horon plugin: the resolved settings, the
// commands and compose file the settings page offers for copying, and the one-click deploy that
// runs those commands on this host.
//
// Every mount is a bind mount of a host directory, by default under the user's home directory
// (os.homedir(): C:\Users\<name> on Windows, /home/<name> or /root on Linux), so the data stays on
// the host across redeploys:
//   dirname(dbFile)  -> /data                     the SQLite database (HORON_DB=/data/<file name>)
//   dataDir/local    -> /app/.horon-local         backfill locks and logs
//   tagPluginsDir    -> /app/backend/tag_plugins  tag plugins (the entrypoint seeds the system ones)
//   envFile          -> --env-file                API keys / proxy; created from env.example
// The image is built from docker/context/, which ships with the plugin (docker/build.mjs).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DOCKER_DIR = path.join(HERE, 'docker')
export const CONTEXT_DIR = path.join(DOCKER_DIR, 'context')
const ENV_EXAMPLE = path.join(DOCKER_DIR, 'env.example')
const CONTAINER_PORT = 8710
const LOG_LIMIT = 256 * 1024
const READY_TIMEOUT_MS = 120_000
const STATUS_TIMEOUT_MS = 8000

export function defaultDataDir() {
  return path.join(os.homedir(), '.horon', 'docker')
}

// Host part of a URL for a bind address; a wildcard bind is reached on loopback.
export function urlHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') ? `[${host}]` : host
}

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

// `~` / `~/…` / `~\…` is the home directory of the user running dsh, so one config works on both
// Windows and Linux.
export function expandHome(value) {
  return value === '~' || /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value
}

// Docker settings with every default filled in. Paths that are not set follow dataDir.
export function dockerSettings(config) {
  const c = config ?? {}
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const file = (value) => {
    const given = text(value)
    return given === undefined ? undefined : path.resolve(expandHome(given))
  }
  const dataDir = file(c.dataDir) ?? defaultDataDir()
  const dbFile = file(c.dbFile) ?? path.join(dataDir, 'data', 'horon.db')
  const dockerBind = text(c.dockerBind) ?? '127.0.0.1'
  const dockerPort = Number(c.dockerPort ?? 8710)
  return {
    dataDir,
    dbFile,
    dbDir: path.dirname(dbFile),
    localDir: path.join(dataDir, 'local'),
    envFile: file(c.envFile) ?? path.join(dataDir, '.env'),
    tagPluginsDir: file(c.tagPluginsDir) ?? path.join(dataDir, 'tag_plugins'),
    dockerBind,
    dockerPort,
    image: text(c.image) ?? 'horon-service:local',
    container: text(c.container) ?? 'horon',
    buildProxy: text(c.buildProxy) ?? '',
    timeZone: hostTimeZone(),
    base: `http://${urlHost(dockerBind)}:${dockerPort}`,
  }
}

// The docker invocations of a deploy, as groups of arguments (one group per displayed line).
export function dockerPlan(d) {
  return {
    dirs: [...new Set([d.dataDir, d.dbDir, d.localDir, d.tagPluginsDir, path.dirname(d.envFile)])],
    build: [
      ['build', '--progress=plain'],
      ['-t', d.image],
      ...(d.buildProxy ? [['--build-arg', `BUILD_PROXY=${d.buildProxy}`]] : []),
      [CONTEXT_DIR],
    ],
    remove: [['rm', '-f', d.container]],
    run: [
      ['run', '-d'],
      ['--name', d.container],
      ['--restart', 'unless-stopped'],
      // Backfill jobs run as detached child processes (backend/integrity.py) and need reaping.
      ['--init'],
      ['-p', `${d.dockerBind}:${d.dockerPort}:${CONTAINER_PORT}`],
      ['--add-host', 'host.docker.internal:host-gateway'],
      ['--env-file', d.envFile],
      // `-e` wins over `--env-file`, so a HORON_DB / HORON_ROOT in the file (say, a copied host
      // .env) cannot point the service at a path that does not exist in the container.
      ['-e', `HORON_DB=/data/${path.basename(d.dbFile)}`],
      ['-e', 'HORON_ROOT=/app'],
      ['-e', `TZ=${d.timeZone}`],
      ['-v', `${d.dbDir}:/data`],
      ['-v', `${d.localDir}:/app/.horon-local`],
      ['-v', `${d.tagPluginsDir}:/app/backend/tag_plugins`],
      [d.image],
    ],
  }
}

const flat = (groups) => groups.flat()

// ---- texts for the settings page -------------------------------------------------------------

function quotePosix(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

// PowerShell: single quotes are literal; a comma would build an array, so it is quoted too.
function quotePwsh(arg) {
  return /^[\w%+=:./\\-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
}

function renderCommands(d, platform) {
  const win = platform === 'win32'
  const q = win ? quotePwsh : quotePosix
  const command = (groups) => groups.map((group) => group.map(q).join(' ')).join(win ? ' `\n    ' : ' \\\n    ')
  const plan = dockerPlan(d)
  const lines = [
    win ? '# PowerShell，在宿主机上运行' : '# 在宿主机上运行',
    '# 1. 数据目录和 .env（API key / 代理填在 .env 里）',
  ]
  if (win) {
    lines.push(`New-Item -ItemType Directory -Force -Path ${plan.dirs.map(q).join(', ')} | Out-Null`)
    lines.push(`if (-not (Test-Path -LiteralPath ${q(d.envFile)})) { Copy-Item -LiteralPath ${q(ENV_EXAMPLE)} -Destination ${q(d.envFile)} }`)
  } else {
    lines.push(`mkdir -p ${plan.dirs.map(q).join(' ')}`)
    lines.push(`[ -e ${q(d.envFile)} ] || cp ${q(ENV_EXAMPLE)} ${q(d.envFile)}`)
  }
  const [buildHead, ...buildRest] = plan.build
  const [runHead, ...runRest] = plan.run
  lines.push(
    '',
    '# 2. 构建镜像（构建上下文随插件发布）',
    command([['docker', ...buildHead], ...buildRest]),
    '',
    '# 3. 启动容器（同名容器会被替换；数据在上面的目录里，不受影响）',
    command([['docker', ...flat(plan.remove)]]),
    command([['docker', ...runHead], ...runRest]),
    '',
  )
  return lines.join('\n')
}

function renderCompose(d) {
  // Single-quoted YAML scalars keep Windows backslashes; `$` is doubled against compose interpolation.
  const y = (value) => `'${String(value).replace(/'/g, "''").replace(/\$/g, '$$$$')}'`
  const bind = (source, target) => [
    '      - type: bind',
    `        source: ${y(source)}`,
    `        target: ${target}`,
    '        bind:',
    '          create_host_path: true',
  ]
  return [
    '# 由 dsh-horon 设置页按当前配置生成。保存成 docker-compose.yml，在同一目录运行：',
    '#   docker compose up -d --build',
    '# 服务没有鉴权：端口默认只绑 127.0.0.1，改成 0.0.0.0 前确认网络可信。',
    'name: horon',
    '',
    'services:',
    '  horon:',
    '    build:',
    `      context: ${y(CONTEXT_DIR)}`,
    ...(d.buildProxy ? ['      args:', `        BUILD_PROXY: ${y(d.buildProxy)}`] : []),
    `    image: ${y(d.image)}`,
    `    container_name: ${y(d.container)}`,
    '    restart: unless-stopped',
    '    init: true',
    '    ports:',
    `      - ${y(`${d.dockerBind}:${d.dockerPort}:${CONTAINER_PORT}`)}`,
    '    env_file:',
    `      - path: ${y(d.envFile)}`,
    '        required: false',
    '    environment:',
    `      HORON_DB: ${y(`/data/${path.basename(d.dbFile)}`)}`,
    '      HORON_ROOT: /app',
    `      TZ: ${y(d.timeZone)}`,
    '    extra_hosts:',
    "      - 'host.docker.internal:host-gateway'",
    '    volumes:',
    ...bind(d.dbDir, '/data'),
    ...bind(d.localDir, '/app/.horon-local'),
    ...bind(d.tagPluginsDir, '/app/backend/tag_plugins'),
    '',
  ].join('\n')
}

async function readText(...files) {
  for (const file of files) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      // try the next one
    }
  }
  return ''
}

export async function renderTexts(d, platform = process.platform) {
  return {
    commands: renderCommands(d, platform),
    compose: renderCompose(d),
    dockerfile: await readText(path.join(CONTEXT_DIR, 'Dockerfile'), path.join(DOCKER_DIR, 'Dockerfile')),
    envExample: await readText(ENV_EXAMPLE),
    contextDir: CONTEXT_DIR,
    contextReady: existsSync(path.join(CONTEXT_DIR, 'Dockerfile')),
  }
}

// ---- running docker --------------------------------------------------------------------------

function runDocker(args, { onData, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('docker', args, {
        shell: false,
        windowsHide: true,
        env: { ...process.env, DOCKER_CLI_HINTS: 'false' },
      })
    } catch (error) {
      resolve({ code: -1, out: '', err: String(error?.message ?? error) })
      return
    }
    const out = []
    const err = []
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out.push(chunk)
      onData?.(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err.push(chunk)
      onData?.(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      const message = error?.code === 'ENOENT' ? 'docker command not found on PATH' : String(error?.message ?? error)
      resolve({ code: -1, out: '', err: message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out: out.join(''), err: err.join('') })
    })
  })
}

const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/).pop() ?? ''

export async function isServing(base, timeoutMs = 1200) {
  try {
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

// Docker engine, container and image as the settings page shows them.
export async function dockerStatus(d) {
  const [version, container, image] = await Promise.all([
    runDocker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: STATUS_TIMEOUT_MS }),
    runDocker(['inspect', '--type', 'container', '--format', '{{json .State}}', d.container], { timeoutMs: STATUS_TIMEOUT_MS }),
    runDocker(['image', 'inspect', '--format', '{{.Created}}', d.image], { timeoutMs: STATUS_TIMEOUT_MS }),
  ])
  if (version.code !== 0) {
    return { available: false, error: firstLine(version.err || version.out) || 'docker is not available' }
  }
  let state
  if (container.code === 0) {
    try {
      const s = JSON.parse(container.out)
      state = { status: s.Status, running: s.Running === true, health: s.Health?.Status, startedAt: s.StartedAt }
    } catch {
      state = undefined
    }
  }
  return {
    available: true,
    version: version.out.trim(),
    container: state,
    image: image.code === 0 ? { created: image.out.trim() } : undefined,
  }
}

// Docker mode with autostart: bring an existing, stopped container back. Never creates one.
export async function ensureContainer(d, log) {
  if (await isServing(d.base, 2000)) {
    log(`using the Horon container at ${d.base}`)
    return
  }
  const started = await runDocker(['start', d.container], { timeoutMs: 30_000 })
  if (started.code === 0) log(`started container ${d.container}; the service will answer at ${d.base}`)
  else log(`container ${d.container} is not running (${firstLine(started.err) || 'docker start failed'}); deploy it from Settings → Horon`)
}

// ---- one-click deploy ------------------------------------------------------------------------

// One deploy at a time per dsh process. Module state, so a plugin remount (saving the settings)
// does not lose the log of a running deploy.
let job = { id: 0, running: false, ok: undefined, output: '', total: 0, startedAt: undefined, finishedAt: undefined }

// The deploy state with the log from character `since` on (counted over the whole run; only the
// last LOG_LIMIT characters are kept, so `from` may be later than `since`).
export function deployState(since = 0) {
  const { output, ...state } = job
  const kept = job.total - output.length
  const from = Math.min(Math.max(Number(since) || 0, kept), job.total)
  return { ...state, from, text: output.slice(from - kept) }
}

export function isDeploying() {
  return job.running
}

export function startDeploy(d) {
  if (job.running) {
    const error = new Error('a deploy is already running')
    error.status = 409
    throw error
  }
  const current = { id: job.id + 1, running: true, ok: undefined, output: '', total: 0, startedAt: Date.now(), finishedAt: undefined }
  job = current
  const say = (text) => {
    current.output += text
    current.total += text.length
    if (current.output.length > LOG_LIMIT) current.output = current.output.slice(-LOG_LIMIT)
  }
  void deploy(d, say)
    .then(
      (ok) => {
        current.ok = ok
      },
      (error) => {
        say(`\n${String(error?.stack ?? error)}\n`)
        current.ok = false
      },
    )
    .finally(() => {
      current.running = false
      current.finishedAt = Date.now()
    })
  return deployState()
}

async function deploy(d, say) {
  const plan = dockerPlan(d)
  const step = async (args) => {
    say(`\n$ docker ${args.map(quotePosix).join(' ')}\n`)
    const result = await runDocker(args, { onData: say })
    if (result.code === -1 && result.err && !result.out) say(`${result.err}\n`)
    return result
  }

  say(`# Horon deploy  ${new Date().toISOString()}\n`)
  if (!existsSync(path.join(CONTEXT_DIR, 'Dockerfile'))) {
    say(`\nThe build context ${CONTEXT_DIR} is missing; run \`node docker/build.mjs <Horon repository>\` in the plugin directory first.\n`)
    return false
  }
  if ((await step(['version', '--format', '{{.Server.Version}}'])).code !== 0) {
    say('\nDocker is not available: install Docker and make sure the engine is running.\n')
    return false
  }

  // Something else on the port (typically the spawn-mode service) would make `docker run` fail
  // after a long build; stop early instead. Our own running container is replaced below.
  const inspect = await runDocker(['inspect', '--type', 'container', '--format', '{{.State.Running}}', d.container])
  const oursRunning = inspect.code === 0 && inspect.out.trim() === 'true'
  if (!oursRunning && (await portInUse(urlHost(d.dockerBind), d.dockerPort))) {
    say(
      `\nPort ${d.dockerPort} is already in use by another process (often the spawn-mode Horon service).` +
        ' Switch the mode to Docker and save first, or choose another host port.\n',
    )
    return false
  }

  say('\n# host directories\n')
  for (const dir of plan.dirs) {
    await fs.mkdir(dir, { recursive: true })
    say(`${dir}\n`)
  }
  if (!existsSync(d.envFile)) {
    await fs.copyFile(ENV_EXAMPLE, d.envFile)
    say(`created ${d.envFile} from env.example; put the API keys / proxy there\n`)
  }

  if ((await step(flat(plan.build))).code !== 0) return false
  await step(flat(plan.remove)) // "No such container" on the first deploy is fine
  if ((await step(flat(plan.run))).code !== 0) return false

  say(`\n# waiting for ${d.base}/api/sessions\n`)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isServing(d.base, 2000)) {
      say(`ready: ${d.base}\n`)
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  say(`\nThe service did not answer within ${READY_TIMEOUT_MS / 1000}s. Last container logs:\n`)
  await step(['logs', '--tail', '80', d.container])
  return false
}
