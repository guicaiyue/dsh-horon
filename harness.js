// Horon Harness half of the dsh-horon plugin: the `horon` tool, the memory-policy prompt section,
// and the Horon lifecycle hooks.
//
// Tool: `horon` takes the CLI argument list and runs `python frontend/cli.py <args>` from the
// Horon repository root. Commands and flags are documented in the Horon CLI skill
// (.agents/skills/horon-cli/SKILL.md), not in this schema, so every host follows the same manual.
// The process is spawned by the dsh host, not through ctx.sandbox: Horon writes its database on
// every call (audit log, attention transitions), which a workspace-write shell sandbox would
// refuse when the database lives outside the session workspace.
//
// Hooks: dsh events are turned into the same lifecycle events the opencode plugin sends and
// handed, as JSON on stdin, to `python run_gateway.py <Event> --adapter dsh`. All Horon logic
// stays in Python (backend/harness/adapters/opencode.py documents the payloads and replies).
// Tool names and arguments reach Horon as dsh has them (pwsh, edit, horon {args: [...]}), so
// only rules written for those names apply here, not the ones written for Claude Code's tools.
//   agent/pre-step        -> UserPromptSubmit when the step admits a message she typed
//                            (source kind 'user'); SessionStart(source=compact) on the first
//                            step after a compaction that no user message starts. The banner
//                            enters the step as one more user message with source kind 'horon'.
//   tools/pre-execute     -> PreToolUse        (deny -> {kind:'deny', reason})
//   tools/post-execute    -> PostToolUse       (banner -> additionalContexts, after the result)
//   agent/turn-stopping   -> Stop              (block -> agent.steer(reason), the turn runs one
//                                               more step; the Stop after it does not block)
//   session/event compaction/end, agent/created source compact|clear
//                         -> marks the session compacted; the next UserPromptSubmit carries reset
//
// Applied by index.js from the same `dsh-horon` row (config: root, python, url, hooks).
// config.hooks: false (or env HORON_HOOKS=off) keeps only the tool.
//
// Two ways to reach Horon:
//   - spawn (no `url`): python runs locally from `root`, as described above.
//   - service (`url` set, e.g. the Docker image in docker/): the tool posts to `<url>/api/cli` and
//     each hook to `<url>/api/hook/<Event>`; the service runs the same two scripts next to its own
//     database. The service has no auth, so `url` should only point inside a trusted network.
//     Files named by the CLI's file flags live on this machine, not on the service, so the tool
//     reads or writes them here: --content-file/--old-file/--new-file/--append-file are sent as
//     their text, `batch --file` as stdin, and `read_memory --out` is written here. Relative paths
//     resolve against the session's working directory. File flags written inside a batch file
//     still resolve on the service.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

// Defaults must not carry anybody's absolute path: a clone on another machine has to work with
// no `root`/`python` at all. The Horon repository is `~/horon` unless the profile says otherwise.
export function defaultRoot() {
  return path.join(os.homedir(), 'horon')
}

// The interpreter that has fastapi + uvicorn: the repository venv when it exists, else PATH python.
export function defaultPython(root) {
  const venv =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python'
}

const GATEWAY_TIMEOUT_MS = 45_000 // Jev alone may take 20 s
const SOURCE_KIND = 'horon'
const UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
// CLI flags whose value is a file on the caller's machine, mapped to the flag that takes the text.
const TEXT_FILE_FLAGS = {
  '--content-file': '--content',
  '--content_file': '--content',
  '--old-file': '--old',
  '--new-file': '--new',
  '--append-file': '--append',
}

function settings(config) {
  const root = config.root ?? defaultRoot()
  const url = typeof config.url === 'string' && config.url.trim() ? config.url.trim().replace(/\/+$/, '') : undefined
  return { root, python: config.python ?? defaultPython(root), url }
}

// Run `python <script> <args>` in the Horon root, feeding `stdin`; resolve {code, out, err}.
function runPython(config, script, args, { stdin, env, signal, timeoutMs } = {}) {
  const { root, python } = settings(config)
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, script), ...args], {
      cwd: root,
      env: { ...process.env, ...UTF8_ENV, ...env },
      shell: false,
      windowsHide: true,
      signal,
    })
    const out = []
    const err = []
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin ?? '')
  })
}

// POST `body` (a string is sent as is) to the Horon service; resolve {code, out, err} like
// runPython. node:http rather than fetch: undici gives up on a response after 300 s, and an
// `audit` over the whole graph can take longer (the service caps it, see horon_web_app.py).
function postService(base, route, body, { signal, timeoutMs } = {}) {
  const target = new URL(base + route)
  const client = target.protocol === 'https:' ? https : http
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length },
      signal,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`Horon service ${target.pathname} answered HTTP ${res.statusCode}: ${text.slice(0, 500)}`))
          return
        }
        try {
          const reply = JSON.parse(text)
          resolve({ code: reply.code, out: reply.stdout ?? '', err: reply.stderr ?? '' })
        } catch {
          reject(new Error(`Horon service ${target.pathname} did not answer JSON: ${text.slice(0, 200)}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Horon service ${target.pathname} timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end(data)
  })
}

// Service mode: the CLI arguments with every local file flag resolved here (see the header
// comment). Returns {args, stdin, outFile}; outFile is the `read_memory --out` target to write.
async function localizeArgs(argv, cwd) {
  const [command, ...rest] = argv
  const args = command === undefined ? [] : [command]
  const fromFile = new Map() // text flag -> file flag it came from
  const explicit = new Set() // text flags given directly
  let stdin
  let outFile
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '--') {
      args.push(...rest.slice(i)) // argparse: everything after `--` is positional
      break
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = eq === -1 ? token : token.slice(0, eq)
    const takeValue = () => (eq === -1 ? rest[++i] : token.slice(eq + 1))
    const textFlag = TEXT_FILE_FLAGS[flag]
    if (textFlag !== undefined || (command === 'batch' && flag === '--file') || (command === 'read_memory' && flag === '--out')) {
      const value = takeValue()
      if (value === undefined) {
        args.push(token) // let argparse report the missing value
        continue
      }
      const file = path.resolve(cwd, value)
      if (textFlag !== undefined) {
        // `=` keeps text that starts with "-" from being read as another option.
        args.push(`${textFlag}=${(await fs.readFile(file, 'utf8')).trimEnd()}`)
        fromFile.set(textFlag, flag)
      } else if (flag === '--file') {
        stdin = await fs.readFile(file, 'utf8')
      } else {
        outFile = { file, shown: value }
      }
      continue
    }
    if (Object.values(TEXT_FILE_FLAGS).includes(flag)) explicit.add(flag)
    args.push(token)
  }
  // Same conflicts the CLI refuses when it reads the files itself.
  for (const [textFlag, fileFlag] of fromFile) {
    if (explicit.has(textFlag)) throw new Error(`Fail. Cannot use both ${textFlag} and ${fileFlag}`)
  }
  return { args, stdin, outFile }
}

// Service mode: one CLI call, with the files it names read and written on this machine.
async function runRemoteCli(url, argv, { sessionId, cwd, signal }) {
  const { args, stdin, outFile } = await localizeArgs(argv, cwd)
  const reply = await postService(url, '/api/cli', {
    args,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  }, { signal })
  if (outFile === undefined || reply.code !== 0) return reply
  // The CLI prints the memory with one "\n" appended; write what it would have written.
  const content = reply.out.endsWith('\n') ? reply.out.slice(0, -1) : reply.out
  await fs.writeFile(outFile.file, content, 'utf8')
  return { ...reply, out: `Success. Wrote ${[...content].length} chars to ${outFile.shown}\n` }
}

// One user-role message carrying a Horon banner, shaped like dsh's own createUserMessage.
function bannerMessage(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  })
}

// Text blocks of a message content or a tool result content, joined.
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

// Shown in every system prompt, so the storage contract travels with the plugin instead of
// depending on a per-host AGENTS.md. Keep it in sync with the horon-cli manual (§2–3): this is a
// summary for the moment a model decides what to write, not a second source of truth.
const MEMORY_POLICY = [
  'Horon 是可执行的记忆图谱，不是会话记录库。写入前按这套规则：',
  '- 一个节点只装一个可复用的概念：能改变下次做法的判断、状态、事实及其依据；不要把整段对话、工具输出或会话日志塞进节点。',
  '- 原始观察只作为 bullet 追加到对应情境节点的「原始记录」；「当前判断」只在自省时改写，被批评的当场不写解释。',
  '- 同一概念只用一个规范节点，新建时写清 when_to_read（什么情况下要打开它），相关观察汇入正文；需要共同检索或维护时再建 Tag。',
  '- 写入前先 list_tags：有写时门禁 Tag（如「记忆入库」）时，新建节点后立刻挂上；被拒就按提示改正文再挂。',
  '- 下次那个时刻不会主动想起来查笔记的做法，做成 sensor/logic/guard 电路，而不是只写 plain。',
  '- 第一次写入前先读 horon-cli 说明书；会话开始时先运行 login 并读完输出。',
].join('\n')

// The guard chain is fail-open by design (a dead service must not brick every tool call), so a
// failure has to be audible: without it, "nothing was blocked" is indistinguishable from
// "the guard never ran".
const GUARD_DOWN_SUMMARY = 'Horon guard chain degraded'
const GUARD_DOWN = [
  '【Horon Harness】拦截链未生效：本会话里 Horon 网关调用失败（原因见 dsh 日志中 dsh-horon 的行）。',
  '在服务恢复之前，工具调用不会被 Horon 的 guard 电路拦截，sensor 提醒也不会送达。',
  '这不是「没有规则」，而是「规则没跑」——修好 Horon 服务（设置 → Horon 服务 看连通性）后新会话即恢复。',
].join('\n')

function registerPolicy(ctx) {
  ctx.systemPrompt.section({
    name: 'horon:memory-policy',
    order: 1800,
    // Sub-agents get a restricted tool set without `horon`; the policy would only add noise there.
    text: (context) => {
      if (context.agent === undefined) return ''
      return context.agent.session?.header?.parentSession === undefined ? MEMORY_POLICY : ''
    },
  })
}

function registerTool(ctx, config) {
  const { root, url } = settings(config)
  const where = url
    ? `on the Horon service at ${url}. File arguments (--content-file, batch --file, read_memory --out, ...) ` +
      `are files on this machine, relative to the session's working directory. `
    : `from the Horon repository root. `
  const manual = url
    ? `the horon-cli skill`
    : path.join(root, '.agents', 'skills', 'horon-cli', 'SKILL.md')
  ctx.tools.register({
    name: 'horon',
    description:
      `Run the Horon CLI: python frontend/cli.py <args>, ${where}` +
      `Pass each CLI argument as one array item; no shell quoting is applied. ` +
      `Horon is a concept graph for reusable judgments and state, not a store for chat transcripts. ` +
      `Read the manual before first use: ${manual}`,
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'CLI arguments, e.g. ["read_concept", "42"].',
        },
      },
      required: ['args'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // The CLI records reads and audit entries under the dsh session the call came from.
      const sessionId = exec?.agent?.id == null ? undefined : String(exec.agent.id)
      const { code, out, err } = url
        ? await runRemoteCli(url, args.args, {
            sessionId,
            cwd: exec?.agent?.session?.header?.cwd ?? process.cwd(),
            signal: exec?.signal,
          })
        : await runPython(config, path.join('frontend', 'cli.py'), args.args, {
            env: sessionId ? { HORON_DSH_SESSION_ID: sessionId } : {},
            signal: exec?.signal,
          })
      const text = out + err
      if (code !== 0) throw new Error(`horon exited with code ${code}\n${text}`)
      return text
    },
  })
}

function registerHooks(ctx, config) {
  const log = (message) => ctx.logger?.warn?.(`horon: ${message}`)
  const { url } = settings(config)
  // Shared with index.js: the settings page shows whether the guard chain is actually live.
  // Interception is fail-open (a dead service must not brick every tool), so a silent failure
  // would look exactly like "no guard rules": count it, and say so once per session.
  const stats = config.stats ?? {}
  const bump = (key, message) => {
    stats[key] = (stats[key] ?? 0) + 1
    if (message !== undefined) stats.lastError = message
  }
  const degraded = new Set() // sessions whose guard chain already failed and was announced

  // `signal` is the hook's cancellation: stopping the turn kills the gateway child (or drops the
  // service request) instead of waiting it out.
  const callGateway = async (event, payload, signal) => {
    if (signal?.aborted) return null
    stats.calls = (stats.calls ?? 0) + 1
    try {
      const stdin = JSON.stringify(payload)
      const { code, out, err } = url
        ? await postService(url, `/api/hook/${event}`, stdin, { signal, timeoutMs: GATEWAY_TIMEOUT_MS })
        : await runPython(config, 'run_gateway.py', [event, '--adapter', 'dsh'], {
            stdin,
            timeoutMs: GATEWAY_TIMEOUT_MS,
            signal,
          })
      if (signal?.aborted) return null
      if (code !== 0) {
        log(`${event} exited ${code}: ${err.trim().slice(0, 500)}`)
        bump('failed', `${event} exited ${code}: ${err.trim().slice(0, 300)}`)
        stats.degraded = true
      }
      const text = out.trim()
      if (!text) return null
      return JSON.parse(text)
    } catch (e) {
      if (!signal?.aborted) {
        log(`${event} failed: ${e}`)
        bump('failed', `${event}: ${e?.message ?? e}`)
        stats.degraded = true
      }
      return null
    }
  }

  const compacted = new Set() // sessions whose context was compacted or cleared, awaiting reset + banner
  const continuing = new Set() // sessions whose current step runs on our Stop steering
  const lastText = new Map() // sessionId -> text of the latest assistant message
  const queues = new Map() // sessionId -> tail of that session's gateway calls

  // Parallel tool calls of one step run their pre/post-execute concurrently; gateway calls of one
  // session run one at a time, in arrival order, so sensing and draining do not interleave.
  const inOrder = (sid, fn) => {
    const run = (queues.get(sid) ?? Promise.resolve()).then(fn)
    queues.set(sid, run.catch(() => {}))
    return run
  }
  const sidOf = (agent) => (agent?.id == null ? null : String(agent.id))
  const isChild = (agent) => Boolean(agent?.session?.header?.parentSession)

  ctx.on('agent/created', ({ agent, source }) => {
    if (source === 'compact' || source === 'clear') {
      const sid = sidOf(agent)
      if (sid) compacted.add(sid)
    }
  })

  ctx.on('session/event', (session, event) => {
    const sid = session?.id == null ? null : String(session.id)
    if (!sid || !event) return
    if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      if (text.trim()) lastText.set(sid, text)
    } else if (event.type === 'compaction/end' && !event.data?.error) {
      compacted.add(sid)
      lastText.delete(sid)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sid = sidOf(agent)
    for (const m of [lastText, queues]) m.delete(sid)
    for (const s of [compacted, continuing]) s.delete(sid)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    const sid = sidOf(agent)
    if (!sid || decision?.kind !== 'enter') return decision
    const typed = (decision.messages ?? messages ?? []).filter((m) => m?.source?.kind === 'user')
    const failedBefore = stats.failed ?? 0
    let res = null
    if (typed.length > 0) {
      // A message she typed starts a new user turn; our Stop continuation no longer applies.
      continuing.delete(sid)
      const prompt = typed.map((m) => contentText(m.content)).filter(Boolean).join('\n')
      const reset = compacted.delete(sid)
      res = await inOrder(sid, () =>
        callGateway('UserPromptSubmit', { session_id: sid, prompt, ...(reset ? { reset: true } : {}) }, signal),
      )
    } else if (compacted.delete(sid)) {
      res = await inOrder(sid, () => callGateway('SessionStart', { session_id: sid, source: 'compact' }, signal))
    }
    const extra = []
    // The guard chain failed here or during an earlier tool call of this session: say it once.
    if (degraded.delete(sid) || (stats.failed ?? 0) > failedBefore) extra.push(bannerMessage(GUARD_DOWN, GUARD_DOWN_SUMMARY))
    if (res?.context) extra.push(bannerMessage(res.context, 'Horon Harness'))
    if (extra.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...extra] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const sid = sidOf(exec?.agent)
    if (sid) {
      const reset = compacted.delete(sid)
      const failedBefore = stats.failed ?? 0
      const res = await inOrder(sid, () =>
        callGateway('PreToolUse', {
          session_id: sid,
          tool_name: exec.name,
          tool_input: exec.arguments ?? {},
          ...(reset ? { reset: true } : {}),
        }, exec.signal),
      )
      if (res?.decision === 'deny') {
        bump('denied')
        return { kind: 'deny', reason: res.reason || 'Blocked by Horon guard policy.' }
      }
      if ((stats.failed ?? 0) > failedBefore) degraded.add(sid)
    }
    return next()
  }, { prepend: true }) // ahead of permission presets, which may answer without calling next()

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const sid = sidOf(exec?.agent)
    if (!sid) return downstream
    // A downstream block replaces the content the model sees with its feedback.
    const shown = downstream?.kind === 'block' ? downstream.feedback : (downstream?.content ?? result?.content)
    const res = await inOrder(sid, () =>
      callGateway('PostToolUse', { session_id: sid, tool_name: exec.name, tool_output: contentText(shown) }, exec.signal),
    )
    if (!res?.context) return downstream
    return {
      ...downstream,
      additionalContexts: [bannerMessage(res.context, `Horon Harness · ${exec.name}`), ...(downstream.additionalContexts ?? [])],
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const sid = sidOf(agent)
    if (!sid || signal?.aborted) return
    const wasContinuing = continuing.delete(sid)
    const last = lastText.get(sid) ?? ''
    lastText.delete(sid)
    const res = await inOrder(sid, () =>
      callGateway('Stop', {
        session_id: sid,
        last_assistant_message: last,
        stop_hook_active: wasContinuing || isChild(agent),
      }, signal),
    )
    if (res?.decision !== 'block' || !res.reason || signal?.aborted) return
    continuing.add(sid)
    try {
      agent.steer(bannerMessage(res.reason, 'Horon Harness · Stop'))
    } catch (e) {
      continuing.delete(sid)
      log(`Stop continuation failed: ${e}`)
      await inOrder(sid, () => callGateway('Requeue', { session_id: sid, context: res.reason }))
    }
  })
}

export function applyHarness(ctx, config = {}) {
  ctx.inject(['tools'], (toolsCtx) => registerTool(toolsCtx, config))
  ctx.inject(['systemPrompt'], (promptCtx) => registerPolicy(promptCtx))
  const off = config.hooks === false || /^(0|off|false|no)$/i.test(process.env.HORON_HOOKS ?? '')
  if (!off) registerHooks(ctx, config)
}
