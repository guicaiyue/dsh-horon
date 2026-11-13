// Bundled tag plugins: shipped inside this package so a fresh install is not a bare graph.
//
// A Horon tag plugin is two things at once, and neither is something npm can install:
//   - a Python file the service loads from `<dataDir>/tag_plugins/<tag>.py`;
//   - a tag in the memory database, whose source concept carries the description.
// So on first start this module does both: copies the file when it is missing (never overwriting
// one the user edited) and registers the tag when the database does not have it yet. Both steps
// are idempotent, so it runs on every start without a marker file to keep in sync.

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { postService } from './harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Where the plugins bundled with this package live. */
export const bundledTagPluginsDir = path.join(here, 'tag_plugins')

const GATE_CONTENT = `# 记忆入库

这不是一个主题分类，是一道**写时门禁**：任何节点想进这张图谱，都要先过它。

## 门禁拦三件事（只看正文形状，不看内容对错）

1. **正文非空行合计超过 8192 B** —— 超长的唯一原因是把多天历史堆进同一个节点。正确做法是把流水拆成独立概念、互相指向，正文只留「当前判断」和指针。
2. **像整段对话/会话转写** —— 连续 8 行以上「用户：/助手：」角色标记，或 8 行以上时间戳且全篇没有标题结构。这是把聊天记录当记忆。
3. **缺书腰（when_to_read 为空）** —— 书腰是语义检索的唯一入口。没有它的节点只能靠名字被翻到，\`search_semantic\` 永远命中不了，等于入库即失联。

插件文件由 dsh-horon 安装时自动放下（\`<dataDir>/tag_plugins/记忆入库.py\`）并注册本 Tag，改完热重载、不用重启服务。

## 已知边界

- **拦不住「节点名命中自己的监听正则」这类自击**：\`on_mutation\` 拿到的 ConceptProxy 只有 name/content/role/tags/when_to_read/on_fire，读不到 \`sensor_hook.match_pattern\`，没法比较。只有 \`tool_result\` 类传感器会因此误报（任何工具输出回显节点名都点火）；\`user_message\` 类名字本就是用户症状的描述，命中是应该的。建传感器时自己检查。
- **不判断内容对错**：一段又短又干净的错话照样放行。内容质量靠 \`audit --concept\` 的 Jev 判断，不在这道门里。
- **改正文时只查长度与流水账，不查书腰**：书腰在入库那一刻必填，之后清空属于另一类破坏。
`

/**
 * The tag plugins this package installs when they are missing.
 *
 * `file` is relative to `tag_plugins/` next to this module; `content` and `whenToRead` are only
 * used when the tag does not exist yet, so an existing graph keeps whatever it already says.
 */
export const BUNDLED_TAG_PLUGINS = [
  {
    tag: '记忆入库',
    file: '记忆入库.py',
    whenToRead:
      '当要把一条记忆写入图谱、给节点挂「记忆入库」Tag、判断某个节点为什么被拒绝入库，'
      + '或要弄清 tag 插件放在哪、为什么升级插件不会丢时',
    content: GATE_CONTENT,
  },
]

const DUPLICATE_TAG = /already exists/i
const DUPLICATE_CONCEPT = /already belongs to concept/i

async function copyMissing(sourceDir, targetDir, spec) {
  const from = path.join(sourceDir, spec.file)
  const to = path.join(targetDir, spec.file)
  if (existsSync(to)) return false
  if (!existsSync(from)) return false
  await fs.mkdir(targetDir, { recursive: true })
  // `COPYFILE_EXCL` keeps a plugin the user is editing while the install lands.
  await fs.copyFile(from, to, 1 /* COPYFILE_EXCL */)
  return true
}

async function registerTag(base, spec) {
  const created = []
  // The CLI answers a duplicate with a message rather than a non-zero code in some versions, so
  // "already there" is decided on the text and only an unrelated failure is raised.
  const concept = await postService(base, '/api/cli', {
    args: ['create_concept', spec.tag, '--content', spec.content, '--when-to-read', spec.whenToRead],
  }, { timeoutMs: 30_000 })
  const conceptText = concept.out + concept.err
  if (DUPLICATE_CONCEPT.test(conceptText)) {
    // already in the graph; keep whatever the user's own copy says
  } else if (concept.code === 0) {
    created.push(`concept ${spec.tag}`)
  } else {
    throw new Error(`create_concept ${spec.tag}: ${conceptText.trim()}`)
  }

  const tag = await postService(base, '/api/cli', { args: ['create_tag', spec.tag] }, { timeoutMs: 30_000 })
  const tagText = tag.out + tag.err
  if (DUPLICATE_TAG.test(tagText)) {
    // already registered
  } else if (tag.code === 0) {
    created.push(`tag ${spec.tag}`)
  } else {
    throw new Error(`create_tag ${spec.tag}: ${tagText.trim()}`)
  }
  return created
}

/**
 * Install the bundled tag plugins: copy each file into `tagPluginsDir` when it is missing, then
 * register the tag when the database does not have it. Safe to call on every start.
 *
 * Returns what actually changed, so the caller can log one line and stay quiet afterwards.
 */
export async function seedTagPlugins({
  tagPluginsDir,
  base,
  sourceDir = bundledTagPluginsDir,
  specs = BUNDLED_TAG_PLUGINS,
}) {
  const copied = []
  const registered = []
  const failed = []
  for (const spec of specs) {
    try {
      if (await copyMissing(sourceDir, tagPluginsDir, spec)) copied.push(spec.file)
      registered.push(...(await registerTag(base, spec)))
    } catch (error) {
      failed.push(`${spec.tag}: ${error?.message ?? error}`)
    }
  }
  return { copied, registered, failed }
}
