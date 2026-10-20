/**
 * dsh-portable — path resolution and containment helpers.
 *
 * Everything the plugin touches lives under the DSH home directory. This module
 * is the single place that answers "where is DSH home?" and the single place
 * that decides whether some candidate path is allowed to be read or written.
 */

import path from 'node:path'

/** Normalize any path to POSIX separators (archive entries, manifest keys). */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** Normalize a logical (archive-relative) path: POSIX, no leading './'. */
export function normalizeLogical(p) {
  let s = toPosix(p)
  while (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/\/+/g, '/')
  return s
}

/** True when `target` is `base` or lives underneath it (after resolving both). */
export function isInside(base, target) {
  const b = path.resolve(base)
  const t = path.resolve(target)
  if (b === t) return true
  const withSep = b.endsWith(path.sep) ? b : b + path.sep
  return t.startsWith(withSep)
}

/**
 * Join a logical archive path onto a base directory, refusing anything that
 * could escape it. Returns the absolute path, or throws with a short reason.
 */
export function safeJoin(base, logicalPath) {
  const logical = normalizeLogical(logicalPath)
  if (logical.length === 0) throw new Error('empty logical path')
  if (logical.startsWith('/')) throw new Error('absolute logical path: ' + logicalPath)
  if (/^[a-zA-Z]:/.test(logical)) throw new Error('drive-qualified logical path: ' + logicalPath)
  if (logical.includes('\u0000')) throw new Error('NUL byte in logical path')
  const segments = logical.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('illegal path segment in ' + logicalPath)
    }
    if (isWindowsReservedSegment(segment)) {
      throw new Error('reserved windows name in ' + logicalPath)
    }
  }
  const joined = path.resolve(base, ...segments)
  if (!isInside(base, joined)) throw new Error('path escapes base: ' + logicalPath)
  return joined
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

function isWindowsReservedSegment(segment) {
  const bare = segment.split('.')[0].toLowerCase()
  if (WINDOWS_RESERVED.has(bare)) return true
  if (segment.endsWith('.') || segment.endsWith(' ')) return true
  return false
}

/** Windows long-path form, so >260 character trees are still readable. */
export function longPath(p) {
  if (process.platform !== 'win32') return p
  const resolved = path.resolve(p)
  if (resolved.startsWith('\\\\?\\')) return resolved
  if (resolved.startsWith('\\\\')) return '\\\\?\\UNC\\' + resolved.slice(2)
  return '\\\\?\\' + resolved
}

/** A filesystem-safe timestamp: 20261018-095300-123. */
export function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return [
    date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
    + '-' + pad(date.getMilliseconds(), 3)
}

