import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, readFile as rf } from 'node:fs/promises';
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

test('a failed import does not leave its staging directory behind', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);
  const bytes = await readFile(file);
  const truncated = path.join(home, 'exports', 'truncated.dshpkg');
  await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  await assert.rejects(install({ filePath: truncated, dshHome: target }));

  const stagingRoot = path.join(target, 'portable-staging');
  if (await exists(stagingRoot)) {
    // A broken package must not leave a half-extracted gigabyte behind.
    assert.deepEqual(await readdir(stagingRoot), []);
  }

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('a backup budget never prunes the pre-restore copies', async () => {
  const home = await makeSourceHome();
  const file = await packageIt(home);

  const target = await mkdtemp(path.join(tmpdir(), 'dp-dst-'));
  const backups = path.join(target, 'portable-backups');
  for (const stamp of ['20200101-000000', '20200101-000001']) {
    await mkdir(path.join(backups, stamp), { recursive: true });
    await writeFile(path.join(backups, stamp, 'AGENTS.md'), 'old\n');
  }
  // A restore writes one of these; the ordinary keep-N budget must not eat it,
  // or the one action that lets a user undo a restore would delete itself.
  await mkdir(path.join(backups, '20200101-000002-pre-restore'), { recursive: true });
  await writeFile(path.join(backups, '20200101-000002-pre-restore', 'AGENTS.md'), 'kept\n');

  await install({ filePath: file, dshHome: target, keepBackups: 0 });

  const left = await readdir(backups);
  assert.ok(left.includes('20200101-000002-pre-restore'), 'pre-restore copies survive a zero budget');
  assert.equal(left.filter((name) => /^\d{8}-\d{6}$/.test(name)).length, 0, 'keep 0 drops every ordinary snapshot');

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

/* ----------------------------------------------------- sub-path selection */

async function makeSkillSourceHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-include-src-'));
  await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"dsh-profile-desktop"}\n');
  for (const skill of ['one', 'two']) {
    await mkdir(path.join(home, 'skills', skill), { recursive: true });
    await writeFile(path.join(home, 'skills', skill, 'SKILL.md'), '# ' + skill + '\n');
  }
  await writeFile(path.join(home, 'AGENTS.md'), 'rules\n');
  return home;
}

test('a sub-path import applies only the selected prefix', async () => {
  const home = await makeSkillSourceHome();
  const file = await packageIt(home, 'skills.dshpkg');

  const target = await mkdtemp(path.join(tmpdir(), 'dp-include-dst-'));
  const plan = await preview({ filePath: file, dshHome: target, include: ['skills/one'] });
  assert.deepEqual(plan.include, ['skills/one']);
  const planTops = plan.tops.map((top) => top.top);
  assert.ok(planTops.includes('skills'), 'plan keeps the parent top');
  assert.ok(plan.totals.files < 5, 'plan covers only the selection, got ' + plan.totals.files);

  const report = await install({ filePath: file, dshHome: target, include: ['skills/one'] });
  assert.equal(await readFile(path.join(target, 'skills', 'one', 'SKILL.md'), 'utf8'), '# one\n');
  assert.equal(await exists(path.join(target, 'skills', 'two')), false, '未选中的兄弟技能不落地');
  assert.equal(await exists(path.join(target, 'AGENTS.md')), false, '未选中的顶层项不落地');
  assert.deepEqual(report.include, ['skills/one']);

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('replace mode with a sub-path selection never moves siblings aside', async () => {
  const home = await makeSkillSourceHome();
  const file = await packageIt(home, 'skills.dshpkg');

  const target = await mkdtemp(path.join(tmpdir(), 'dp-include-dst-'));
  await mkdir(path.join(target, 'skills', 'two'), { recursive: true });
  await writeFile(path.join(target, 'skills', 'two', 'SKILL.md'), 'old two\n');
  await mkdir(path.join(target, 'skills', 'one'), { recursive: true });
  await writeFile(path.join(target, 'skills', 'one', 'SKILL.md'), 'old one\n');

  const report = await install({ filePath: file, dshHome: target, mode: 'replace', include: ['skills/one'] });
  assert.equal(await readFile(path.join(target, 'skills', 'one', 'SKILL.md'), 'utf8'), '# one\n', '选中的技能被替换');
  assert.equal(await readFile(path.join(target, 'skills', 'two', 'SKILL.md'), 'utf8'), 'old two\n', '兄弟技能原样保留');

  const replaced = report.applied.filter((entry) => entry.movedAside).map((entry) => entry.top);
  assert.deepEqual(replaced, ['skills/one'], '替换单元是所选前缀，而不是整个顶层目录');

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('a selected path the package does not carry is a warning, not a failure', async () => {
  const home = await makeSkillSourceHome();
  const file = await packageIt(home, 'skills.dshpkg');

  const target = await mkdtemp(path.join(tmpdir(), 'dp-include-dst-'));
  const report = await install({ filePath: file, dshHome: target, include: ['skills/nope'] });
  assert.ok(report.warnings.some((w) => w.includes('skills/nope')), 'expected a warning naming the missing selection');
  assert.equal(report.applied.length, 0);

  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('normalizeInclude cleans selectors and refuses escapes', async () => {
  const { normalizeInclude } = await import('../lib/collect.mjs');
  assert.deepEqual(normalizeInclude(undefined), []);
  assert.deepEqual(normalizeInclude([' skills/one ', './skills/two']), ['skills/one', 'skills/two']);
  assert.deepEqual(normalizeInclude(['skills/one', 'skills/one']), ['skills/one'], 'duplicates collapse');
  assert.equal(normalizeInclude(['skills' + String.fromCharCode(92) + 'one'])[0], 'skills/one', 'backslashes become slashes');
  assert.throws(() => normalizeInclude('skills/one'), /array/);
  assert.throws(() => normalizeInclude(['../escape']), /climb out/);
  assert.throws(() => normalizeInclude(['a/../../b']), /climb out/);
  assert.throws(() => normalizeInclude([42]), /strings/);
});
