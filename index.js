// Horon memory console as a DeepSeek Harness plugin — Host half.
//
// One row (`dsh-horon`) mounts four things:
//   - the Horon Harness half (harness.js): the `horon` tool, a short memory-policy system-prompt
//     section, and the dsh lifecycle hooks;
//   - the Horon service, in one of four modes (config `mode`, guessed from `url` when absent):
//       artifact  the released build artifact (artifact.js) is downloaded from GitHub Releases,
//                 checked against horon.lock.json, unpacked under `artifactDir` and run through the
//                 same spawn path — no repository, no git, no npm, no Docker;
//       docker    the container of the image named in horon.lock.json, pulled (never built) by
//                 docker.js; `autostart` only starts an existing container (never creates one);
//       spawn     this half runs ONE Python process from a local Horon clone (`python -m uvicorn
//                 horon_web_app:app`) while the plugin is active and stops it on dispose; the
//                 developer path;
//       url       the service runs somewhere else and is reached at `url`;
//   - a `/dsh-horon/` route on the dsh web server that proxies to the service, behind the same
//     Host/Origin + login fence as dsh's own routes, plus `/dsh-horon/_dsh/*` endpoints that back
//     the settings page (status, config, preview, deploy, logs);
//   - optionally the Horon skills (horon-cli, horon-circuit, horon-plugin) as a skill provider,
//     for hosts that cannot read the Horon repository (docker and url modes).
//
// config:
//   mode           spawn | docker | url; default: url when `url` is set, otherwise spawn
//   url            base URL of a running Horon service, e.g. http://127.0.0.1:8710. The service has
//                  no auth of its own, so it should only be reachable inside a trusted network.
//   root           Horon repository root (`.env`, `web/dist`, `.agents/skills`); spawn mode
//   python         interpreter that has fastapi + uvicorn (the Horon venv); spawn mode
//   host / port    bind address and port of the spawned service, default 127.0.0.1:8710
//   autostart      false keeps the plugin mounted without starting the service / container
//   hooks          false keeps only the `horon` tool, without the lifecycle hooks
//   skills         register the Horon skills; default on outside spawn mode. They are read from
//                  `root/.agents/skills` when it exists, otherwise from skills/ next to this file
//                  (scripts/assemble.mjs --skills refreshes that copy at publish time).
//   Artifact mode (see artifact.js and horon.lock.json):
//   artifactDir    where releases are unpacked, default ~/.horon/runtime
//   artifactUrl    override the asset URL (a mirror, or a local file:// path for tests)
//   artifactBaseUrl  override the release base URL; the asset name comes from horon.lock.json
//   artifactSha256 override the expected digest for this platform
//   horonCommit    pin a different Horon commit than horon.lock.json (advanced)
//   dataDir        shared with docker mode: the database, .env and tag plugins live there, so
//                  switching between docker and artifact keeps the same memory
//
//   Docker mode (every path defaults under the home directory, so one config works on Windows and
//   Linux; `~` stands for that directory, see docker.js):
//   dataDir        host directory holding the mounts, default ~/.horon/docker
//   dbFile         SQLite file, default <dataDir>/data/horon.db; its directory is mounted at /data
//   envFile        API keys / proxy, default <dataDir>/.env (created from docker/env.example)
//   tagPluginsDir  tag plugins, default <dataDir>/tag_plugins
//   dockerBind     host address the container publishes on, default 127.0.0.1
//   dockerPort     host port, default 8710
//   image          image tag, default <horon.lock.json image.name>:<tag>
//   container      container name, default horon
//   buildProxy     legacy: images used to be built here. Ignored; kept so old profiles still load.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  artifactSettings,
  artifactStatus,
  defaultArtifactDir,
  provisionArtifact,
} from './artifact.js'
import {
  defaultDataDir,
  deployState,
  dockerSettings,
  dockerStatus,
  ensureContainer,
  isDeploying,
  renderTexts,
  startDeploy,
} from './docker.js'
import { applyHarness, defaultPython, defaultRoot } from './harness.js'

export const name = 'dsh-horon'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// `~/horon` unless the profile says otherwise: a clone on another machine must work with no
// `root`/`python` in the config, and nobody else has this machine's paths.
const DEFAULT_ROOT = defaultRoot()
// Guard-chain counters filled by harness.js and read by the settings page.
const harnessStats = { calls: 0, denied: 0, failed: 0, lastError: null, degraded: false }
// One provisioning run at a time (download + unpack + bootstrap); the page polls /status while it
// lasts and reads the log from /provision-log.
const provisioning = { running: false, ok: undefined, error: null, text: '', total: 0, startedAt: undefined, finishedAt: undefined }
const PROVISION_LOG_LIMIT = 128 * 1024
const PREFIX = '[dsh-horon]'
const START_TIMEOUT_MS = 30_000
// Console route on the dsh web server; client.js builds the iframe URL from the same name.
const ROUTE = '/dsh-horon'
// Settings page endpoints, all under the route so they sit behind the same fence as the console.
const API_PREFIX = `${ROUTE}/_dsh/`
// The settings call carries one small config object; anything bigger is not a config edit.
const MAX_BODY_BYTES = 512 * 1024
// Keys the settings page may write into the profile patch.
const EDITABLE = new Set([
  'mode', 'url', 'autostart', 'dataDir', 'dbFile', 'envFile', 'tagPluginsDir',
  'dockerBind', 'dockerPort', 'image', 'container',
  'artifactDir', 'artifactUrl', 'artifactBaseUrl', 'artifactSha256', 'horonCommit', 'python', 'root',
])
const MODES = new Set(['spawn', 'artifact', 'docker', 'url'])
// BUNDLED_SKILL_RANK of @deepseek-ai/dsh-skill: user (~/.dsh/skills) and project skills win over it.
const SKILL_RANK = 600
const SKILL_PROVIDER = 'dsh-horon'
// Headers that only describe one hop (RFC 9110 §7.6.1) are not forwarded either way; the dsh
// credentials are not forwarded to the service, which has no use for them.
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate',
])
const PRIVATE_HEADERS = new Set(['cookie', 'authorization'])

function log(message) {
  console.log(`${PREFIX} ${message}`)
}

// Host part of a URL for a bind address; a wildcard bind is reached on loopback.
function urlHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') ? `[${host}]` : host
}

function settings(config) {
  const c = config ?? {}
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const url = text(c.url)?.replace(/\/+$/, '')
  const host = text(c.host) ?? '127.0.0.1'
  const port = Number(c.port ?? 8710)
  const declared = text(c.mode)
  // `url` alone has always meant "do not spawn"; it still does.
  const mode =
    declared === 'docker' || declared === 'spawn' || declared === 'artifact' || (declared === 'url' && url !== undefined)
      ? declared
      : url !== undefined
        ? 'url'
        : 'spawn'
  const docker = dockerSettings(c)
  const artifact = artifactSettings(c)
  // artifact mode owns its own interpreter: the venv bootstrap created inside the release.
  const root = mode === 'artifact' ? artifact.appDir : c.root ?? DEFAULT_ROOT
  return {
    mode,
    root,
    // The venv next to the root when it exists, so a fresh clone needs no `python` either.
    python: text(c.python) ?? defaultPython(root),
    host,
    port,
    autostart: c.autostart !== false,
    url,
    docker,
    artifact,
    // artifact mode keeps the manuals inside the release; registering from the package root means
    // the choices are the same before and after the first download.
    skills: c.skills ?? (mode !== 'spawn' && mode !== 'artifact'),
    // Whether anyone has chosen a way to run yet; the client shows the first-run chooser when not.
    // A working local clone counts as a choice, so upgrading an existing spawn-mode install does
    // not suddenly ask the user to pick again.
    chosen:
      declared !== undefined ||
      url !== undefined ||
      existsSync(path.join(c.root ?? DEFAULT_ROOT, 'frontend', 'cli.py')),
    // Where this host reaches the service: the configured one, or the one it starts.
    base: mode === 'url' ? url : mode === 'docker' ? docker.base : `http://${urlHost(host)}:${port}`,
  }
}

async function isServing(base, timeoutMs = 1200) {
  try {
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function waitUntilServing(base, isStopped) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isStopped()) return false
    if (await isServing(base)) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

// ---- console route ---------------------------------------------------------------------------

// Forward one request under ROUTE to the service, with ROUTE stripped from the path.
function proxy(base, req, res) {
  const incoming = new URL(req.url ?? '/', 'http://dsh.invalid')
  const rest = incoming.pathname.slice(ROUTE.length)
  if (rest === '') {
    // The console loads its assets and API with relative URLs, which need the trailing slash.
    // Relative Location, so a reverse proxy in front of dsh keeps its own path prefix.
    res.writeHead(302, { location: `${ROUTE.slice(1)}/${incoming.search}`, 'cache-control': 'no-store' })
    res.end()
    return
  }

  const target = new URL(base)
  const client = target.protocol === 'https:' ? https : http
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined && !HOP_HEADERS.has(key) && !PRIVATE_HEADERS.has(key)) headers[key] = value
  }
  headers.host = target.host
  // The dsh web server compresses the reply itself.
  headers['accept-encoding'] = 'identity'

  return new Promise((resolve) => {
    let finished = false
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname.replace(/\/+$/, '')}${rest}${incoming.search}`,
        headers,
        // One connection per request: a pooled socket could be torn down by the close handler
        // below while another request is already using it.
        agent: false,
      },
      (reply) => {
        const out = {}
        for (const [key, value] of Object.entries(reply.headers)) {
          if (value !== undefined && !HOP_HEADERS.has(key)) out[key] = value
        }
        res.writeHead(reply.statusCode ?? 502, out)
        reply.on('end', () => {
          finished = true
        })
        reply.on('error', () => res.destroy())
        reply.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`Horon service at ${base} is not reachable: ${error.message}\n`)
    })
    // The browser went away (iframe closed, navigation): drop the upstream request too.
    res.on('close', () => {
      if (!finished) upstream.destroy()
      resolve()
    })
    req.pipe(upstream)
  })
}

function registerConsoleRoute(ctx, config, s) {
  ctx.inject(['webServer', 'connection'], (web) => {
    web.effect(
      () =>
        web.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => {
            // Same fence as dsh's own routes: trusted Host/Origin and a logged-in browser.
            const rejection = web.connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            const incoming = new URL(req.url ?? '/', 'http://dsh.invalid')
            if (incoming.pathname.startsWith(API_PREFIX)) {
              return handleApi(ctx, config, s, req, res, incoming)
            }
            return proxy(s.base, req, res)
          },
        }),
      'dsh-horon: console route',
    )
  })
}

// ---- settings page API -----------------------------------------------------------------------

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, 'request body is not valid JSON')
  }
}

// Keep only the whitelisted keys, drop blanks (so the patch stays free of empty overrides) and
// coerce the numbers. Unknown keys are ignored rather than rejected: the page may send back what
// it read.
function cleanInput(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'config must be an object')
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE.has(key) || value === undefined) continue
    if (key === 'autostart') {
      out.autostart = value !== false && value !== 'false' && value !== null
      continue
    }
    // An emptied field clears the override instead of writing an empty string; preview and
    // deploy read it as "use the default".
    if (value === null || String(value).trim() === '') {
      out[key] = null
      continue
    }
    if (key === 'dockerPort') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'dockerPort must be a port number')
      out.dockerPort = port
      continue
    }
    if (key === 'mode' && !MODES.has(value)) throw httpError(400, 'mode must be spawn, artifact, docker or url')
    out[key] = String(value).trim()
  }
  return out
}

function mergeConfig(current, patch) {
  const next = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete next[key]
    else next[key] = value
  }
  return next
}

// Writing the settings rewrites the profile patch, which remounts this plugin; a second save
// arriving mid-remount must wait for the first rather than race it.
let saves = Promise.resolve()

// The configEditor service and this plugin's profile entry. Both are looked up per call: the entry
// is replaced by every remount, and the service may load after this plugin.
function requireEditor(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) {
    throw httpError(503, 'The configuration editor is not available in this dsh; edit the profile patch by hand.')
  }
  const id = ctx.fiber?.entry?.options?.id
  const entries = editor.entries()
  const entry =
    (id === undefined ? undefined : entries.find((row) => row.options.id === id)) ??
    entries.find((row) => row.options.id === name)
  if (entry === undefined) {
    throw httpError(503, 'This plugin is not a configuration entry of the active profile; edit the profile patch by hand.')
  }
  return { editor, entry }
}

async function saveConfig(ctx, input) {
  const patch = cleanInput(input)
  const task = saves.then(async () => {
    const { editor, entry } = requireEditor(ctx)
    await editor.edit(entry, (raw) => mergeConfig(raw, patch))
  })
  saves = task.catch(() => {})
  await task
  return patch
}

// What the page shows for reading: the raw config as written (undefined = default), the resolved
// paths, and the texts it can copy.
function readableConfig(config) {
  const c = config ?? {}
  return {
    mode: c.mode,
    url: c.url,
    autostart: c.autostart !== false,
    dataDir: c.dataDir,
    dbFile: c.dbFile,
    envFile: c.envFile,
    tagPluginsDir: c.tagPluginsDir,
    dockerBind: c.dockerBind,
    dockerPort: c.dockerPort,
    image: c.image,
    container: c.container,
    artifactDir: c.artifactDir,
    artifactUrl: c.artifactUrl,
    artifactBaseUrl: c.artifactBaseUrl,
    artifactSha256: c.artifactSha256,
    horonCommit: c.horonCommit,
    python: c.python,
    root: c.root,
  }
}

function describeResolved(d) {
  return {
    dataDir: d.dataDir,
    dbDir: d.dbDir,
    dbFile: d.dbFile,
    localDir: d.localDir,
    envFile: d.envFile,
    tagPluginsDir: d.tagPluginsDir,
    dockerBind: d.dockerBind,
    dockerPort: d.dockerPort,
    image: d.image,
    container: d.container,
    base: d.base,
  }
}

function describeArtifact(a) {
  return {
    platform: a.platform,
    commit: a.commit,
    commit8: a.commit8,
    dir: a.dir,
    root: a.root,
    asset: a.asset,
    url: a.url,
    sha256: a.sha256 || undefined,
    dataDir: a.dataDir,
    dbFile: a.dbFile,
    envFile: a.envFile,
    pinned: a.lock?.horon?.commit,
    image: a.lock?.image ? `${a.lock.image.name}:${a.lock.image.tag}` : undefined,
  }
}

async function describeConfig(ctx, config) {
  const s = settings(config)
  let editable = false
  try {
    requireEditor(ctx)
    editable = true
  } catch {
    editable = false
  }
  return {
    config: readableConfig(config),
    mode: s.mode,
    base: s.base,
    // Nobody has picked a way to run yet: the client shows the first-run chooser.
    onboarding: !s.chosen,
    editable,
    platform: process.platform,
    home: os.homedir(),
    defaultDataDir: defaultDataDir(),
    defaultArtifactDir: defaultArtifactDir(),
    resolved: describeResolved(s.docker),
    artifact: describeArtifact(s.artifact),
    artifactState: await artifactStatus(s.artifact),
    texts: await renderTexts(s.docker),
  }
}

// The draft the page is editing, without saving it: the commands, compose file and paths for it.
async function previewConfig(config, input) {
  const merged = { ...(config ?? {}), ...cleanInput(input) }
  const d = dockerSettings(merged)
  const [texts, serving] = await Promise.all([renderTexts(d), isServing(d.base, 1200)])
  return { resolved: describeResolved(d), base: d.base, serving, texts }
}

// ---- artifact provisioning ---------------------------------------------------------------------

function say(text) {
  provisioning.text += text
  provisioning.total += text.length
  if (provisioning.text.length > PROVISION_LOG_LIMIT) provisioning.text = provisioning.text.slice(-PROVISION_LOG_LIMIT)
}

export function provisionState(since = 0) {
  const kept = provisioning.total - provisioning.text.length
  const from = Math.min(Math.max(Number(since) || 0, kept), provisioning.total)
  return {
    running: provisioning.running,
    ok: provisioning.ok,
    error: provisioning.error,
    total: provisioning.total,
    from,
    text: provisioning.text.slice(from - kept),
  }
}

function startProvision(a) {
  if (provisioning.running) {
    const error = new Error('a provisioning run is already in progress')
    error.status = 409
    throw error
  }
  provisioning.running = true
  provisioning.ok = undefined
  provisioning.error = null
  provisioning.text = ''
  provisioning.total = 0
  provisioning.startedAt = Date.now()
  provisioning.finishedAt = undefined
  say(`# Horon artifact  ${new Date().toISOString()}\n`)
  say(`platform ${a.platform} · commit ${a.commit.slice(0, 8)} · target ${a.root}\n`)
  void provisionArtifact(a, say)
    .then(
      (prepared) => {
        provisioning.ok = true
        say(`\nruntime: ${prepared.python}\nroot:    ${prepared.root}\n`)
      },
      (error) => {
        provisioning.ok = false
        provisioning.error = String(error?.message ?? error)
        say(`\n${provisioning.error}\n`)
      },
    )
    .finally(() => {
      provisioning.running = false
      provisioning.finishedAt = Date.now()
    })
  return provisionState()
}

async function handleApi(ctx, config, s, req, res, incoming) {
  const action = incoming.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
  const method = req.method ?? 'GET'
  try {
    if (action === 'status' && method === 'GET') {
      const [serving, docker, artifact] = await Promise.all([
        isServing(s.base, 1500),
        dockerStatus(s.docker),
        artifactStatus(s.artifact),
      ])
      sendJson(res, 200, {
        mode: s.mode,
        base: s.base,
        serving,
        deploying: isDeploying(),
        provisioning: provisioning.running,
        docker,
        artifact,
        // Whether tool calls are actually being checked by Horon's guard circuits right now.
        hooks: {
          enabled: (config ?? {}).hooks !== false,
          calls: harnessStats.calls ?? 0,
          denied: harnessStats.denied ?? 0,
          failed: harnessStats.failed ?? 0,
          degraded: harnessStats.degraded === true,
          lastError: harnessStats.lastError ?? null,
        },
      })
      return
    }
    if (action === 'config' && method === 'GET') {
      sendJson(res, 200, await describeConfig(ctx, config))
      return
    }
    if (action === 'config' && method === 'POST') {
      const body = (await readJson(req)) ?? {}
      const patch = await saveConfig(ctx, body.config)
      // The remount that follows may already have replaced this plugin; answer anyway.
      sendJson(res, 200, { ok: true, config: patch })
      return
    }
    if (action === 'preview' && method === 'POST') {
      const body = (await readJson(req)) ?? {}
      sendJson(res, 200, await previewConfig(config, body.config))
      return
    }
    if (action === 'deploy' && method === 'POST') {
      const body = (await readJson(req)) ?? {}
      // Deploying from an unsaved draft is deliberate: it is how the paths are checked before
      // they are written into the profile.
      const d = dockerSettings({ ...(config ?? {}), ...cleanInput(body.config) })
      sendJson(res, 200, startDeploy(d))
      return
    }
    if (action === 'logs' && method === 'GET') {
      sendJson(res, 200, deployState(Number(incoming.searchParams.get('since') ?? 0)))
      return
    }
    // artifact mode: download + unpack + bootstrap, streamed into the same log viewer shape.
    if (action === 'provision' && method === 'POST') {
      const body = (await readJson(req)) ?? {}
      const a = artifactSettings({ ...(config ?? {}), ...cleanInput(body.config) })
      sendJson(res, 200, startProvision(a))
      return
    }
    if (action === 'provision-log' && method === 'GET') {
      sendJson(res, 200, provisionState(Number(incoming.searchParams.get('since') ?? 0)))
      return
    }
    sendJson(res, 404, { error: `unknown endpoint: ${method} ${action}` })
  } catch (error) {
    const status = Number(error?.status) || 500
    log(`settings api ${action} failed: ${error?.message ?? error}`)
    sendJson(res, status, { error: String(error?.message ?? error) })
  }
}

// ---- skills ----------------------------------------------------------------------------------

function parseSkill(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match?.[1] === undefined) throw new Error(`${file} has no YAML frontmatter`)
  const field = (key) => {
    const found = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(match[1])
    return found ? found[1].trim().replace(/^(['"])(.*)\1$/, '$2') : undefined
  }
  return { name: field('name'), description: field('description'), content: raw.slice(match[0].length).trim() }
}

function registerSkills(ctx, root) {
  const repoSkills = path.join(root, '.agents', 'skills')
  const dir = existsSync(repoSkills) ? repoSkills : path.join(HERE, 'skills')
  if (!existsSync(dir)) {
    log(`skills are on but ${dir} does not exist; no Horon skill is registered`)
    return
  }
  const provider = {
    name: SKILL_PROVIDER,
    async list() {
      const candidates = []
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const directory = path.join(dir, entry.name)
        const locator = path.join(directory, 'SKILL.md')
        let skill
        try {
          skill = parseSkill(await fs.readFile(locator, 'utf8'), locator)
        } catch {
          continue // not a skill directory
        }
        if (!skill.description) continue
        candidates.push({
          name: skill.name ?? entry.name,
          description: skill.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: SKILL_PROVIDER,
          source: 'bundled',
          rank: SKILL_RANK,
          // The manuals link to each other with relative paths (../horon-circuit/SKILL.md).
          resourceBase: { kind: 'directory', path: directory.split(path.sep).join('/') },
          locator,
        })
      }
      return candidates
    },
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await fs.readFile(locator, { encoding: 'utf8', signal: options?.signal })
      return { ...summary, content: parseSkill(raw, locator).content }
    },
  }
  ctx.inject(['skills'], (skillsCtx) => skillsCtx.skills.registerProvider(() => provider))
}

// ---- service lifecycle (spawn mode) ----------------------------------------------------------

function runService(ctx, { root, python, host, port, autostart, base, prepare }) {
  ctx.effect(() => {
    let child = null
    let stopped = false
    const isStopped = () => stopped

    const stop = () => {
      stopped = true
      const target = child
      child = null
      if (!target || target.exitCode !== null) return
      try {
        target.kill()
      } catch {}
      // uvicorn normally exits on the first signal; force it if it does not.
      const timer = setTimeout(() => {
        if (target.exitCode !== null || !target.pid) return
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            }).unref()
          } else {
            target.kill('SIGKILL')
          }
        } catch {}
      }, 2500)
      timer.unref?.()
    }

    if (!autostart) {
      log('autostart is off; the console service is not started')
      return stop
    }

    void (async () => {
      if (await isServing(base)) {
        log(`reusing the Horon service already listening on ${base}`)
        return
      }
      if (stopped) return

      // artifact mode: fetch + unpack + bootstrap the released tree before anything is spawned.
      // A failure here leaves the service down but must not take the plugin (or dsh) with it.
      let serviceRoot = root
      let servicePython = python
      if (prepare !== undefined) {
        try {
          const prepared = await prepare()
          if (stopped) return
          if (prepared?.root) serviceRoot = prepared.root
          if (prepared?.python) servicePython = prepared.python
        } catch (error) {
          log(`the service runtime is not ready: ${error?.message ?? error}`)
          log('open Settings → Horon service and press Deploy, or choose another mode')
          return
        }
      }

      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // The launcher lives here; `backend.*` resolves from the Horon root. `vendor/` covers the
        // bootstrap fallback for hosts without the venv module.
        PYTHONPATH: [HERE, serviceRoot, path.join(serviceRoot, 'vendor'), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
        HORON_ROOT: serviceRoot,
      }

      let spawned
      try {
        spawned = spawn(
          servicePython,
          ['-m', 'uvicorn', 'horon_web_app:app', '--host', host, '--port', String(port), '--log-level', 'warning'],
          { cwd: serviceRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        log(`could not start ${servicePython}: ${error?.message ?? error}`)
        return
      }

      // The effect may have been disposed while the spawn was in flight.
      if (stopped) {
        try {
          spawned.kill()
        } catch {}
        return
      }

      child = spawned
      spawned.stdout?.on('data', (chunk) => process.stdout.write(`${PREFIX} ${chunk}`))
      spawned.stderr?.on('data', (chunk) => process.stderr.write(`${PREFIX} ${chunk}`))
      spawned.on('error', (error) => log(`service error: ${error?.message ?? error}`))
      spawned.on('exit', (code) => {
        if (!stopped) log(`service exited with code ${code}`)
      })

      const ready = await waitUntilServing(base, isStopped)
      if (ready) log(`console ready at ${base}/ (and under ${ROUTE}/ on the dsh page)`)
      else log('console did not answer within 30s; read the lines above for the reason')
    })().catch((error) => log(`startup failed: ${error?.message ?? error}`))

    return stop
  }, 'dsh-horon: Horon console service')
}

export function apply(ctx, config) {
  const s = settings(config)
  // A remount starts the counters over: they describe this process, not the whole history.
  Object.assign(harnessStats, { calls: 0, denied: 0, failed: 0, lastError: null, degraded: false })
  applyHarness(ctx, {
    ...(config ?? {}),
    root: s.root,
    python: s.python,
    // Outside spawn mode the tool talks to the service over HTTP.
    url: s.mode === 'spawn' ? undefined : s.base,
    stats: harnessStats,
  })
  registerConsoleRoute(ctx, config, s)
  if (s.skills) registerSkills(ctx, s.mode === 'artifact' ? HERE : s.root)

  if (s.mode === 'artifact') {
    runService(ctx, {
      ...s,
      // Downloaded once per pinned commit, then reused: the second start is a plain spawn.
      prepare: () => provisionArtifact(s.artifact, log),
    })
    return
  }
  if (s.mode === 'docker') {
    if (s.autostart) void ensureContainer(s.docker, log).catch((error) => log(`docker: ${error?.message ?? error}`))
    else log(`autostart is off; container ${s.docker.container} is left as it is`)
    return
  }
  if (s.mode === 'url') {
    void isServing(s.base, 3000).then((up) =>
      log(up ? `using the Horon service at ${s.base}` : `the Horon service at ${s.base} did not answer yet`),
    )
    return
  }
  if (!s.chosen) {
    // Fresh install: nothing is started until the user picks a runtime in the Horon panel.
    log('no runtime chosen yet; open the Horon panel to download the artifact or pull the image')
    return
  }
  runService(ctx, s)
}