import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePackage, readManifest, extractPackage } from '../lib/archive.mjs';
import { isEncryptedPackage, ENCRYPTION_MAGIC, HEADER_BYTES, TAG_BYTES, KEY_CHECK_PLAINTEXT, IV_BYTES, SALT_BYTES } from '../lib/crypto.mjs';

const TOOL = { name: 'dsh-portable', version: '0.0.0-test' };
const PASSPHRASE = 'correct horse battery staple';

const BASE_OPTIONS = {
  includeNodeModules: true, includeSessions: false, includeRuntimes: false,
  includeCredentials: false, includeSourceMaps: true, includeBackups: false,
  includeDisabledSkills: false,
};

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-crypto-home-'));
  await mkdir(path.join(home, 'profiles', 'demo'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'demo', 'package.json'), '{"name":"dsh-profile-demo"}\n');
  await mkdir(path.join(home, 'skills', 'demo-skill'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\n');
  return home;
}

function sourceFor(home) {
  return { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'demo', dshVersion: '' };
}

async function exportEncrypted(home, outPath) {
  return writePackage({ dshHome: home, profileName: 'demo', options: BASE_OPTIONS, outPath, tool: TOOL, source: sourceFor(home), passphrase: PASSPHRASE });
}

/** Flip one byte at the given absolute offset inside the package file. */
async function flipByte(filePath, offset) {
  const handle = await open(filePath, 'r+');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, offset);
    buffer[0] ^= 0xff;
    await handle.write(buffer, 0, 1, offset);
  } finally {
    await handle.close();
  }
}

test('an encrypted export round-trips through import with the passphrase', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'secret.dshpkg');
  const result = await exportEncrypted(home, out);

  // The file on disk starts with the magic, not with gzip bytes.
  const info = await stat(out);
  assert.ok(info.size > HEADER_BYTES + TAG_BYTES);
  assert.equal(await isEncryptedPackage(out), true);

  const { manifest } = await readManifest(out, { passphrase: PASSPHRASE });
  assert.equal(manifest.format, 'dsh-portable/1');
  assert.equal(manifest.source.profile, 'demo');
  assert.ok(manifest.stats.files >= 2, 'expected at least 2 files');

  const dest = await mkdtemp(path.join(tmpdir(), 'dp-crypto-restore-'));
  const stats = await extractPackage({ filePath: out, destDir: dest, passphrase: PASSPHRASE });
  assert.equal(stats.verified, true, '校验和应原样穿过加密层并通过');
  assert.equal(await readFile(path.join(dest, 'profiles', 'demo', 'package.json'), 'utf8'), '{"name":"dsh-profile-demo"}\n');
  assert.equal(await readFile(path.join(dest, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), '# demo skill\n');
  assert.ok(result.bytes > 0);

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('reading an encrypted package without a passphrase names the cause', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'secret.dshpkg');
  await exportEncrypted(home, out);

  await assert.rejects(() => readManifest(out), /package is encrypted/);
  const dest = await mkdtemp(path.join(tmpdir(), 'dp-crypto-nopass-'));
  await assert.rejects(() => extractPackage({ filePath: out, destDir: dest }), /package is encrypted/);

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('a wrong passphrase is a clear error, not garbage bytes', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'secret.dshpkg');
  await exportEncrypted(home, out);

  await assert.rejects(
    () => readManifest(out, { passphrase: 'totally wrong' }),
    /wrong passphrase|authentication/i,
  );
  const dest = await mkdtemp(path.join(tmpdir(), 'dp-crypto-wrongpass-'));
  await assert.rejects(
    () => extractPackage({ filePath: out, destDir: dest, passphrase: 'totally wrong' }),
    /wrong passphrase|authentication/i,
  );
  assert.equal(await readFile(path.join(dest, 'profiles', 'demo', 'package.json'), 'utf8').then(() => true, () => false), false,
    '错误口令不应留下半解密的文件');

  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('tampering with the ciphertext or the tag fails the authentication check', async () => {
  // Body tamper: the modified ciphertext turns into garbage that no longer
  // parses as the gzip stream it is supposed to be.
  const homeA = await makeHome();
  const bodyTampered = path.join(homeA, 'exports', 'tampered.dshpkg');
  await exportEncrypted(homeA, bodyTampered);
  await flipByte(bodyTampered, HEADER_BYTES + 10);
  await assert.rejects(
    () => readManifest(bodyTampered, { passphrase: PASSPHRASE }),
    (error) => /corrupted|wrong passphrase|authentication|header check/i.test(error.message),
    'expected the ciphertext tamper to be detected',
  );
  await rm(homeA, { recursive: true, force: true });

  // Tag tamper: the manifest probe (readManifest) stops before the tail tag by
  // design — it is a cheap header read, not a verification. A full extraction
  // runs decipher.final() and must refuse the package.
  const homeB = await makeHome();
  const tagTampered = path.join(homeB, 'exports', 'tampered-tag.dshpkg');
  await exportEncrypted(homeB, tagTampered);
  const size = (await stat(tagTampered)).size;
  await flipByte(tagTampered, size - 1);
  const probeDest = await mkdtemp(path.join(tmpdir(), 'dp-crypto-tamper-'));
  await readManifest(tagTampered, { passphrase: PASSPHRASE }); // cheap probe still works
  await assert.rejects(
    () => extractPackage({ filePath: tagTampered, destDir: probeDest, passphrase: PASSPHRASE }),
    (error) => /corrupted|wrong passphrase|authentication/i.test(error.message),
    'expected the tag tamper to be detected on full extraction',
  );
  await rm(homeB, { recursive: true, force: true });
  await rm(probeDest, { recursive: true, force: true });
});

test('a truncated encrypted package is rejected before decryption', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'secret.dshpkg');
  await exportEncrypted(home, out);
  const size = (await stat(out)).size;
  assert.ok(size > HEADER_BYTES + TAG_BYTES, 'sanity: a real package holds header plus tag');
  // Shrink the file below the minimum container shape: magic intact, no room
  // for a tag. The magic is what keeps this "encrypted" in the reader's eyes.
  await rm(out);
  await writeFile(out, Buffer.concat([
    ENCRYPTION_MAGIC,
    Buffer.alloc(HEADER_BYTES + TAG_BYTES - 5 - ENCRYPTION_MAGIC.length),
  ]));

  await assert.rejects(
    () => readManifest(out, { passphrase: PASSPHRASE }),
    /too small|truncated/,
  );
  await rm(home, { recursive: true, force: true });
});

test('a passphrase on a plain package is ignored, and plain packages stay plain', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'plain.dshpkg');
  await writePackage({ dshHome: home, profileName: 'demo', options: BASE_OPTIONS, outPath: out, tool: TOOL, source: sourceFor(home) });

  assert.equal(await isEncryptedPackage(out), false);
  const { manifest } = await readManifest(out, { passphrase: 'irrelevant' });
  assert.equal(manifest.format, 'dsh-portable/1');

  // A file that is not a package at all is not reported as "encrypted".
  const bogus = path.join(home, 'exports', 'bogus.dshpkg');
  await writeFile(bogus, 'definitely not a tarball');
  assert.equal(await isEncryptedPackage(bogus), false);

  await rm(home, { recursive: true, force: true });
});

test('crypto helpers agree on the container layout', () => {
  assert.equal(ENCRYPTION_MAGIC.length, 12);
  assert.equal(TAG_BYTES, 16);
  assert.equal(HEADER_BYTES, ENCRYPTION_MAGIC.length + SALT_BYTES + IV_BYTES * 2 + KEY_CHECK_PLAINTEXT.length + TAG_BYTES);
});
