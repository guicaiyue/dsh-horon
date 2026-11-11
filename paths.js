// Where everything Horon-related lives, for both runtimes.
//
// One path decides all of it: `dataDir`, by default ~/.horon. The database, the key file, the
// unpacked releases and the tag plugins are all derived from it, so a user only ever answers
// "where do I keep this" once. Docker mode mounts the same directory into the container at /data,
// which is what makes switching runtimes keep the memory.

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The public release proxy used when downloading from GitHub by default. */
export const DEFAULT_PROXY = 'https://gh-proxy.com'

export function expandHome(value) {
  return value === '~' || /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value
}

export function defaultDataDir() {
  return path.join(os.homedir(), '.horon')
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** The configured data directory, absolute. */
export function resolveDataDir(config) {
  const given = text(config?.dataDir)
  return given === undefined ? defaultDataDir() : path.resolve(expandHome(given))
}

/**
 * The key/value file (API keys, proxies).
 *
 * `<root>/.env` is the documented location. An older layout kept it in `<root>/docker/.env`;
 * that file is still read when the new one does not exist, so upgrading does not lose the keys.
 */
export function envFileFor(root) {
  const current = path.join(root, '.env')
  if (existsSync(current)) return current
  const legacy = path.join(root, 'docker', '.env')
  return existsSync(legacy) ? legacy : current
}

export const dbFileFor = (root) => path.join(root, 'horon.db')
export const runtimeDirFor = (root) => path.join(root, 'runtime')
export const tagPluginsDirFor = (root) => path.join(root, 'tag_plugins')
export const localDirFor = (root) => path.join(root, 'local')

/** Download proxy: empty means a direct connection. */
export function proxyOf(config) {
  const given = config?.proxy
  if (given === null) return ''
  return typeof given === 'string' ? given.trim() : DEFAULT_PROXY
}

/** Prefix a URL with the proxy: https://gh-proxy.com/https://github.com/... */
export function proxied(url, proxy) {
  const base = String(proxy ?? '').trim().replace(/\/+$/, '')
  return base === '' ? url : `${base}/${url}`
}
