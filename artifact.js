// Build artifacts of the Horon service, released by CI: download, verify, unpack, bootstrap.
//
// This is the `artifact` mode's whole job. Nothing here clones a repository or builds anything:
// the release already contains the backend, the prebuilt console and the pinned wheels, so a host
// with Python 3.12 but no Docker, no git and no npm can still run the service.
//
//   <artifactDir>/<commit8>-<platform>/            one directory per pinned release, never shared
//     app/                                        HORON_ROOT: backend, frontend, web/dist, .venv
//     wheels/  bootstrap.py  requirements.lock.txt  manifest.json
//     .installed.json                             what the plugin did here, and when
//
// The version directory is what makes upgrades safe: a new commit unpacks next to the old one,
// the database and .env stay in dataDir, and rolling back is switching the lock back.

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dbFileFor,
  envFileFor,
  expandHome,
  proxyOf,
  proxied,
  resolveDataDir,
  runtimeDirFor,
  tagPluginsDirFor,
} from './paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const LOCK_FILE = path.join(HERE, 'horon.lock.json')
const INSTALLED = '.installed.json'
const READY = path.join('app', '.ready.json')

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Bumped by CI; read at runtime so one package version can describe several deployments. */
export function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

/** The release asset platform key for this machine, e.g. `linux-x64`. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return `${platform}-${arch}`
}

export function defaultArtifactDir(dataDir) {
  return runtimeDirFor(dataDir ?? resolveDataDir({}))
}

function venvPython(appDir) {
  return process.platform === 'win32'
    ? path.join(appDir, '.venv', 'Scripts', 'python.exe')
    : path.join(appDir, '.venv', 'bin', 'python')
}

/** Artifact settings with every default filled in from horon.lock.json. */
export function artifactSettings(config) {
  const c = config ?? {}
  const lock = readLock()
  const commit = text(c.horonCommit) ?? lock?.horon?.commit ?? ''
  const platform = platformKey()
  const root = resolveDataDir(c)
  // Unpacked releases live under the data directory, so one path covers the lot.
  const dir = path.resolve(expandHome(text(c.artifactDir) ?? runtimeDirFor(root)))
  const staged = path.join(dir, `${commit.slice(0, 8)}-${platform}`)
  const short = commit.slice(0, 8)
  // `{commit8}` / `{platform}` keep one commit bump from scattering stale names over the release.
  const fill = (value) => String(value).replaceAll('{platform}', platform).replaceAll('{commit8}', short)
  const given = text(c.artifactUrl)
  const name = fill(given ?? lock?.artifact?.asset ?? 'horon-app-{platform}-{commit8}.tar.gz')
  const baseUrl = fill(text(c.artifactBaseUrl) ?? lock?.artifact?.baseUrl ?? '')
  const direct = /^[a-z][a-z0-9+.-]*:\/\//i.test(name) ? name : `${baseUrl.replace(/\/+$/, '')}/${name}`
  // GitHub releases are the only source; the proxy is what makes them reachable.
  const proxy = proxyOf(c)
  const url = proxied(direct, proxy)
  return {
    platform,
    commit,
    commit8: commit.slice(0, 8),
    dir,
    root: staged,
    appDir: path.join(staged, 'app'),
    asset: path.basename(new URL(url || 'file:///x').pathname) || name,
    url,
    sha256: lock?.artifact?.sha256?.[platform] ?? text(c.artifactSha256) ?? '',
    // The interpreter bootstrap runs with; the venv it creates is what the service runs on.
    basePython: text(c.python) ?? (process.platform === 'win32' ? 'python' : 'python3'),
    // One directory for both runtimes: switching keeps the database, the key file and tag plugins.
    dataDir: root,
    dbFile: text(c.dbFile) ? path.resolve(expandHome(text(c.dbFile))) : dbFileFor(root),
    envFile: text(c.envFile) ? path.resolve(expandHome(text(c.envFile))) : envFileFor(root),
    proxy: proxyOf(c),
    // tag plugins are personal: they never travel in the release, so the user's directory is
    // mirrored into the unpacked tree on every start.
    tagPluginsDir: tagPluginsDirFor(root),
    directUrl: direct,
    lock,
  }
}

/** What the settings page shows: is this release unpacked, and is its runtime ready. */
export async function artifactStatus(a) {
  if (!a.commit) return { platform: a.platform, installed: false, ready: false, url: '', error: 'no pinned commit in horon.lock.json' }
  const installed = existsSync(path.join(a.root, INSTALLED))
  const ready = existsSync(path.join(a.root, READY))
  let recorded
  try {
    recorded = JSON.parse(await fs.readFile(path.join(a.root, INSTALLED), 'utf8'))
  } catch {
    recorded = undefined
  }
  return {
    platform: a.platform,
    commit: a.commit,
    commit8: a.commit8,
    dir: a.dir,
    root: a.root,
    asset: a.asset,
    url: a.url,
    installed,
    ready,
    sha256: a.sha256 || undefined,
    installedAt: recorded?.at,
    python: ready ? venvPython(a.appDir) : a.basePython,
  }
}

// ---- downloading ------------------------------------------------------------------------------

function fetchFile(url, destination, { onProgress } = {}) {
  const get = (target, redirects) =>
    new Promise((resolve, reject) => {
      const agent = target.startsWith('https:') ? https : http
      const request = agent.get(target, { headers: { 'user-agent': 'dsh-horon' } }, (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirects <= 0) {
            reject(new Error(`too many redirects for ${url}`))
            return
          }
          resolve(get(new URL(response.headers.location, target).toString(), redirects - 1))
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`HTTP ${status} for ${url}`))
          return
        }
        const total = Number(response.headers['content-length'] ?? 0)
        let seen = 0
        let last = 0
        const out = createWriteStream(destination)
        out.on('error', reject)
        response.on('data', (chunk) => {
          seen += chunk.length
          out.write(chunk)
          const now = Date.now()
          if (onProgress && (now - last > 400 || seen === total)) {
            last = now
            onProgress({ seen, total })
          }
        })
        response.on('end', () => {
          out.end(() => resolve({ bytes: seen }))
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.setTimeout(60_000, () => request.destroy(new Error(`timeout downloading ${url}`)))
    })
  return get(url, 5)
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(command, args, { cwd, onLine } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    } catch (error) {
      resolve({ code: -1, out: String(error?.message ?? error) })
      return
    }
    const lines = []
    const push = (chunk) => {
      const value = String(chunk)
      lines.push(value)
      onLine?.(value)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (error) => resolve({ code: -1, out: lines.join('') + error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, out: lines.join('') }))
  })
}

// `tar` ships with Windows 10+ (bsdtar) and with every POSIX we support; one tarball keeps the
// artifact a single verifiable file.
//
// GNU tar treats `D:\x.tgz` as a remote host named D, so it needs --force-local; bsdtar has no
// such flag and no such problem. Ask once which tar is on PATH and remember it.
let tarFlavour
function gnuTar() {
  if (tarFlavour !== undefined) return tarFlavour
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  tarFlavour = /GNU tar/i.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
  return tarFlavour
}

async function extract(archive, destination, log) {
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })
  // Forward slashes keep GNU tar from reading the backslashes as escapes; --force-local keeps it
  // from reading `C:` as a host name. bsdtar wants neither and copes with the slashes anyway.
  const tarPath = (value) => path.resolve(value).split(path.sep).join('/')
  const args = ['-xzf', tarPath(archive), '-C', tarPath(destination)]
  if (gnuTar()) args.unshift('--force-local')
  const done = await run('tar', args, {
    onLine: (line) => log(`tar: ${line.trimEnd()}`),
  })
  if (done.code !== 0) throw new Error(`tar failed (${String(done.code)}): ${done.out.trim().slice(-400)}`)
}

// The service reads ROOT/.env and needs HORON_DB there. The file lives inside the version
// directory, but every path in it points outside, at the shared database and key file, so it
// survives an upgrade. It is rewritten on every start of this code path, so editing dbFile or
// envFile in the profile takes effect instead of being silently ignored.
async function writeEnv(a, log) {
  const file = path.join(a.appDir, '.env')
  let body = ''
  if (existsSync(a.envFile)) {
    body = await fs.readFile(a.envFile, 'utf8')
    log(`seeded app/.env from ${a.envFile}`)
  }
  const lines = body.split(/\r?\n/).filter((line) => !/^\s*HORON_DB\s*=/.test(line))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  lines.push(`HORON_DB=${a.dbFile}`)
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * Mirror the user's tag plugins into the unpacked release.
 *
 * The release only carries the system plugins (state/action/result/exit by upstream allow-list);
 * anything a user wrote for themselves lives in the data directory. Docker mode bind-mounts that
 * directory over the same path, so this walk is what artifact mode needs to behave identically.
 */
async function syncTagPlugins(a, log) {
  const target = path.join(a.appDir, 'backend', 'tag_plugins')
  let names
  try {
    names = await fs.readdir(a.tagPluginsDir)
  } catch {
    return
  }
  const files = names.filter((name) => name.endsWith('.py'))
  if (files.length === 0) return
  await fs.mkdir(target, { recursive: true })
  let copied = 0
  for (const name of files) {
    const from = path.join(a.tagPluginsDir, name)
    const to = path.join(target, name)
    try {
      const [source, current] = await Promise.all([fs.stat(from), fs.stat(to).catch(() => undefined)])
      if (current !== undefined && current.size === source.size && current.mtimeMs >= source.mtimeMs) continue
      await fs.copyFile(from, to)
      copied += 1
    } catch {
      // A plugin that cannot be read is skipped; the service logs its own loading errors.
    }
  }
  if (copied > 0) log(`tag plugins: ${String(copied)} file(s) synced from ${a.tagPluginsDir}`)
}

/**
 * Make sure this pinned release is unpacked and its runtime is installed.
 * Resolves to `{ root, python }` for the spawn path; throws with a readable message otherwise.
 */
export async function provisionArtifact(a, log = () => {}) {
  if (!a.commit) throw new Error('horon.lock.json has no pinned commit; nothing to download')
  if (!a.url) throw new Error('horon.lock.json has no artifact baseUrl; nothing to download')

  const marker = path.join(a.root, INSTALLED)
  const python = venvPython(a.appDir)
  if (existsSync(marker) && existsSync(python)) {
    log(`artifact already installed at ${a.root}`)
    // Still reconcile both: the config may name a different directory since the last start, and
    // tag plugins may have been edited.
    await writeEnv(a, log)
    await syncTagPlugins(a, log)
    return { root: a.appDir, python }
  }

  await fs.mkdir(a.dir, { recursive: true })
  const archive = path.join(a.dir, `${a.commit8}-${a.platform}.tar.gz`)
  if (!existsSync(archive)) {
    log(`downloading ${a.url}`)
    const tmp = `${archive}.part`
    let lastBucket = -1
    const { bytes } = await fetchFile(a.url, tmp, {
      onProgress: ({ seen, total }) => {
        if (!total) return
        const bucket = Math.floor((seen / total) * 10)
        if (bucket > lastBucket) {
          lastBucket = bucket
          log(`  ${String(bucket * 10).padStart(3)}%  ${(seen / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`)
        }
      },
    })
    if (a.sha256) {
      const digest = sha256File(tmp)
      if (digest !== a.sha256) {
        await fs.rm(tmp, { force: true })
        throw new Error(`sha256 mismatch for ${a.asset}: expected ${a.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`)
      }
      log('sha256 verified')
    } else {
      log('no sha256 in honon.lock.json for this platform; skipping verification')
    }
    await fs.rename(tmp, archive)
    log(`downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  } else {
    log(`using the downloaded ${path.basename(archive)}`)
  }

  log(`unpacking into ${a.root}`)
  await extract(archive, a.root, log)
  await writeEnv(a, log)
  await syncTagPlugins(a, log)

  log('installing the runtime from the bundled wheels (no network)')
  const done = await run(a.basePython, [path.join(a.root, 'bootstrap.py')], {
    cwd: a.root,
    onLine: (line) => log(line.trimEnd()),
  })
  if (done.code !== 0) throw new Error(`bootstrap failed (${String(done.code)}): ${done.out.trim().slice(-600)}`)
  if (!existsSync(python)) {
    // bootstrap fell back to app/vendor; the plugin puts that directory on PYTHONPATH.
    log('bootstrap used the vendor layout; the service runs on the base interpreter')
    await fs.writeFile(marker, JSON.stringify({ at: new Date().toISOString(), vendor: true }, null, 2))
    return { root: a.appDir, python: a.basePython, vendor: true }
  }
  await fs.writeFile(marker, JSON.stringify({ at: new Date().toISOString(), asset: a.asset }, null, 2))
  log(`artifact ready: ${a.root}`)
  return { root: a.appDir, python }
}

export const __internal = { sha256File, venvPython }
