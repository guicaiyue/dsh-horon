#!/usr/bin/env node
// Generate the plugin-market entry for this version.
//
// The market is a JSON index (format 1) validated by @deepseek-ai/dsh-plugin-market-index; the
// upstream index owner merges one `plugins[]` object per plugin. This script writes a complete
// single-plugin index — valid on its own, and the object to copy into that index.
//
//   node scripts/market-entry.mjs [--timestamp <unix seconds>]
//
// Run it after `npm publish`, so the listed version really is installable.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const OUT_DIR = path.join(PLUGIN, 'market')
const OUT = path.join(OUT_DIR, 'dsh-horon.json')

const argv = process.argv.slice(2)
const at = argv.indexOf('--timestamp')
const timestamp = at === -1 ? Math.floor(Date.now() / 1000) : Number(argv[at + 1])
if (!Number.isInteger(timestamp) || timestamp <= 0) {
  console.error('market-entry.mjs: --timestamp must be Unix seconds')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const repository = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
if (!repository.startsWith('https://')) {
  console.error('market-entry.mjs: package.json repository must be an https URL')
  process.exit(1)
}

const entry = {
  format: 1,
  title: { en: 'DSH plugin index', zh: 'DSH 插件索引' },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Horon memory graph', zh: 'Horon 记忆图谱' },
      description: {
        en: 'Horon memory graph for dsh: the horon tool, lifecycle hooks, a console panel and a one-click service runtime (released build artifact or Docker image).',
        zh: '把 Horon 记忆图谱接进 dsh：horon 工具、生命周期钩子、控制台面板，以及一键运行的 Horon 服务（发布构建物或 Docker 镜像）。',
      },
      author: 'guicaiyue',
      homepage: repository,
      repository: { url: repository },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source: { type: 'npm' },
          engines: pkg.engines?.dsh ? { dsh: pkg.engines.dsh } : {},
        },
      ],
    },
  ],
}

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(entry, null, 2)}\n`)
console.log(`wrote ${OUT} for ${pkg.name}@${pkg.version}`)
