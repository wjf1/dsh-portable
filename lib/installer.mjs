/**
 * dsh-portable — installs a package into a DSH home.
 *
 * The install is deliberately two-phase. Unpacking always lands in
 * \`<DSH_HOME>/portable-staging/<stamp>/\`, never in the live tree, so a corrupt
 * or hostile archive costs disk space instead of a working editor. Only after
 * the manifest checks out, the paths have been rewritten and the critical files
 * have been backed up does anything touch the real installation.
 *
 * Two merge modes exist:
 *  - merge (default): add and overwrite files, keep everything the package does
 *    not mention. Nothing the user had can disappear.
 *  - replace: move the existing directories aside and put the package's copies
 *    in their place, so the profile matches the source machine exactly.
 */

import { access, copyFile, cp, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { extractPackage, readManifest } from './archive.mjs';
import { rewriteExtractedTree } from './rewrite.mjs';
import { longPath, stamp } from './paths.mjs';

/** Configuration a human customised; worth saving before any import. */
function criticalTargets(profileName) {
  return [
    'profiles/' + profileName + '/cordis.patch.yml',
    'profiles/' + profileName + '/cordis.yml',
    'profiles/' + profileName + '/package.json',
    'profiles/' + profileName + '/pnpm-workspace.yaml',
    'hooks',
    'AGENTS.md',
  ];
}

async function exists(target) {
  try {
    await access(longPath(target));
    return true;
  } catch {
    return false;
  }
}

/** Collapse a logical path to the unit an install replaces: profiles/x or skills. */
export function topOf(logical) {
  const parts = String(logical).split('/');
  if (parts[0] === 'profiles' && parts.length > 1) return 'profiles/' + parts[1];
  return parts[0];
}

/**
 * Read a package and describe what installing it would do, without writing
 * anything anywhere. Costs one full decompression, which is why the UI runs it
 * in a worker.
 */
export async function preview({ filePath, dshHome, profileName, limits, onProgress }) {
  const { manifest } = await readManifest(filePath);
  const sourceProfile = manifest.source?.profile ?? '';
  const targetProfile = profileName ?? sourceProfile;

  const byTop = new Map();
  let files = 0;
  let bytes = 0;

  await extractPackage({
    filePath,
    destDir: null,
    limits,
    onEntry: async (meta) => {
      const top = topOf(meta.path);
      const record = byTop.get(top) ?? { files: 0, bytes: 0, dirs: 0, links: 0 };
      if (meta.type === 'file') {
        record.files += 1;
        record.bytes += meta.size;
        files += 1;
        bytes += meta.size;
      } else if (meta.type === 'dir') {
        record.dirs += 1;
      } else {
        record.links += 1;
      }
      byTop.set(top, record);
      return 'skip';
    },
    onProgress,
  });

  const tops = [];
  for (const [top, record] of [...byTop.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const absolute = path.join(dshHome, ...top.split('/'));
    tops.push({ top, ...record, existsOnTarget: await exists(absolute) });
  }

  return {
    manifest,
    sourceProfile,
    targetProfile,
    requiresProfileRename: sourceProfile.length > 0 && sourceProfile !== targetProfile,
    totals: { files, bytes, tops: tops.length },
    tops,
  };
}

/** Recursive copy that overwrites files but never deletes anything. */
async function mergeTree({ sourceDir, targetDir, logical, counters, onProgress }) {
  await mkdir(longPath(targetDir), { recursive: true });
  let entries;
  try {
    entries = await readdir(longPath(sourceDir), { withFileTypes: true });
  } catch (error) {
    counters.warnings.push('cannot list ' + logical + ': ' + error.code);
    return;
  }

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    const childLogical = logical + '/' + entry.name;

    if (entry.isDirectory()) {
      counters.dirs += 1;
      await mergeTree({ sourceDir: source, targetDir: target, logical: childLogical, counters, onProgress });
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await readlink(longPath(source));
        if (await exists(target)) await rm(longPath(target), { force: true });
        await symlink(linkTarget, longPath(target));
        counters.links += 1;
      } catch (error) {
        counters.warnings.push('cannot restore symlink ' + childLogical + ': ' + error.code);
      }
      continue;
    }

    try {
      await copyFile(longPath(source), longPath(target));
      counters.files += 1;
      if (counters.files % 500 === 0) onProgress?.({ phase: 'apply', files: counters.files });
    } catch (error) {
      counters.warnings.push('cannot copy ' + childLogical + ': ' + error.code);
    }
  }
}

/** Copy the user's own customisations into a timestamped backup folder. */
async function backupCritical({ dshHome, profileName, stampId }) {
  const dir = path.join(dshHome, 'portable-backups', stampId);
  const saved = [];
  for (const logical of criticalTargets(profileName)) {
    const source = path.join(dshHome, ...logical.split('/'));
    if (!(await exists(source))) continue;
    const target = path.join(dir, ...logical.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const info = await stat(longPath(source));
      if (info.isDirectory()) await cp(longPath(source), longPath(target), { recursive: true });
      else await copyFile(longPath(source), longPath(target));
      saved.push(logical);
    } catch (error) {
      saved.push(logical + ' (partial: ' + error.code + ')');
    }
  }
  return { dir, saved };
}

const STAMP_DIR = /^\d{8}-\d{6}(?:-\d{3})?$/;

/** Keep only the newest N backup folders. */
async function pruneBackups({ dshHome, keep }) {
  const dir = path.join(dshHome, 'portable-backups');
  let names;
  try {
    names = await readdir(longPath(dir));
  } catch {
    return [];
  }
  names.sort();
  // A `-pre-restore` folder is the undo of a restore, not a snapshot taken by an
  // import. Counting it in the same budget would delete the user's way back.
  const snapshots = names.filter((name) => STAMP_DIR.test(name));
  // keep:0 is an explicit "do not leave snapshots behind", not "use the default".
  const budget = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 5;
  const excess = budget === 0 ? snapshots : snapshots.slice(0, Math.max(0, snapshots.length - budget));
  const removed = [];
  for (const name of excess) {
    await rm(longPath(path.join(dir, name)), { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/**
 * Install a package into \`dshHome\`.
 *
 * @param {{filePath: string, dshHome: string, profileName?: string, mode?: 'merge'|'replace',
 *          keepBackups?: number, limits?: object, onProgress?: (p: object) => void}} options
 */
export async function install({
  filePath, dshHome, profileName, mode = 'merge', keepBackups = 5, limits, onProgress,
}) {
  const { manifest } = await readManifest(filePath);
  const sourceProfile = manifest.source?.profile ?? '';
  const targetProfile = profileName ?? sourceProfile;
  if (targetProfile.length === 0) throw new Error('package does not name a profile; pass profileName explicitly');

  const stampId = stamp();
  const stageDir = path.join(dshHome, 'portable-staging', stampId);
  const report = {
    stampId, mode, sourceProfile, targetProfile, stageDir,
    extracted: null, rewrites: null, backup: null, applied: [], warnings: [], prunedBackups: [],
  };

  try {
    report.extracted = await extractPackage({ filePath, destDir: stageDir, limits, onProgress });
  } catch (error) {
    report.warnings.push('extraction failed: ' + error.message);
    throw error;
  }

  try {
  const stagedProfileDir = path.join(stageDir, 'profiles', sourceProfile);
  if (sourceProfile.length > 0 && sourceProfile !== targetProfile && (await exists(stagedProfileDir))) {
    const renamedDir = path.join(stageDir, 'profiles', targetProfile);
    await rm(longPath(renamedDir), { recursive: true, force: true });
    await rename(longPath(stagedProfileDir), longPath(renamedDir));
    report.renamedProfile = { from: sourceProfile, to: targetProfile };
  }

  const fromHome = manifest.source?.dshHome ?? '';
  if (fromHome.length > 0 && fromHome !== dshHome) {
    report.rewrites = await rewriteExtractedTree({
      stageDir, packageProfile: sourceProfile, targetProfile, toHome: dshHome, fromHome,
      targetPackagePath: path.join(dshHome, 'profiles', targetProfile, 'package.json'),
    });
  }

  report.backup = await backupCritical({ dshHome, profileName: targetProfile, stampId });

  const tops = new Set();
  for (const entry of await readdir(longPath(stageDir), { withFileTypes: true })) {
    tops.add(entry.name);
  }

  const counters = { files: 0, dirs: 0, links: 0, warnings: [] };
  for (const top of tops) {
    const staged = path.join(stageDir, top);
    const target = path.join(dshHome, top);

    if (mode === 'replace' && (await exists(target))) {
      const aside = path.join(dshHome, 'portable-backups', stampId, 'replaced', top);
      await mkdir(path.dirname(aside), { recursive: true });
      await rm(longPath(aside), { recursive: true, force: true });
      await rename(longPath(target), longPath(aside));
      report.applied.push({ top, mode: 'replace', movedAside: aside });
    }

    const info = await stat(longPath(staged));
    if (info.isDirectory()) {
      await mergeTree({ sourceDir: staged, targetDir: target, logical: top, counters, onProgress });
      report.applied.push({ top, mode: mode === 'replace' ? 'replace' : 'merge', type: 'dir' });
    } else {
      await mkdir(longPath(path.dirname(target)), { recursive: true });
      await copyFile(longPath(staged), longPath(target));
      counters.files += 1;
      report.applied.push({ top, mode: mode === 'replace' ? 'replace' : 'merge', type: 'file' });
    }
  }

  report.counters = counters;
  report.warnings.push(...counters.warnings);

  report.prunedBackups = await pruneBackups({ dshHome, keep: keepBackups });

    return report;
  } finally {
    // A failed import must not leave gigabytes of staging behind: the success
    // path used to be the only one that cleaned up.
    await rm(longPath(stageDir), { recursive: true, force: true }).catch((error) => {
      report.warnings.push('staging kept at ' + stageDir + ': ' + error.code);
    });
  }
}
