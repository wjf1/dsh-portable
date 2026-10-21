import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePackage, readManifest, extractPackage, CHECKSUMS_PATH } from '../lib/archive.mjs';
import { TarWriter } from '../lib/tar.mjs';
import { MANIFEST_PATH } from '../lib/manifest.mjs';

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
  assert.equal(stats.verified, true, '自己打的包必须带上并通过校验');
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

/**
 * Build a .dshpkg whose tar carries two entries with the same path.
 *
 * `flags: 'wx'` makes the second copy fail with EEXIST *asynchronously*, i.e.
 * after the entry handler has already accepted it. That is the shape that used
 * to deadlock the extractor (see the next test).
 */
async function writeDuplicateEntryPackage(outPath, entryPath, bodies) {
  const manifest = JSON.stringify({
    format: 'dsh-portable/1',
    createdAt: new Date().toISOString(),
    tool: TOOL,
    source: { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: '/tmp/home', profile: 'demo', dshVersion: '' },
    options: {},
    stats: { entries: bodies.length + 1, files: bodies.length, dirs: 0, links: 0, bytes: bodies.reduce((n, b) => n + Buffer.byteLength(b), 0) },
    roots: [],
  });
  const bufferOf = (text) => (async function* () { yield Buffer.from(text); })();

  const gzip = createGzip();
  const parts = [];
  gzip.on('data', (chunk) => parts.push(chunk));
  const drained = new Promise((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });

  const writer = new TarWriter((chunk) => { gzip.write(chunk); });
  await writer.addFile(MANIFEST_PATH, Buffer.byteLength(manifest), bufferOf(manifest));
  for (const body of bodies) {
    await writer.addFile(entryPath, Buffer.byteLength(body), bufferOf(body));
  }
  await writer.end();
  gzip.end();
  await drained;

  await writeFile(outPath, Buffer.concat(parts));
}

test('does not hang on a package with duplicate path entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-dup-'));
  const out = path.join(dir, 'dup.dshpkg');
  await writeDuplicateEntryPackage(out, 'AGENTS.md', ['first\n', 'second\n']);

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-dup-restore-'));
  // Regression: extraction used to wait forever for a 'drain' that an errored
  // write stream never emits, leaving the import progress spinning.
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('extractPackage hung on a duplicate entry')), 15_000);
    timer.unref?.();
  });
  const stats = await Promise.race([
    extractPackage({ filePath: out, destDir: dest }),
    timeout,
  ]);

  assert.equal(stats.entries, 3);
  // O_EXCL keeps the first copy: a hostile package cannot overwrite a file it
  // already delivered, it only earns a warning.
  assert.equal(await readFile(path.join(dest, 'AGENTS.md'), 'utf8'), 'first\n');
  assert.equal(stats.files, 1);
  assert.ok(
    stats.warnings.some((w) => w.includes('AGENTS.md')),
    'expected a warning naming the duplicate entry, got ' + JSON.stringify(stats.warnings),
  );

  await rm(dir, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

/** Build a package by hand: manifest + the given files + optional checksums. */
async function writeRawPackage(outPath, files, checksums) {
  const manifest = JSON.stringify({
    format: 'dsh-portable/1',
    createdAt: new Date().toISOString(),
    tool: TOOL,
    source: { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: '/tmp/home', profile: 'demo', dshVersion: '' },
    options: {},
    stats: { entries: files.length + 1, files: files.length, dirs: 0, links: 0, bytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) },
    roots: [],
  });
  const bufferOf = (text) => (async function* () { yield Buffer.from(text); })();

  const gzip = createGzip();
  const parts = [];
  gzip.on('data', (chunk) => parts.push(chunk));
  const drained = new Promise((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });

  const writer = new TarWriter((chunk) => { gzip.write(chunk); });
  await writer.addFile(MANIFEST_PATH, Buffer.byteLength(manifest), bufferOf(manifest));
  for (const file of files) {
    await writer.addFile(file.path, Buffer.byteLength(file.content), bufferOf(file.content));
  }
  if (checksums !== undefined) {
    const text = JSON.stringify({ format: 'dsh-portable/checksums-1', algorithm: 'sha256', files: checksums });
    await writer.addFile(CHECKSUMS_PATH, Buffer.byteLength(text), bufferOf(text));
  }
  await writer.end();
  gzip.end();
  await drained;

  await writeFile(outPath, Buffer.concat(parts));
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('a package without checksums still restores, but says it was not verified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-nohash-'));
  const out = path.join(dir, 'plain.dshpkg');
  await writeRawPackage(out, [{ path: 'AGENTS.md', content: 'hello\n' }]);

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-nohash-restore-'));
  const stats = await extractPackage({ filePath: out, destDir: dest });
  assert.equal(await readFile(path.join(dest, 'AGENTS.md'), 'utf8'), 'hello\n');
  assert.equal(stats.verified, false, '必须明确报告"未校验"，而不是假装通过');
  assert.ok(stats.warnings.some((w) => w.includes('no checksums')));

  await rm(dir, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('matching checksums are reported as verified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-hash-'));
  const out = path.join(dir, 'good.dshpkg');
  const body = 'verified payload\n';
  await writeRawPackage(out, [{ path: 'AGENTS.md', content: body }], { 'AGENTS.md': sha256(body) });

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-hash-restore-'));
  const stats = await extractPackage({ filePath: out, destDir: dest });
  assert.equal(stats.verified, true);
  assert.equal(await readFile(path.join(dest, 'AGENTS.md'), 'utf8'), body);

  await rm(dir, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('a package whose bytes do not match its checksums is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-badhash-'));
  const out = path.join(dir, 'tampered.dshpkg');
  // The declared digest belongs to different content: exactly what a
  // tampered or truncated package looks like.
  await writeRawPackage(
    out,
    [{ path: 'AGENTS.md', content: 'what actually arrived\n' }],
    { 'AGENTS.md': sha256('what was packaged\n') },
  );

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-badhash-restore-'));
  await assert.rejects(
    () => extractPackage({ filePath: out, destDir: dest }),
    /checksum verification/,
  );

  await rm(dir, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});
