#!/usr/bin/env node
// Assemble the Docker build context for the Horon service, and refresh the plugin's skills/ copy.
//
//   node docker/build.mjs [path/to/horon]      (or set HORON_REPO; default ~/horon)
//
// Output (both are regenerated from scratch on every run):
//   docker/context/            build context for docker/Dockerfile
//     app/                     Horon backend + CLI + manuals + horon_web_app.py
//     web/                     console front-end build inputs (built inside the image)
//     Dockerfile, entrypoint.sh, requirements.lock.txt, .dockerignore
//   skills/                    horon-cli / horon-circuit / horon-plugin manuals, served by the
//                              plugin's skill provider on hosts without the Horon repository
//
// Only an explicit allow-list is copied: no .env, no database, no venv / node_modules, no
// personal tag plugins, no local scratch directories. backend/harness/dsh-plugin is left out as
// well: that is the old "mount it by file:// URL" dsh plugin, and this repository replaces it
// (harness.js), so a copy inside the image would only be dead weight.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCKER_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.dirname(DOCKER_DIR)
const CONTEXT = path.join(DOCKER_DIR, 'context')
const SKILLS_OUT = path.join(PLUGIN_DIR, 'skills')

const REPO = path.resolve(process.argv[2] ?? process.env.HORON_REPO ?? path.join(os.homedir(), 'horon'))
const SKILLS = ['horon-cli', 'horon-circuit', 'horon-plugin']
// System tag plugins tracked by the Horon repository (.gitignore whitelist); the rest are personal.
const TAG_PLUGINS = ['state.py', 'action.py', 'result.py', 'exit.py']
const APP_FILES = ['run_gateway.py', 'opencode.json', 'requirements.txt', 'LICENSE', 'NOTICE']
const WEB_FILES = ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']
const WEB_DIRS = ['src', 'public']
const DOCKER_FILES = ['Dockerfile', 'entrypoint.sh', 'requirements.lock.txt', '.dockerignore']
// Never copied, whatever directory they turn up in.
const SKIP_NAMES = new Set(['__pycache__', 'node_modules', '.env', '.horon-local', 'dist'])
const SKIP_SUFFIXES = ['.pyc', '.pyo', '.db', '.db-wal', '.db-shm', '.db-journal']

function fail(message) {
  console.error(`build.mjs: ${message}`)
  process.exit(1)
}

function keep(source) {
  const base = path.basename(source)
  return !SKIP_NAMES.has(base) && !SKIP_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

function copy(from, to, filter = keep) {
  if (!fs.existsSync(from)) fail(`missing ${from}`)
  fs.cpSync(from, to, { recursive: true, filter })
}

// Wipe a directory this script owns; refuse anything else.
function reset(dir, expectedParent) {
  if (path.dirname(dir) !== expectedParent) fail(`refusing to clear ${dir}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

if (!fs.existsSync(path.join(REPO, 'frontend', 'cli.py'))) {
  fail(`${REPO} does not look like a Horon repository (no frontend/cli.py)`)
}

reset(CONTEXT, DOCKER_DIR)
const app = path.join(CONTEXT, 'app')
const web = path.join(CONTEXT, 'web')

// backend/: everything except the two directories handled separately below.
const backendSrc = path.join(REPO, 'backend')
const tagPluginsSrc = path.join(backendSrc, 'tag_plugins')
// The old file://-mounted dsh plugin; harness.js replaces it in this repository.
const DSH_PLUGIN_SRC = path.join(backendSrc, 'harness', 'dsh-plugin')
const outsideExcluded = (source) =>
  ![tagPluginsSrc, DSH_PLUGIN_SRC].some((dir) => source === dir || source.startsWith(dir + path.sep))
copy(backendSrc, path.join(app, 'backend'), (source) => keep(source) && outsideExcluded(source))
fs.mkdirSync(path.join(app, 'backend', 'tag_plugins'), { recursive: true })
for (const file of TAG_PLUGINS) {
  const source = path.join(tagPluginsSrc, file)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(app, 'backend', 'tag_plugins', file))
}

copy(path.join(REPO, 'frontend'), path.join(app, 'frontend'))
for (const file of APP_FILES) copy(path.join(REPO, file), path.join(app, file))
for (const skill of SKILLS) {
  copy(path.join(REPO, '.agents', 'skills', skill, 'SKILL.md'), path.join(app, '.agents', 'skills', skill, 'SKILL.md'))
}
copy(path.join(PLUGIN_DIR, 'horon_web_app.py'), path.join(app, 'horon_web_app.py'))

for (const file of WEB_FILES) copy(path.join(REPO, 'web', file), path.join(web, file))
for (const dir of WEB_DIRS) {
  if (fs.existsSync(path.join(REPO, 'web', dir))) copy(path.join(REPO, 'web', dir), path.join(web, dir))
}

for (const file of DOCKER_FILES) copy(path.join(DOCKER_DIR, file), path.join(CONTEXT, file))

reset(SKILLS_OUT, PLUGIN_DIR)
for (const skill of SKILLS) {
  copy(path.join(REPO, '.agents', 'skills', skill, 'SKILL.md'), path.join(SKILLS_OUT, skill, 'SKILL.md'))
}

// Last line of defence: nothing secret or stateful may have slipped into the context.
const leaks = []
for (const entry of fs.readdirSync(CONTEXT, { recursive: true })) {
  if (!keep(entry) || entry.split(path.sep).some((part) => SKIP_NAMES.has(part))) leaks.push(entry)
}
if (leaks.length) fail(`unexpected files in the build context: ${leaks.join(', ')}`)

console.log(`Horon repository: ${REPO}`)
console.log(`build context:    ${CONTEXT}`)
console.log(`skills copy:      ${SKILLS_OUT}`)
console.log('next: deploy from the dsh settings page (Settings → Horon service), or here:')
console.log('      docker build -t horon-service:local context && docker compose up -d   (from the docker/ directory)')
