#!/usr/bin/env node
/**
 * dsh-portable — command line importer.
 *
 * The plugin's settings panel is the normal way in, but it needs a running DSH
 * and a GUI. This entry point is for the other case: a fresh machine, a USB
 * stick, a headless box. It uses the exact same installer module, so a package
 * imported here and one imported from the panel land identically.
 *
 *   node bootstrap.mjs preview <package.dshpkg> [--home <dir>] [--profile <name>]
 *   node bootstrap.mjs install <package.dshpkg> [--home <dir>] [--profile <name>]
 *                                              [--mode merge|replace] [--yes]
 *
 * Exit codes: 0 success, 1 usage error, 2 the package was refused.
 */

import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = [
  'dsh-portable importer',
  '',
  '  node bootstrap.mjs preview <package.dshpkg> [options]',
  '  node bootstrap.mjs install <package.dshpkg> [options]',
  '',
  'Options',
  '  --home <dir>       DSH home (default: DSH_HOME, else ~/.dsh)',
  "  --profile <name>   profile to install into (default: the package's own, else desktop)",
  '  --mode <kind>      merge (default) keeps files the package does not carry;',
  "                     replace moves the target's copies aside first",
  '  --yes              skip the confirmation prompt',
  '  --keep <n>         how many backups to retain (default 5)',
  '  --help             show this text',
  '',
].join('\n');

function fail(message, code = 1) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(code);
}

function parse(argv) {
  const out = { command: null, packagePath: null, home: null, profile: null, mode: 'merge', yes: false, keep: 5 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--help' || token === '-h') { process.stdout.write(USAGE); process.exit(0); }
    if (token === '--yes' || token === '-y') { out.yes = true; continue; }
    if (token === '--home' || token === '--profile' || token === '--mode' || token === '--keep') {
      const value = rest[i + 1];
      if (value === undefined) fail(token + ' needs a value');
      i += 1;
      if (token === '--home') out.home = value;
      if (token === '--profile') out.profile = value;
      if (token === '--mode') out.mode = value;
      if (token === '--keep') out.keep = Number(value);
      continue;
    }
    if (token.startsWith('-')) fail('unknown option ' + token);
    if (out.command === null) out.command = token;
    else if (out.packagePath === null) out.packagePath = token;
    else fail('unexpected argument ' + token);
  }
  if (out.command !== 'preview' && out.command !== 'install') fail('expected "preview" or "install"');
  if (out.packagePath === null) fail('missing the .dshpkg path');
  if (out.mode !== 'merge' && out.mode !== 'replace') fail('--mode must be merge or replace');
  if (!Number.isFinite(out.keep) || out.keep < 0) fail('--keep must be a number');
  return out;
}

function expandHome(value) {
  return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

function homeFromEnv(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(expandHome(fromEnv.trim()));
  return path.join(os.homedir(), '.dsh');
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
}

function progressReporter() {
  let last = 0;
  return (event) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    if (event.phase === 'extract') {
      process.stderr.write('\r  reading ' + (event.entries ?? 0) + ' entries, ' + human(event.bytes ?? 0) + '   ');
    } else if (event.phase === 'write') {
      process.stderr.write('\r  packing ' + (event.files ?? 0) + '/' + (event.totalFiles ?? 0) + '   ');
    } else if (event.phase === 'apply') {
      process.stderr.write('\r  installing ' + (event.files ?? 0) + ' files   ');
    }
  };
}

async function main() {
  const args = parse(process.argv);
  const home = homeFromEnv(args.home);

  try {
    await access(args.packagePath);
  } catch {
    fail('no such package: ' + path.resolve(args.packagePath));
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const load = (name) => import(pathToFileURL(path.join(here, '..', 'lib', name)).href);
  const { preview, install } = await load('installer.mjs');
  const onProgress = progressReporter();

  process.stdout.write('package  ' + path.resolve(args.packagePath) + '\n');
  process.stdout.write('home     ' + home + '\n');

  let plan;
  try {
    plan = await preview({ filePath: args.packagePath, dshHome: home, profileName: args.profile ?? undefined });
  } catch (error) {
    process.stderr.write('\n');
    fail('the package was refused: ' + error.message, 2);
  }

  const targetProfile = args.profile ?? plan.targetProfile ?? 'desktop';
  process.stdout.write('profile  ' + (plan.sourceProfile || '(unrecorded)') + ' -> ' + targetProfile + (plan.requiresProfileRename ? ' (renamed)' : '') + '\n');
  process.stdout.write('contents ' + plan.totals.files + ' files, ' + human(plan.totals.bytes) + ', ' + plan.totals.tops + ' top-level items\n');
  for (const top of plan.tops) {
    process.stdout.write('  ' + (top.existsOnTarget ? '*' : '+') + ' ' + top.top + '  (' + top.files + ' files)\n');
  }
  if (plan.tops.some((top) => top.existsOnTarget)) {
    process.stdout.write('* already present in the target home\n');
  }

  if (args.command === 'preview') {
    process.stdout.write('\nnothing was written (preview).\n');
    return;
  }

  if (!args.yes) {
    if (!process.stdin.isTTY) {
      fail('refusing to install without a terminal; pass --yes to confirm', 2);
    }
    const answer = await new Promise((resolve) => {
      process.stdout.write('\ninstall into ' + home + ' (' + args.mode + ')? [y/N] ');
      process.stdin.resume();
      process.stdin.once('data', (chunk) => {
        process.stdin.pause();
        resolve(String(chunk).trim().toLowerCase());
      });
    });
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('cancelled.\n');
      return;
    }
  }

  let result;
  try {
    result = await install({ filePath: args.packagePath, dshHome: home, profileName: targetProfile, mode: args.mode, keepBackups: args.keep, onProgress });
  } catch (error) {
    process.stderr.write('\n');
    fail('install failed: ' + error.message, 2);
  }
  process.stderr.write('\n');

  process.stdout.write('\ninstalled.\n');
  const applied = result.applied.map((item) => item.top + (item.mode === 'replace' ? ' (replaced)' : '')).join(', ');
  process.stdout.write('  applied     ' + applied + '\n');
  if (result.rewrites) {
    process.stdout.write('  rewrites    ' + result.rewrites.files.length + ' files, ' + result.rewrites.changes + ' paths\n');
  } else {
    process.stdout.write('  rewrites    none (package was already built for ' + home + ')\n');
  }
  if (result.backup && result.backup.dir) process.stdout.write('  backup      ' + result.backup.dir + '\n');
  if (result.warnings && result.warnings.length > 0) {
    process.stdout.write('  warnings    ' + result.warnings.length + ' (see below)\n');
    for (const warning of result.warnings.slice(0, 20)) {
      if (typeof warning === 'string') process.stdout.write('    - ' + warning + '\n');
      else process.stdout.write('    - ' + (warning.path || warning.top || '') + ': ' + (warning.reason || warning.message || '') + '\n');
    }
    if (result.warnings.length > 20) process.stdout.write('    ... ' + (result.warnings.length - 20) + ' more\n');
  }
  process.stdout.write('\nrestart DSH so the new profile files are loaded.\n');
}

main().catch((error) => {
  process.stderr.write('\n');
  fail(error && error.stack ? error.stack : String(error), 2);
});
