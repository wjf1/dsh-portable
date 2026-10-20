import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePackage, readManifest, extractPackage } from '../lib/archive.mjs';

const TOOL = { name: 'dsh-portable', version: '0.0.0-test' };

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-home-'));
  await mkdir(path.join(home, 'profiles', 'demo', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'demo', 'package.json'), '{"name":"dsh-profile-demo"}\n');
  await writeFile(path.join(home, 'profiles', 'demo', 'node_modules', 'pkg', 'index.js'), 'export const a = 1;\n');
  await mkdir(path.join(home, 'skills', 'demo-skill'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\n');
  await writeFile(path.join(home, 'AGENTS.md'), 'global rules\n');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await writeFile(path.join(home, 'sessions', 's1.json'), '{"session":1}\n');
  return home;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const BASE_OPTIONS = {
  includeNodeModules: true, includeSessions: false, includeRuntimes: false,
  includeCredentials: false, includeSourceMaps: true, includeBackups: false,
};

test('packages a home and reads the manifest back', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'demo.dshpkg');
  const source = { hostname: 'test-host', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'demo', dshVersion: '' };

  const result = await writePackage({ dshHome: home, profileName: 'demo', options: BASE_OPTIONS, outPath: out, tool: TOOL, source });
  assert.ok(result.bytes > 0);
  assert.equal(await exists(out), true);

  const { manifest } = await readManifest(out);
  assert.equal(manifest.format, 'dsh-portable/1');
  assert.equal(manifest.source.hostname, 'test-host');
  assert.equal(manifest.source.profile, 'demo');
  assert.ok(manifest.stats.files >= 4, 'expected at least 4 files, got ' + manifest.stats.files);
  assert.equal(manifest.stats.links, 0);
  await rm(home, { recursive: true, force: true });
});

test('round-trips file contents through extract', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'demo.dshpkg');
  const source = { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'demo', dshVersion: '' };
  await writePackage({ dshHome: home, profileName: 'demo', options: BASE_OPTIONS, outPath: out, tool: TOOL, source });

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-restore-'));
  const stats = await extractPackage({ filePath: out, destDir: dest });
  assert.equal(stats.manifest.format, 'dsh-portable/1');
  assert.equal(await readFile(path.join(dest, 'profiles', 'demo', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await readFile(path.join(dest, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), '# demo skill\n');
  assert.equal(await readFile(path.join(dest, 'AGENTS.md'), 'utf8'), 'global rules\n');
  assert.equal(await exists(path.join(dest, 'sessions')), false);

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('honours includeNodeModules and includeSessions', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'lean.dshpkg');
  const source = { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'demo', dshVersion: '' };
  await writePackage({
    dshHome: home, profileName: 'demo', outPath: out, tool: TOOL, source,
    options: { ...BASE_OPTIONS, includeNodeModules: false, includeSessions: true },
  });

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-restore-'));
  await extractPackage({ filePath: out, destDir: dest });
  assert.equal(await exists(path.join(dest, 'profiles', 'demo', 'node_modules')), false);
  assert.equal(await exists(path.join(dest, 'profiles', 'demo', 'package.json')), true);
  assert.equal(await exists(path.join(dest, 'sessions', 's1.json')), true);

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('dry run skips entries without writing them', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'demo.dshpkg');
  const source = { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'demo', dshVersion: '' };
  await writePackage({ dshHome: home, profileName: 'demo', options: BASE_OPTIONS, outPath: out, tool: TOOL, source });

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-dry-'));
  const seen = [];
  const stats = await extractPackage({
    filePath: out, destDir: dest,
    onEntry: async (meta) => { seen.push(meta.path); return 'skip'; },
  });
  assert.ok(seen.some((p) => p.endsWith('index.js')));
  assert.equal(stats.files, 0);
  assert.ok(stats.skipped.length >= 4);

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('rejects a file that is not a dsh-portable package', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-bad-'));
  const bogus = path.join(dir, 'bogus.dshpkg');
  await writeFile(bogus, 'definitely not a tarball');
  await assert.rejects(() => readManifest(bogus));
  await rm(dir, { recursive: true, force: true });
});

test('a missing file surfaces as ENOENT, not as a missing manifest', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-gone-'));
  const gone = path.join(dir, 'gone.dshpkg');
  // Without the source error forwarder this rejects with "missing manifest",
  // which points at the package content instead of the unreadable path.
  await assert.rejects(() => readManifest(gone), (error) => error.code === 'ENOENT');
  await rm(dir, { recursive: true, force: true });
});
