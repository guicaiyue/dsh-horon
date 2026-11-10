#!/usr/bin/env node
// Keep horon.lock.json in step with what CI actually published. Run by the workflows, never by a
// user: the lock file is the only thing the plugin reads, so a stale name or digest there is a
// broken install.
//
//   node scripts/lock-sync.mjs image <namespace>/horon-service   # the repo Docker Hub accepted
//   node scripts/lock-sync.mjs digests <horon-app-*.tar.gz>...   # the assets the release uploaded
//   node scripts/lock-sync.mjs show
//
// Exits 0 whether or not it changed anything; the workflow decides with `git diff --quiet`.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LOCK = path.join(PLUGIN, 'horon.lock.json')

function fail(message) {
  console.error(`lock-sync.mjs: ${message}`)
  process.exit(1)
}

const read = () => JSON.parse(fs.readFileSync(LOCK, 'utf8'))
const write = (lock) => fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const [command, ...rest] = process.argv.slice(2)
if (command === undefined) fail('usage: image <name> | digests <tarballs...> | show')

if (command === 'show') {
  const lock = read()
  console.log(JSON.stringify(lock, null, 2))
  process.exit(0)
}

if (command === 'image') {
  const name = rest[0]
  if (name === undefined || !/^[a-z0-9][a-z0-9._/-]*$/i.test(name)) fail(`not an image name: ${String(name)}`)
  const lock = read()
  const before = lock.image?.name
  lock.image = { ...lock.image, name }
  if (before === name) {
    console.log(`image name already ${name}`)
    process.exit(0)
  }
  write(lock)
  console.log(`image name ${String(before)} -> ${name}`)
  process.exit(0)
}

if (command === 'digests') {
  const files = rest
  if (files.length === 0) fail('digests needs at least one tarball')
  const lock = read()
  const pinned = lock.horon.commit.slice(0, 8)
  const next = {}
  for (const file of files) {
    const name = path.basename(file)
    const match = /^horon-app-(.+)-([0-9a-f]{7,8})\.tar\.gz$/.exec(name)
    if (match === null) fail(`${name} is not a horon-app-<platform>-<commit8>.tar.gz asset`)
    const [, platform, short] = match
    // An asset built from another commit would hand users a different tree than the lock promises.
    if (!pinned.startsWith(short) && !short.startsWith(pinned)) {
      fail(`${name} was built from ${short}, but the lock pins ${pinned}`)
    }
    next[platform] = sha256(file)
  }
  lock.artifact = { ...lock.artifact, sha256: { ...lock.artifact?.sha256, ...next } }
  write(lock)
  for (const [platform, digest] of Object.entries(next)) console.log(`${platform} ${digest}`)
  process.exit(0)
}

fail(`unknown command ${command}`)
