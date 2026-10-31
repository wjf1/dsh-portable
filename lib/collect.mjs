/**
 * dsh-portable — collects the files that make a DSH installation portable.
 *
 * The plugin never copies the whole DSH_HOME. It copies a fixed allow-list of
 * roots, because the home directory also holds caches, logs, telemetry, the
 * plugin market's download cache and this plugin's own working directories.
 * Copying those would bloat the package and, worse, could make the exporter
 * archive its own output.
 *
 * Every entry is described by a *logical* path relative to the package root,
 * never by an absolute source path, so a package can be restored anywhere.
 */

import { readdir, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths.mjs';

/** Directories under the profile that never belong in a portable package. */
const PROFILE_SKIP_DIRS = new Set(['.git', '.cache', '.tmp']);

/** File suffixes that are build/backup debris rather than content. */
const BACKUP_SUFFIX = /\.(?:bak|backup|orig)(?:[-.][\w-]+)?$/i;

export const MAX_ENTRIES = 200_000;
export const MAX_SINGLE_FILE = 2 * 1024 * 1024 * 1024;
/**
 * Total payload ceiling.
 *
 * The figure is a *scan-time* estimate summed from `stat` sizes before anything
 * is read, so it is approximate by construction: a file that grows between the
 * scan and the read (a live log, a database being written) is not re-measured,
 * and a file that shrinks leaves the estimate high. Both errors are small and
 * point the safe way for a ceiling like this — treat the number as "roughly 8
 * GB", not as an exact byte budget.
 */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The allow-list. \`flag\` names the option that turns an optional root on;
 * undefined means the root is always considered.
 */
export function sourceRoots({ profileName, options }) {
  return [
    { id: 'profile', logical: 'profiles/' + profileName, kind: 'dir', flag: undefined, required: true },
    { id: 'skills', logical: 'skills', kind: 'dir', flag: undefined },
    // Disabled skills behave like the other optional roots: they only ride
    // along when their flag is set. They used to be unconditional, and on a
    // real machine they were 86% of the package — dead weight in the common
    // "move what works" case, so the default is to leave them behind and let
    // `includeDisabledSkills` opt back in.
    { id: 'skillsDisabled', logical: 'skills-disabled', kind: 'dir', flag: 'includeDisabledSkills' },
    { id: 'hooks', logical: 'hooks', kind: 'dir', flag: undefined },
    { id: 'storages', logical: 'storages', kind: 'dir', flag: undefined },
    { id: 'taskBoard', logical: 'task-board', kind: 'dir', flag: undefined },
    { id: 'todoBoard', logical: 'todo-board', kind: 'dir', flag: undefined },
    { id: 'browserHost', logical: 'dsh-builtin-browser-host', kind: 'dir', flag: undefined },
    { id: 'agentInstructions', logical: 'AGENTS.md', kind: 'file', flag: undefined },
    { id: 'sessions', logical: 'sessions', kind: 'dir', flag: 'includeSessions' },
    { id: 'runtimes', logical: 'dsh-runtimes', kind: 'dir', flag: 'includeRuntimes' },
    { id: 'credentials', logical: '.credentials.yaml', kind: 'file', flag: 'includeCredentials' },
  ].filter((root) => root.flag === undefined || options[root.flag] === true);
}

/**
 * Validate and normalise a sub-path selector.
 *
 * A selector is a list of *logical* path prefixes (package-relative, forward
 * slashes): `['skills/my-skill', 'profiles/desktop/cordis.patch.yml']`. An
 * entry matches when its path equals a prefix or lives underneath one. An
 * empty (or absent) list means "everything" — the historical behaviour.
 *
 * @param {unknown} raw  undefined, or an array of strings
 * @returns {string[]} cleaned, de-duplicated prefixes ([] = no filtering)
 */
export function normalizeInclude(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('include must be an array of package-relative paths');
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('include entries must be strings');
    let value = item.trim().replace(/\\/g, '/');
    while (value.startsWith('./')) value = value.slice(2);
    value = value.replace(/^\/+/, '').replace(/\/+$/, '');
    if (value === '') throw new Error('include entries cannot be empty');
    if (value.length > 512) throw new Error('include entry is too long: ' + value.slice(0, 32) + '…');
    if (value.includes('\0')) throw new Error('include entries cannot contain NUL bytes');
    if (value.split('/').includes('..')) throw new Error('include entries cannot climb out of the package: ' + item);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** True when `logical` is a selected path or lives under one. */
export function matchesInclude(logical, prefixes) {
  if (prefixes === null || prefixes.length === 0) return true;
  return prefixes.some((prefix) => logical === prefix || logical.startsWith(prefix + '/'));
}

/**
 * True when walking into `logicalDir` can still find a selected path: the
 * directory itself is selected, sits inside one, or contains one. This is the
 * prune that keeps an export with `include: ['skills/a']` from statting every
 * file under node_modules on its way past.
 */
function branchAlive(logicalDir, prefixes) {
  return prefixes.some((prefix) => prefix === logicalDir
    || logicalDir.startsWith(prefix + '/')
    || prefix.startsWith(logicalDir + '/'));
}

function shouldSkipEntry(name, isDir, options) {
  if (isDir) {
    if (PROFILE_SKIP_DIRS.has(name)) return true;
    if (name === 'node_modules' && options.includeNodeModules === false) return true;
    return false;
  }
  if (options.includeSourceMaps === false && name.endsWith('.map')) return true;
  if (options.includeBackups === false && BACKUP_SUFFIX.test(name)) return true;
  return false;
}

function toSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Walks the allow-list and yields one descriptor per filesystem entry.
 *
 * Yields \`{ logical, type, size, mtimeSeconds, mode, linkTarget }\`. The caller
 * decides how to store it; this function only reads metadata. With a
 * non-empty \`include\` only entries under the selected logical prefixes are
 * yielded, and whole directory branches that cannot contain a selection are
 * pruned before they are listed.
 */
export async function* collectEntries({ dshHome, profileName, options, stats, exclude, include }) {
  const skipAbsolute = exclude ?? new Set();
  const prefixes = include === undefined || include === null || include.length === 0 ? null : normalizeInclude(include);
  const roots = sourceRoots({ profileName, options });

  for (const root of roots) {
    const absolute = path.join(dshHome, ...root.logical.split('/'));
    if (skipAbsolute.has(absolute)) continue;

    let info;
    try {
      info = await lstat(longPath(absolute));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        if (root.required) throw new Error('missing required source: ' + absolute);
        stats.missing.push(root.logical);
        continue;
      }
      throw error;
    }

    if (root.kind === 'file') {
      if (!info.isFile()) {
        stats.missing.push(root.logical);
        continue;
      }
      if (!matchesInclude(root.logical, prefixes)) continue;
      stats.files += 1;
      stats.bytes += info.size;
      stats.byRoot[root.id] = (stats.byRoot[root.id] ?? 0) + info.size;
      stats.filesByRoot[root.id] = (stats.filesByRoot[root.id] ?? 0) + 1;
      yield {
        logical: root.logical, type: 'file', size: info.size,
        mtimeSeconds: toSeconds(info.mtimeMs ? new Date(info.mtimeMs) : new Date()),
        mode: info.mode & 0o777, absolute,
      };
      continue;
    }

    if (!info.isDirectory()) {
      stats.missing.push(root.logical);
      continue;
    }

    yield* walkDirectory({
      absoluteDir: absolute,
      logicalDir: root.logical,
      rootId: root.id,
      options,
      stats,
      skipAbsolute,
      prefixes,
    });
  }
}

async function* walkDirectory({ absoluteDir, logicalDir, rootId, options, stats, skipAbsolute, prefixes }) {
  // Prune whole branches that cannot hold a selected path: a sub-path export
  // must not pay a full walk of every other root on the way in.
  if (prefixes !== null && !branchAlive(logicalDir, prefixes)) return;

  let entries;
  try {
    entries = await readdir(longPath(absoluteDir), { withFileTypes: true });
  } catch (error) {
    stats.warnings.push('cannot list ' + logicalDir + ': ' + error.code);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    if (skipAbsolute.has(absolute)) continue;
    const logical = logicalDir + '/' + entry.name;

    let info;
    try {
      info = await lstat(longPath(absolute));
    } catch (error) {
      stats.warnings.push('cannot stat ' + logical + ': ' + error.code);
      continue;
    }

    if (info.isSymbolicLink()) {
      if (skipAbsolute.has(absolute)) continue;
      if (!matchesInclude(logical, prefixes)) continue;
      let target;
      try {
        target = await readlink(longPath(absolute));
      } catch (error) {
        stats.warnings.push('cannot read link ' + logical + ': ' + error.code);
        continue;
      }
      stats.links += 1;
      stats.entries += 1;
      yield { logical, type: 'symlink', size: 0, mtimeSeconds: toSeconds(info.mtimeMs ? new Date(info.mtimeMs) : new Date()), mode: 0o777, linkTarget: target, absolute };
      continue;
    }

    if (info.isDirectory()) {
      if (shouldSkipEntry(entry.name, true, options)) {
        stats.skipped.push(logical);
        continue;
      }
      // The directory itself is only yielded when selected; walking continues
      // whenever a selection can still live deeper (the parent of a selected
      // path is not selected, but its children are).
      const matched = matchesInclude(logical, prefixes);
      const alive = prefixes === null || branchAlive(logical, prefixes);
      if (matched) {
        stats.dirs += 1;
        stats.entries += 1;
        if (stats.entries > MAX_ENTRIES) throw new Error('too many entries: more than ' + MAX_ENTRIES);
        yield { logical, type: 'dir', size: 0, mtimeSeconds: toSeconds(info.mtimeMs ? new Date(info.mtimeMs) : new Date()), mode: info.mode & 0o777, absolute };
      }
      if (alive) {
        yield* walkDirectory({ absoluteDir: absolute, logicalDir: logical, rootId, options, stats, skipAbsolute, prefixes });
      }
      continue;
    }

    if (!info.isFile()) {
      stats.warnings.push('skipping special file ' + logical + ': ' + (info.isFIFO() ? 'fifo' : info.isSocket() ? 'socket' : info.isBlockDevice() ? 'block device' : info.isCharacterDevice() ? 'character device' : 'unknown'));
      continue;
    }

    if (shouldSkipEntry(entry.name, false, options)) {
      stats.skipped.push(logical);
      continue;
    }
    if (!matchesInclude(logical, prefixes)) continue;
    if (info.size > MAX_SINGLE_FILE) {
      throw new Error('file too large: ' + logical + ' (' + info.size + ' bytes, limit ' + MAX_SINGLE_FILE + ')');
    }
    stats.files += 1;
    stats.bytes += info.size;
    stats.entries += 1;
    stats.byRoot[rootId] = (stats.byRoot[rootId] ?? 0) + info.size;
    stats.filesByRoot[rootId] = (stats.filesByRoot[rootId] ?? 0) + 1;
    if (stats.entries > MAX_ENTRIES) throw new Error('too many entries: more than ' + MAX_ENTRIES);
    if (stats.bytes > MAX_TOTAL_BYTES) throw new Error('package too large: more than ' + MAX_TOTAL_BYTES + ' bytes');
    yield { logical, type: 'file', size: info.size, mtimeSeconds: toSeconds(info.mtimeMs ? new Date(info.mtimeMs) : new Date()), mode: info.mode & 0o777, absolute };
  }
}

export function createStats() {
  return {
    entries: 0, files: 0, dirs: 0, links: 0, bytes: 0,
    byRoot: {}, filesByRoot: {}, skipped: [], warnings: [], missing: [],
  };
}
