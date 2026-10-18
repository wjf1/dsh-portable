import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readFile as rf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePackage } from '../lib/archive.mjs';
import { preview, install } from '../lib/installer.mjs';

const TOOL = { name: 'dsh-portable', version: '0.0.0-test' };
const OPTIONS = {
  includeNodeModules: true, includeSessions: false, includeRuntimes: false,
  includeCredentials: false, includeSourceMaps: true, includeBackups: false,
};

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function makeSourceHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-src-'));
  await mkdir(path.join(home, 'profiles', 'desktop', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true, dependencies: { 'pkg-a': '1.0.0' },
  }, null, 2));
  await writeFile(path.join(home, 'profiles', 'desktop', 'node_modules', 'pkg', 'index.js'), 'x\n');
  await writeFile(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    'hooks:\n  configPath: ' + path.join(home, 'hooks', 'hooks.json') + '\n');
  await mkdir(path.join(home, 'hooks'), { recursive: true });
  await writeFile(path.join(home, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  await writeFile(path.join(home, 'AGENTS.md'), 'rules\n');
  return home;
}

async function packageIt(home, name = 'pkg.dshpkg') {
  const out = path.join(home, 'exports', name);
  const source = { hostname: 'src', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'desktop', dshVersion: '' };
  await writePackage({ dshHome: home, profileName: 'desktop', options: OPTIONS, outPath: out, tool: TOOL, source });
  return out;
}

test('preview reports tops without touching the target', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  const plan = await preview({ filePath: file, dshHome: target });
  assert.equal(plan.sourceProfile, 'desktop');
  assert.equal(plan.targetProfile, 'desktop');
  assert.ok(plan.totals.files >= 4);
  const tops = plan.tops.map((t) => t.top);
  assert.ok(tops.includes('profiles/desktop'));
  assert.ok(tops.includes('hooks'));
  assert.equal(plan.tops.every((t) => t.existsOnTarget === false), true);
  assert.equal(await exists(path.join(target, 'profiles')), false);

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('install merges a package and rewrites source paths', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  const report = await install({ filePath: file, dshHome: target });

  assert.equal(report.targetProfile, 'desktop');
  assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'rules\n');
  assert.equal(await readFile(path.join(target, 'profiles', 'desktop', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'x\n');

  const patch = await readFile(path.join(target, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
  assert.equal(patch.includes(home), false, 'source home must not survive');
  assert.ok(patch.includes(target), 'patch must point at the target home');
  assert.ok(report.backup.dir.startsWith(path.join(target, 'portable-backups')));

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('merge keeps files the package does not contain', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  await mkdir(path.join(target, 'skills', 'mine'), { recursive: true });
  await writeFile(path.join(target, 'skills', 'mine', 'SKILL.md'), 'mine\n');
  await mkdir(path.join(target, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(target, 'profiles', 'desktop', 'local-only.txt'), 'keep me\n');

  await install({ filePath: file, dshHome: target, mode: 'merge' });
  assert.equal(await readFile(path.join(target, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(await readFile(path.join(target, 'profiles', 'desktop', 'local-only.txt'), 'utf8'), 'keep me\n');

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('replace moves the old tree aside', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  await mkdir(path.join(target, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(target, 'profiles', 'desktop', 'local-only.txt'), 'gone\n');

  const report = await install({ filePath: file, dshHome: target, mode: 'replace' });
  assert.equal(await exists(path.join(target, 'profiles', 'desktop', 'local-only.txt')), false);
  const aside = report.applied.find((a) => a.top === 'profiles' && a.movedAside);
  assert.ok(aside !== undefined);

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('installing into the source home skips rewriting but still applies', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const report = await install({ filePath: file, dshHome: home });
  assert.equal(report.rewrites, null, 'a same-home import must not rewrite anything');
  assert.equal(await readFile(path.join(home, 'AGENTS.md'), 'utf8'), 'rules\n');
  assert.equal(await exists(path.join(home, 'profiles', 'desktop', 'package.json')), true);

  await rm(home, { recursive: true, force: true });
});

test('renames the profile when the target name differs', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  const report = await install({ filePath: file, dshHome: target, profileName: 'work' });
  assert.equal(report.renamedProfile.to, 'work');
  assert.equal(await exists(path.join(target, 'profiles', 'work', 'package.json')), true);
  assert.equal(await exists(path.join(target, 'profiles', 'desktop')), false);

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});
