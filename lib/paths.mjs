/**
 * dsh-portable — path resolution and containment helpers.
 *
 * Everything the plugin touches lives under the DSH home directory. This module
 * is the single place that answers "where is DSH home?" and the single place
 * that decides whether some candidate path is allowed to be read or written.
 */

import fs from 'node:fs'
import os from 'node:os'
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

/**
 * Resolve the DSH home directory.
 *
 * Order matters: the profile context is authoritative when the host provides it,
 * environment variables cover the tool-subprocess case, and ~/.dsh is the last
 * resort. A candidate only counts when it actually looks like a DSH home, so a
 * stale exported variable cannot silently redirect a backup into the wrong tree.
 */
export function resolveDshHome(ctx) {
  const candidates = []
  const push = (value, origin) => {
    if (typeof value === 'string' && value.length > 0) candidates.push({ value: path.resolve(value), origin })
  }

  const profileContext = readProfileContext(ctx)
  push(profileContext?.dshHome, 'profileContext.dshHome')
  push(profileContext?.homeDir, 'profileContext.homeDir')
  push(profileContext?.rootDir, 'profileContext.rootDir')
  if (typeof profileContext?.profileDir === 'string') {
    push(path.dirname(path.resolve(profileContext.profileDir)), 'profileContext.profileDir/..')
  }
  push(process.env.DSH_HOME, 'env.DSH_HOME')
  if (typeof process.env.DSH_PROFILE_DIR === 'string') {
    push(path.dirname(path.resolve(process.env.DSH_PROFILE_DIR)), 'env.DSH_PROFILE_DIR/..')
  }
  push(path.join(os.homedir(), '.dsh'), 'homedir/.dsh')

  for (const candidate of candidates) {
    if (looksLikeDshHome(candidate.value)) return candidate.value
  }
  // Nothing looked canonical: report the first candidate so callers can explain
  // the failure instead of silently creating a tree somewhere unexpected.
  return candidates.length > 0 ? candidates[0].value : path.join(os.homedir(), '.dsh')
}

/** Read the profile context service without assuming its shape. */
export function readProfileContext(ctx) {
  try {
    const direct = ctx?.get?.('profileContext')
    if (direct !== null && typeof direct === 'object') return direct
  } catch {
    /* the service may be absent in a bare composition */
  }
  return undefined
}

function looksLikeDshHome(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  try {
    return fs.statSync(path.join(dir, 'profiles')).isDirectory()
  } catch {
    return false
  }
}

/** Resolve the profile directory (defaults to <home>/profiles/desktop). */
export function resolveProfile(ctx, dshHome) {
  const profileContext = readProfileContext(ctx)
  const candidates = []
  const push = (value, name) => {
    if (typeof value === 'string' && value.length > 0) {
      candidates.push({ dir: path.resolve(value), name: name ?? path.basename(path.resolve(value)) })
    }
  }
  push(profileContext?.profileDir)
  if (typeof process.env.DSH_PROFILE_DIR === 'string') push(process.env.DSH_PROFILE_DIR)
  push(path.join(dshHome, 'profiles', profileContext?.profileName ?? 'desktop'),
    profileContext?.profileName ?? 'desktop')

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.dir)) return candidate
  }
  return candidates[candidates.length - 1]
}

/** The patch layer this plugin's own rows are meant to live in. */
export function resolvePatchPath(ctx, profile) {
  const profileContext = readProfileContext(ctx)
  if (typeof profileContext?.patchPath === 'string' && profileContext.patchPath.length > 0) {
    return path.resolve(profileContext.patchPath)
  }
  if (typeof profileContext?.patchFile === 'string' && profileContext.patchFile.length > 0) {
    return path.resolve(profileContext.patchFile)
  }
  return path.join(profile.dir, 'cordis.patch.yml')
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

/** Replace characters that are illegal in Windows file names. */
export function safeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'dsh'
}

/** Human readable byte size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[unit]
}
