/**
 * dsh-portable — makes an imported profile point at the machine it now lives on.
 *
 * A profile records absolute paths in a few well-known places: hooks carry a
 * configPath, some plugins store a workspace or a model gateway in
 * cordis.patch.yml, and a market-installed plugin may pin an absolute tarball.
 * Carrying those verbatim to another machine produces a profile that starts but
 * silently runs with broken hooks.
 *
 * The importer therefore rewrites the source DSH home to the local one inside a
 * fixed list of configuration files. It does not scan package contents: those
 * are third-party code, and rewriting bytes inside them would corrupt installs
 * that verify their own integrity.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths.mjs';

/**
 * The files worth rewriting, relative to the package root. Everything here is
 * configuration a human edits, never vendored code.
 */
export function rewriteTargets(profileName) {
  return [
    'profiles/' + profileName + '/cordis.patch.yml',
    'profiles/' + profileName + '/cordis.yml',
    'profiles/' + profileName + '/package.json',
    'profiles/' + profileName + '/pnpm-workspace.yaml',
    'hooks/hooks.json',
    'hooks/settings.json',
  ];
}

/** The three spellings an absolute Windows path takes in config files. */
export function pathVariants(absolutePath) {
  const native = absolutePath.replace(/\//g, '\\');
  return {
    native,
    posix: native.replace(/\\/g, '/'),
    escaped: native.replace(/\\/g, '\\\\'),
  };
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function escapeForReplacement(text) {
  return text.replace(/\$/g, '$$$$');
}

/** Case-insensitive replace-all that also handles Windows' unstable casing. */
export function replaceAllInsensitive(text, needle, replacement) {
  if (needle.length === 0) return text;
  const pattern = new RegExp(escapeForRegExp(needle), 'gi');
  return text.replace(pattern, escapeForReplacement(replacement));
}

/**
 * Rewrite every spelling of the source home to the target home.
 * Returns the new text plus how many substitutions happened.
 */
export function rewriteHomePaths(text, fromHome, toHome) {
  if (fromHome === toHome) return { text, changes: 0 };
  const from = pathVariants(fromHome);
  const to = pathVariants(toHome);

  let output = text;
  let changes = 0;
  for (const key of ['escaped', 'native', 'posix']) {
    if (from[key].length === 0) continue;
    const before = output;
    output = replaceAllInsensitive(output, from[key], to[key]);
    if (output !== before) {
      const matches = before.match(new RegExp(escapeForRegExp(from[key]), 'gi'));
      changes += matches === null ? 1 : matches.length;
    }
  }
  return { text: output, changes };
}

/**
 * Merge the incoming profile package.json into what the target machine already
 * has, keeping dependencies that only exist on the target.
 *
 * Why keep them: a user who installed a market plugin on the new machine and
 * then imports an older package should not lose that plugin from the profile's
 * manifest — the files are still in node_modules, but DSH would stop loading it
 * once the manifest no longer lists it.
 */
export function mergeProfilePackage(targetJson, incomingJson) {
  const target = targetJson !== null && typeof targetJson === 'object' ? targetJson : {};
  const incoming = incomingJson !== null && typeof incomingJson === 'object' ? incomingJson : {};

  const merged = { ...target, ...incoming };
  const targetDeps = target.dependencies ?? {};
  const incomingDeps = incoming.dependencies ?? {};
  const dependencies = { ...incomingDeps };

  const kept = [];
  const overridden = [];
  for (const [name, version] of Object.entries(targetDeps)) {
    if (!(name in dependencies)) {
      dependencies[name] = version;
      kept.push(name);
    } else if (dependencies[name] !== version) {
      overridden.push({ name, incoming: dependencies[name], target: version });
    }
  }
  merged.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const incomingBundles = Array.isArray(merged.dsh?.profile?.bundles) ? merged.dsh.profile.bundles : [];
  const targetBundles = Array.isArray(target.dsh?.profile?.bundles) ? target.dsh.profile.bundles : [];
  const missingBundles = targetBundles.filter((name) => !incomingBundles.includes(name));
  if (missingBundles.length > 0) {
    merged.dsh = {
      ...merged.dsh,
      profile: { ...merged.dsh?.profile, bundles: [...incomingBundles, ...missingBundles] },
    };
  }

  return { merged, kept, overridden, missingBundles };
}

/**
 * Rewrite the configuration files of an extracted package in place.
 * Missing files are not an error: a package built without hooks has no hooks.
 */
export async function rewriteExtractedTree({
  stageDir, packageProfile, targetProfile, toHome, fromHome, targetPackagePath,
}) {
  const report = { files: [], changes: 0, warnings: [], merged: [] };
  const profileForFiles = targetProfile ?? packageProfile;

  for (const logical of rewriteTargets(packageProfile)) {
    const absolute = path.join(stageDir, ...logical.split('/'));
    let text;
    try {
      text = await readFile(longPath(absolute), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      report.warnings.push('cannot read ' + logical + ': ' + error.code);
      continue;
    }

    const rewritten = rewriteHomePaths(text, fromHome, toHome);
    let next = rewritten.text;
    const fileChanges = rewritten.changes;

    if (logical.endsWith('package.json')) {
      let parsed;
      try {
        parsed = JSON.parse(next);
      } catch (error) {
        report.warnings.push('invalid JSON in ' + logical + ': ' + error.message);
        continue;
      }
      // Merge with what the target machine already had, so importing a package
      // made on another machine never drops a plugin this one installed later.
      // Before 0.1.8 this call was missing entirely: the merge helper existed
      // but nothing invoked it, and the target lost its own entries.
      let targetParsed = null;
      if (typeof targetPackagePath === 'string' && targetPackagePath.length > 0) {
        try {
          targetParsed = JSON.parse(await readFile(longPath(targetPackagePath), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            report.warnings.push('cannot read ' + targetPackagePath + ': ' + error.code);
          }
        }
      }
      const outcome = mergeProfilePackage(targetParsed, parsed);
      parsed = outcome.merged;
      if (outcome.kept.length > 0 || outcome.missingBundles.length > 0) {
        report.merged.push({
          path: logical,
          kept: outcome.kept,
          missingBundles: outcome.missingBundles,
          overridden: outcome.overridden,
        });
      }
      next = JSON.stringify(parsed, null, 2) + '\n';
    }

    if (next !== text) {
      await writeFile(longPath(absolute), next, 'utf8');
      report.changes += fileChanges;
      report.files.push({ path: logical, changes: fileChanges });
    }
  }

  return report;
}
