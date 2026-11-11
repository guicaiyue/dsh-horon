// End-to-end check of artifact mode without dsh and without GitHub: serve a locally assembled
// tarball over HTTP, let artifact.js download + verify + unpack + bootstrap it, then start the
// service from the unpacked tree and call the two endpoints the plugin depends on.
//
//   node scripts/assemble.mjs --repo ~/horon --out .build/a2 --platform win-x64 --wheels
//   (cd .build && tar -czf horon-app-<platform>-<commit8>.tar.gz -C a2 .)
//   (cd .build && python -m http.server 8799 &)
//   node test/artifact-smoke.mjs .build/horon-app-<platform>-<commit8>.tar.gz http://127.0.0.1:8799
//   node test/artifact-smoke.mjs --remote      # the real thing: download the released asset
//
// The argument is optional: with no archive it only checks the pure functions (platform key,
// settings) so the test stays useful in CI where nothing was assembled. `--remote` downloads the
// asset the lock file points at, verifies the digest recorded there and runs it.

import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { artifactSettings, artifactStatus, platformKey, provisionArtifact } from '../artifact.js'

const remote = process.argv.includes('--remote')
const archive = remote ? undefined : process.argv[2]
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:8799'

// ---- pure functions ----------------------------------------------------------------------------
assert.equal(platformKey('win32', 'x64'), 'win-x64')
assert.equal(platformKey('linux', 'arm64'), 'linux-arm64')
assert.equal(platformKey('darwin', 'arm64'), 'macos-arm64')

const defaults = artifactSettings({})
assert.match(defaults.platform, /^(win|linux|macos)-/)
// One data directory decides everything else.
assert.ok(defaults.dataDir.endsWith('.horon'), defaults.dataDir)
assert.equal(path.dirname(defaults.dbFile), defaults.dataDir)
assert.ok(defaults.dir.endsWith(path.join('.horon', 'runtime')), defaults.dir)
// Releases are fetched through the proxy by default, and directly when it is cleared.
assert.equal(defaults.proxy, 'https://gh-proxy.com')
assert.ok(defaults.url.startsWith('https://gh-proxy.com/https://github.com/'), defaults.url)
const direct = artifactSettings({ proxy: '' })
assert.ok(direct.url.startsWith('https://github.com/'), direct.url)

const pinned = artifactSettings({ horonCommit: 'a'.repeat(40) })
assert.equal(pinned.commit8, 'a'.repeat(8))
assert.ok(pinned.url.includes('a'.repeat(8)), pinned.url)
console.log('settings ok:', pinned.url)

if (archive === undefined && !remote) {
  console.log('no archive given: settings only')
  process.exit(0)
}

// ---- provisioning over HTTP --------------------------------------------------------------------
const scratch = path.resolve('.build/smoke')
await fs.rm(scratch, { recursive: true, force: true })

let settings
if (remote) {
  // No overrides: exactly what a user's plugin does with the published lock file.
  settings = artifactSettings({ artifactDir: path.join(scratch, 'runtime'), dataDir: path.join(scratch, 'data') })
  console.log('remote asset:', settings.url)
  assert.ok(settings.sha256, 'the lock file has no digest for this platform; run scripts/lock-sync.mjs digests')
} else {
  const file = path.resolve(archive)
  assert.ok(existsSync(file), `${file} does not exist`)
  const name = path.basename(file)
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  settings = artifactSettings({
    artifactUrl: `${baseUrl}/${name}`,
    artifactSha256: sha256,
    artifactDir: path.join(scratch, 'runtime'),
    dataDir: path.join(scratch, 'data'),
  })
}

const lines = []
const started = Date.now()
const prepared = await provisionArtifact(settings, (line) => lines.push(String(line).trimEnd()))
console.log(`provisioned in ${((Date.now() - started) / 1000).toFixed(1)}s: ${prepared.python}`)
assert.ok(lines.some((line) => line.includes('sha256 verified')), 'the digest was not checked')
assert.ok(existsSync(prepared.python), `no interpreter at ${prepared.python}`)
assert.ok(existsSync(path.join(settings.appDir, '.ready.json')), 'bootstrap left no .ready.json')
assert.ok(existsSync(path.join(settings.appDir, '.env')), 'no .env was written')

const state = await artifactStatus(settings)
assert.equal(state.ready, true)
assert.equal(state.installed, true)

// Second run must be a no-op (that is what makes every later start cheap).
const again = await provisionArtifact(settings, () => {})
assert.equal(again.python, prepared.python)

// ---- the service itself ------------------------------------------------------------------------
const port = 8791
const child = spawn(
  prepared.python,
  ['-m', 'uvicorn', 'horon_web_app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
  {
    cwd: settings.appDir,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: [settings.appDir, path.join(settings.appDir, 'vendor')].filter(Boolean).join(path.delimiter),
      HORON_ROOT: settings.appDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
)
const log = []
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => log.push(chunk))
child.stderr.on('data', (chunk) => log.push(chunk))

const base = `http://127.0.0.1:${String(port)}`
let up = false
for (let i = 0; i < 60 && !up; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  try {
    up = (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {}
}
if (!up) {
  console.error(log.join(''))
  child.kill()
  throw new Error('the service did not come up')
}

const cli = await fetch(`${base}/api/cli`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ args: ['list_tags'] }),
  signal: AbortSignal.timeout(120_000),
})
const cliBody = await cli.json()
assert.equal(cli.status, 200)
assert.ok('stdout' in cliBody, JSON.stringify(cliBody).slice(0, 300))
assert.equal(cliBody.code, 0, `cli exited ${String(cliBody.code)}: ${String(cliBody.stderr ?? '').slice(0, 300)}`)
console.log('api/cli ok:', String(cliBody.stdout ?? '').slice(0, 80).replace(/\n/g, ' '))

const hook = await fetch(`${base}/api/hook/Stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(120_000),
})
assert.equal(hook.status, 200)
console.log('api/hook/Stop ok')

child.kill()
console.log('artifact smoke ok')
