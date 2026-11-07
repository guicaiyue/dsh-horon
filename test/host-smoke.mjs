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

const LIVE = 'http://127.0.0.1:8710'

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
mod.apply(dead.ctx, { mode: 'url', url: 'http://127.0.0.1:9' })
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
  mod.apply(live.ctx, { mode: 'url', url: LIVE })
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

console.log('smoke ok')
