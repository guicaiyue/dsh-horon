#!/usr/bin/env node
// Assemble the deployable Horon tree from a checked-out Horon repository.
//
// This replaces the old docker/build.mjs: nobody — user or release job — is expected to hand a
// repository path to a build anymore. CI checks the pinned commit out, calls this script twice
// (once per target), and publishes the results as a GitHub Release and a Docker image.
//
//   node scripts/assemble.mjs --repo <horon> --out <dir> --platform win-x64 --wheels --build-web
//   node scripts/assemble.mjs --repo <horon> --out <dir> --platform linux-x64            (image ctx)
//
// Flags
//   --repo <dir>        checked-out Horon repository (must contain frontend/cli.py)
//   --out <dir>         output directory; wiped first, so it must not be the plugin root
//   --platform <key>    win-x64 | linux-x64 | linux-arm64 | macos-x64 | macos-arm64
//   --wheels            download platform wheels so the runtime installs offline
//   --build-web         run `npm ci && npm run build` here and ship web/dist (release artifacts)
//   --skills            also refresh <plugin>/skills from the pinned manuals (npm publish)
//
// Output layout (one tarball per platform, unpacked as-is by the plugin's artifact mode):
//
//   app/backend/ app/frontend/ app/.agents/skills/ app/horon_web_app.py app/run_gateway.py
//   app/web/dist/                     only with --build-web
//   wheels/                           only with --wheels
//   bootstrap.py  requirements.lock.txt  manifest.json
//
// Only an explicit allow-list is copied: no .env, no database, no venv / node_modules, no
// personal tag plugins. backend/harness/dsh-plugin is left out too — this repository replaces it.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const DOCKER_DIR = path.join(PLUGIN, 'docker')

// Tag plugins the Horon repository tracks as system plugins; everything else in that directory is
// personal (a write-time gate someone wrote for themselves) and must not travel.
const SYSTEM_TAG_PLUGINS = ['state.py', 'action.py', 'result.py', 'exit.py']
const SKILLS = ['horon-cli', 'horon-circuit', 'horon-plugin']
const APP_FILES = ['run_gateway.py', 'opencode.json', 'requirements.txt', 'LICENSE', 'NOTICE']
const WEB_FILES = ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']
const WEB_DIRS = ['src', 'public']
// Never copied from the Horon repository; `dist` is here because an old checkout may hold one.
const SKIP_NAMES = new Set(['__pycache__', 'node_modules', '.env', '.horon-local', 'dist', '.venv', 'vendor'])
// Never allowed in the output, whatever produced it. `dist` is legitimate at app/web/dist.
const LEAK_NAMES = new Set(['__pycache__', 'node_modules', '.env', '.horon-local', '.venv', 'vendor'])
const SKIP_SUFFIXES = ['.pyc', '.pyo', '.db', '.db-wal', '.db-shm', '.db-journal']
const PYTHON_VERSION = '3.12'

// `pip download --platform` names, so one Linux runner can fetch every target's wheels.
const PIP_PLATFORMS = {
  'win-x64': ['win_amd64'],
  'linux-x64': ['manylinux2014_x86_64', 'manylinux_2_17_x86_64'],
  'linux-arm64': ['manylinux2014_aarch64', 'manylinux_2_17_aarch64'],
  'macos-x64': ['macosx_10_13_x86_64'],
  'macos-arm64': ['macosx_11_0_arm64'],
}

function fail(message) {
  console.error(`assemble.mjs: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { wheels: false, buildWeb: false, skills: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--wheels') args.wheels = true
    else if (flag === '--build-web') args.buildWeb = true
    else if (flag === '--skills') args.skills = true
    else if (flag === '--repo' || flag === '--out' || flag === '--platform' || flag === '--web-dist') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`)
      args[flag.slice(2)] = value
      i += 1
    } else fail(`unknown argument ${flag}`)
  }
  if (args.repo === undefined) fail('--repo is required')
  if (args.out === undefined) fail('--out is required')
  if (args.wheels && args.platform === undefined) fail('--wheels needs --platform')
  if (args.platform !== undefined && PIP_PLATFORMS[args.platform] === undefined) {
    fail(`unknown platform ${args.platform}; expected one of ${Object.keys(PIP_PLATFORMS).join(', ')}`)
  }
  return args
}

function keep(source) {
  const base = path.basename(source)
  return !SKIP_NAMES.has(base) && !SKIP_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

function copy(from, to, filter = keep) {
  if (!fs.existsSync(from)) fail(`missing ${from}`)
  fs.cpSync(from, to, { recursive: true, filter })
}

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(command, args, options = {}) {
  // Node refuses to spawn .cmd/.bat without a shell on Windows (EINVAL since the 2024 CVE fix).
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const done = spawnSync(command, args, { stdio: 'inherit', shell, ...options })
  if (done.error) fail(`${command} failed: ${done.error.message}`)
  if (done.status !== 0) fail(`${command} ${args.join(' ')} exited with ${String(done.status)}`)
}

function pipCommand() {
  if (process.env.PIP !== undefined && process.env.PIP !== '') return process.env.PIP
  return process.platform === 'win32' ? 'python' : 'python3'
}

// `npm` is a .cmd shim on Windows; spawnSync without a shell cannot find it by bare name.
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

const args = parseArgs(process.argv.slice(2))
const REPO = path.resolve(args.repo)
const OUT = path.resolve(args.out)
const PLUGIN_JSON = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const LOCK = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'horon.lock.json'), 'utf8'))

if (!fs.existsSync(path.join(REPO, 'frontend', 'cli.py'))) {
  fail(`${REPO} does not look like a Horon repository (no frontend/cli.py)`)
}
if (OUT === PLUGIN || PLUGIN.startsWith(OUT + path.sep)) fail('refusing to write over the plugin directory')

reset(OUT)
const app = path.join(OUT, 'app')
const web = path.join(OUT, 'web')

// ---- backend (minus the two directories handled separately) -----------------------------------
const backendSrc = path.join(REPO, 'backend')
const tagPluginsSrc = path.join(backendSrc, 'tag_plugins')
const LEGACY_PLUGIN = path.join(backendSrc, 'harness', 'dsh-plugin')
const outsideExcluded = (source) =>
  ![tagPluginsSrc, LEGACY_PLUGIN].some((dir) => source === dir || source.startsWith(dir + path.sep))
copy(backendSrc, path.join(app, 'backend'), (source) => keep(source) && outsideExcluded(source))
fs.mkdirSync(path.join(app, 'backend', 'tag_plugins'), { recursive: true })
for (const file of SYSTEM_TAG_PLUGINS) {
  const source = path.join(tagPluginsSrc, file)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(app, 'backend', 'tag_plugins', file))
}
copy(path.join(REPO, 'frontend'), path.join(app, 'frontend'))
for (const file of APP_FILES) copy(path.join(REPO, file), path.join(app, file))
for (const skill of SKILLS) {
  copy(path.join(REPO, '.agents', 'skills', skill, 'SKILL.md'), path.join(app, '.agents', 'skills', skill, 'SKILL.md'))
}
// The bridge that serves /api/cli and /api/hook/*; versioned with the plugin, not with Horon.
copy(path.join(PLUGIN, 'horon_web_app.py'), path.join(app, 'horon_web_app.py'))
copy(path.join(PLUGIN, 'scripts', 'bootstrap.py'), path.join(OUT, 'bootstrap.py'))
copy(path.join(DOCKER_DIR, 'requirements.lock.txt'), path.join(OUT, 'requirements.lock.txt'))

// ---- console front end ------------------------------------------------------------------------
for (const file of WEB_FILES) copy(path.join(REPO, 'web', file), path.join(web, file))
for (const dir of WEB_DIRS) {
  if (fs.existsSync(path.join(REPO, 'web', dir))) copy(path.join(REPO, 'web', dir), path.join(web, dir))
}
let webDist = args['web-dist'] === undefined ? undefined : path.resolve(args['web-dist'])
if (args.buildWeb) {
  // A mirror 503 in the middle of `npm ci` costs a full rebuild; let npm retry instead.
  const retries = ['--fetch-retries=5', '--fetch-retry-mintimeout=2000', '--fetch-retry-maxtimeout=60000']
  run(npmCommand(), ['ci', '--no-audit', '--no-fund', ...retries], { cwd: web })
  run(npmCommand(), ['run', 'build'], { cwd: web })
  webDist = path.join(web, 'dist')
} else if (args['web-dist'] !== undefined && !fs.existsSync(webDist)) {
  fail(`--web-dist ${webDist} does not exist`)
}
if (webDist !== undefined) {
  // Ship the built console, not a second copy of the sources. A plain recursive copy: the
  // copy filter would drop the directory itself, since its name is `dist`.
  fs.cpSync(webDist, path.join(app, 'web', 'dist'), { recursive: true })
  fs.rmSync(web, { recursive: true, force: true })
}

// ---- offline wheels ---------------------------------------------------------------------------
if (args.wheels) {
  const wheels = path.join(OUT, 'wheels')
  fs.mkdirSync(wheels, { recursive: true })
  const pipArgs = ['-m', 'pip', 'download', '--quiet', '--disable-pip-version-check', '--no-input',
    '--only-binary=:all:', '--python-version', PYTHON_VERSION,
    '--implementation', 'cp', '--abi', `cp${PYTHON_VERSION.replace('.', '')}`, '-d', wheels,
    '-r', path.join(OUT, 'requirements.lock.txt')]
  for (const platform of PIP_PLATFORMS[args.platform]) pipArgs.push('--platform', platform)
  // A cp936 console turns pip's own progress output into a UnicodeDecodeError; pin the streams.
  run(pipCommand(), pipArgs, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
  const count = fs.readdirSync(wheels).filter((name) => name.endsWith('.whl')).length
  if (count === 0) fail('no wheels were downloaded')
  console.log(`wheels: ${String(count)} files for ${args.platform}`)
}

// ---- manuals for hosts that cannot read the repository ----------------------------------------
if (args.skills) {
  const skillsOut = path.join(PLUGIN, 'skills')
  reset(skillsOut)
  for (const skill of SKILLS) {
    copy(path.join(REPO, '.agents', 'skills', skill, 'SKILL.md'), path.join(skillsOut, skill, 'SKILL.md'))
  }
  console.log(`skills: ${skillsOut}`)
}

// ---- manifest + last-line-of-defence check ----------------------------------------------------
const files = []
for (const entry of fs.readdirSync(OUT, { recursive: true })) {
  const full = path.join(OUT, entry)
  if (!fs.statSync(full).isFile()) continue
  const parts = entry.split(path.sep)
  if (parts.some((part) => LEAK_NAMES.has(part)) || SKIP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
    fail(`unexpected file in the output: ${entry}`)
  }
  files.push(entry.split(path.sep).join('/'))
}
const manifest = {
  name: 'horon-app',
  plugin: PLUGIN_JSON.name,
  pluginVersion: PLUGIN_JSON.version,
  platform: args.platform ?? 'any',
  python: PYTHON_VERSION,
  horon: LOCK.horon,
  builtAt: new Date().toISOString(),
  webDist: fs.existsSync(path.join(app, 'web', 'dist')),
  wheels: fs.existsSync(path.join(OUT, 'wheels')),
  files: files.length,
  license: 'Horon is Apache-2.0 with an attribution condition; see app/NOTICE',
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`horon repository: ${REPO} @ ${LOCK.horon.commit.slice(0, 8)}`)
console.log(`output:           ${OUT}  (${String(files.length)} files)`)
console.log(`next: tar -czf horon-app-${args.platform ?? 'any'}-${LOCK.horon.commit.slice(0, 8)}.tar.gz -C ${OUT} .`)
