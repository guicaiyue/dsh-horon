// Smoke test for the dsh-horon host half, no dsh needed: a fake cordis context drives apply()
// and the settings endpoints, so a wiring change that would only fail inside a live session
// fails here first.
//
//   node test/host-smoke.mjs
//
// Covers: both import paths, the registered hooks and route, the guard chain's fail-open
// behaviour (counted, not thrown), the degraded banner, the /status payload, and — when this
// machine has a Horon service on 8710 — the healthy path (nothing denied, nothing failed).
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LIVE = 'http://127.0.0.1:8710'

// Every apply() seeds the bundled tag plugins, so it must be pointed at a throwaway dataDir:
// a smoke run may not write into the real ~/.horon.
const SEED_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'horon-smoke-'))
const SEEDED = { dataDir: SEED_DATA_DIR }

function makeCtx() {
  const handlers = new Map() // event -> [fn]
  const routes = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register: (def) => assert.equal(def.name, 'horon') },
    systemPrompt: { section: (section) => assert.ok(section.name) },
    skills: { registerProvider: () => {} },
    webServer: { register: (route) => routes.push(route) },
    connection: { requestRejection: () => undefined },
    effect: (run) => {
      const stop = run()
      return () => stop?.()
    },
    inject: (_deps, run) => run(ctx),
    get: () => undefined,
    on: (event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    },
    fiber: { entry: { options: { id: 'dsh-horon' } } },
  }
  return { ctx, handlers, routes }
}

// A headless-shaped context: no webServer, no connection, no skills, no fiber — that is what the
// `headless` profile mounts (agent-autoloop drives dsh this way), and apply() has to survive it.
function makeHeadlessCtx() {
  const handlers = new Map()
  const registered = []
  const asks = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register: (def) => registered.push(def.name) },
    systemPrompt: { section: (section) => registered.push('prompt:' + section.name) },
    effect: (run) => {
      const stop = run()
      return () => stop?.()
    },
    // cordis only runs an inject() callback when every dependency exists; this context provides
    // tools and systemPrompt (dsh-base does) but not webServer / connection / skills.
    inject: (deps, run) => {
      asks.push(deps.join('+'))
      const available = new Set(['tools', 'systemPrompt'])
      if (!deps.every((dep) => available.has(dep))) return
      run(ctx)
    },
    get: () => undefined,
    on: (event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    },
  }
  return { ctx, handlers, registered, asks }
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    end(body) {
      this.body = body
    },
    destroy() {},
    pipe() {},
  }
}

async function status(routes) {
  const res = fakeRes()
  await routes[0].handler({ method: 'GET', url: '/dsh-horon/_dsh/status', headers: {}, on() {} }, res)
  assert.equal(res.statusCode, 200, `status answered ${res.statusCode}: ${res.body}`)
  return JSON.parse(res.body)
}

const mod = await import('../index.js')
assert.equal(mod.name, 'dsh-horon')

// ---- 1. wiring ------------------------------------------------------------------------------
const dead = makeCtx()
// url mode pointed at a closed port: nothing is spawned, and every gateway call fails.
mod.apply(dead.ctx, { mode: 'url', url: 'http://127.0.0.1:9', ...SEEDED })
assert.equal(dead.handlers.get('tools/pre-execute')?.length, 1, 'the guard hook is registered')
assert.equal(dead.handlers.get('agent/pre-step')?.length, 1, 'the prompt hook is registered')
assert.equal(dead.routes.length, 1, 'the console route is registered')
assert.equal(dead.routes[0].path, '/dsh-horon')

// ---- 2. fail-open, and it is counted --------------------------------------------------------
const preExecute = dead.handlers.get('tools/pre-execute')[0]
let nextCalled = 0
const decision = await preExecute(
  { name: 'pwsh', arguments: {}, agent: { id: 'smoke-dead' } },
  async () => {
    nextCalled++
    return { kind: 'allow' }
  },
)
assert.deepEqual(decision, { kind: 'allow' }, 'a dead gateway must not block the tool')
assert.equal(nextCalled, 1, 'next() still runs')

const deadStatus = await status(dead.routes)
assert.equal(deadStatus.mode, 'url')
assert.equal(deadStatus.hooks.enabled, true)
assert.equal(deadStatus.hooks.calls, 1, JSON.stringify(deadStatus.hooks))
assert.equal(deadStatus.hooks.failed, 1, JSON.stringify(deadStatus.hooks))
assert.equal(deadStatus.hooks.degraded, true)
assert.match(String(deadStatus.hooks.lastError), /PreToolUse/)

// ---- 3. the degraded session is told once ---------------------------------------------------
const preStep = dead.handlers.get('agent/pre-step')[0]
const step = await preStep(
  { agent: { id: 'smoke-dead' }, messages: [] },
  async () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  }),
)
const banners = (step.messages ?? []).map((m) => m.content?.[0]?.text ?? '')
assert.ok(banners.some((text) => text.includes('拦截链未生效')), JSON.stringify(banners))

// ---- 4. healthy path (needs a Horon service on this machine) ---------------------------------
const serving = await fetch(`${LIVE}/api/sessions`, { signal: AbortSignal.timeout(1200) })
  .then((response) => response.ok)
  .catch(() => false)
if (!serving) {
  console.log(`skip: no Horon service on ${LIVE}, the healthy path was not exercised`)
} else {
  const live = makeCtx()
  mod.apply(live.ctx, { mode: 'url', url: LIVE, ...SEEDED })
  const liveDecision = await live.handlers.get('tools/pre-execute')[0](
    { name: 'pwsh', arguments: { command: 'echo hi' }, agent: { id: 'smoke-live' } },
    async () => ({ kind: 'allow' }),
  )
  assert.deepEqual(liveDecision, { kind: 'allow' }, 'a healthy gateway passes the call through')
  const liveStatus = await status(live.routes)
  assert.equal(liveStatus.hooks.failed, 0, JSON.stringify(liveStatus.hooks))
  assert.ok(liveStatus.hooks.calls >= 1, JSON.stringify(liveStatus.hooks))
  console.log('healthy service:', JSON.stringify(liveStatus.hooks))
}

// ---- 5. recall nudge: fires once per turn, and only when nothing was looked up ----------------
// A turn whose prompt reads like a recall question, with no retrieval call, gets steered once.
{
  const nudged = makeCtx()
  mod.apply(nudged.ctx, { mode: 'url', url: 'http://127.0.0.1:9', ...SEEDED })
  const preStepN = nudged.handlers.get('agent/pre-step')[0]
  const stopN = nudged.handlers.get('agent/turn-stopping')[0]
  const steered = []
  const agent = { id: 'smoke-nudge', steer: (m) => steered.push(m), session: { header: {} } }

  await preStepN({ agent, messages: [] }, async () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '本机的截图快捷键是怎么配的' }] }],
  }))
  await stopN({ agent, signal: undefined })
  assert.equal(steered.length, 1, 'one nudge for a recall-shaped prompt that did not search')
  assert.ok(String(steered[0].content?.[0]?.text ?? steered[0]).includes('查'), 'the nudge says to search')

  // A second Stop in the same turn must not steer again.
  await stopN({ agent, signal: undefined })
  assert.equal(steered.length, 1, 'the nudge is once per turn')
}

// A turn that did search gets no nudge.
{
  const quiet = makeCtx()
  mod.apply(quiet.ctx, { mode: 'url', url: 'http://127.0.0.1:9', ...SEEDED })
  const preStepQ = quiet.handlers.get('agent/pre-step')[0]
  const preExecQ = quiet.handlers.get('tools/pre-execute')[0]
  const stopQ = quiet.handlers.get('agent/turn-stopping')[0]
  const steered = []
  const agent = { id: 'smoke-quiet', steer: (m) => steered.push(m), session: { header: {} } }

  await preStepQ({ agent, messages: [] }, async () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '本机的截图快捷键是怎么配的' }] }],
  }))
  await preExecQ(
    { name: 'horon', arguments: { args: ['search_keyword', '截图'] }, agent },
    async () => ({ kind: 'allow' }),
  )
  await stopQ({ agent, signal: undefined })
  assert.equal(steered.length, 0, 'a turn that already searched is not nudged')
}

// ---- 6. abort tells Horon to end the turn ---------------------------------------------------
{
  const aborted = makeCtx()
  mod.apply(aborted.ctx, { mode: 'url', url: 'http://127.0.0.1:9', ...SEEDED })
  const stopA = aborted.handlers.get('agent/turn-stopping')[0]
  const steered = []
  const agent = { id: 'smoke-abort', steer: (m) => steered.push(m), session: { header: {} } }
  const signal = { aborted: true }
  await stopA({ agent, signal })
  assert.equal(steered.length, 0, 'an aborted turn is not steered')
  const st = await status(aborted.routes)
  assert.ok(st.hooks.calls >= 1, 'abort still reached the gateway (Interrupt): ' + JSON.stringify(st.hooks))
}

// ---- 7. boot nodes are injected on the first turn (needs the live service) -------------------
if (serving) {
  const boot = makeCtx()
  mod.apply(boot.ctx, { mode: 'url', url: LIVE, ...SEEDED })
  const step = await boot.handlers.get('agent/pre-step')[0](
    { agent: { id: `smoke-boot-${Date.now()}`, session: { header: {} } }, messages: [] },
    async () => ({
      kind: 'enter',
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
    }),
  )
  const texts = (step.messages ?? []).map((m) => m.content?.[0]?.text ?? '')
  assert.ok(
    texts.some((text) => text.includes('启动清单')),
    'the first turn carries the boot nodes: ' + JSON.stringify(texts.map((t) => t.slice(0, 60))),
  )
}

// ---- 8. the bundled tag plugins ship with the package and seed without a network -------------
{
  const seed = await import('../seed.js')
  const { mkdtemp, readdir, rm, readFile } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')

  assert.ok(seed.BUNDLED_TAG_PLUGINS.length >= 1, 'at least one tag plugin ships with the package')
  for (const spec of seed.BUNDLED_TAG_PLUGINS) {
    assert.ok(spec.tag && spec.file && spec.content && spec.whenToRead, 'a bundled spec is complete: ' + spec.tag)
    // The bundled file has to be the one the service would load, so it must exist and be compilable.
    const text = await readFile(path.join(seed.bundledTagPluginsDir, spec.file), 'utf8')
    assert.ok(text.includes('DESCRIPTION'), spec.file + ' declares DESCRIPTION')
    assert.ok(text.includes('def on_mutation') && text.includes('def audit_cluster'),
      spec.file + ' defines both entry points')
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'seed-smoke-'))
  // A service nobody listens on: the copy step still has to work, and the tag step has to fail
  // soft rather than take the plugin down.
  const out = await seed.seedTagPlugins({ tagPluginsDir: tmp, base: 'http://127.0.0.1:9' })
  assert.deepEqual(out.copied, seed.BUNDLED_TAG_PLUGINS.map((s) => s.file), 'files were copied')
  assert.deepEqual(await readdir(tmp), seed.BUNDLED_TAG_PLUGINS.map((s) => s.file), 'files landed')
  assert.equal(out.registered.length, 0, 'nothing registered without a service')
  assert.ok(out.failed.length >= 1, 'the missing service is reported, not thrown')
  await rm(tmp, { recursive: true, force: true })
}

await rm(SEED_DATA_DIR, { recursive: true, force: true })

// ---- 9. headless shape: autoloop drives dsh with --profile headless, which mounts no web server --
{
  const head = makeHeadlessCtx()
  mod.apply(head.ctx, { mode: 'url', url: 'http://127.0.0.1:9', ...SEEDED })
  assert.deepEqual(head.registered, ['horon', 'prompt:horon:memory-policy'], 'the tool and the policy section still mount')
  assert.ok(head.handlers.get('agent/pre-step'), 'the lifecycle hooks still mount without a web server')
  // The console route must be requested through inject() — i.e. it waits for a web server that
  // headless never mounts — instead of being registered (or assumed) unconditionally.
  assert.ok(
    head.asks.includes('webServer+connection'),
    'the console route asked for webServer+connection: ' + JSON.stringify(head.asks),
  )
  assert.ok(
    head.asks.includes('skills'),
    'the skills provider asked for the skills service: ' + JSON.stringify(head.asks),
  )
}

console.log('smoke ok')
