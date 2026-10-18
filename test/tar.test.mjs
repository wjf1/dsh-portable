import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TarWriter, TarParser } from '../lib/tar.mjs';

async function build(entries) {
  const chunks = [];
  const writer = new TarWriter((chunk) => { chunks.push(Buffer.from(chunk)); });
  for (const entry of entries) {
    if (entry.type === 'dir') await writer.addDirectory(entry.path);
    else if (entry.type === 'symlink') await writer.addSymlink(entry.path, entry.target);
    else {
      const payload = Buffer.from(entry.data ?? '', 'utf8');
      await writer.addFile(entry.path, payload.length, (async function* () { yield payload; })());
    }
  }
  await writer.end();
  return Buffer.concat(chunks);
}

async function read(tarball) {
  const seen = [];
  const parser = new TarParser(async (fields) => {
    if (fields.type === 'file') {
      const parts = [];
      fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
      fields.end = async () => { seen.push({ ...fields, data: Buffer.concat(parts).toString('utf8') }); };
    } else {
      seen.push({ ...fields });
    }
  });
  await parser.push(tarball);
  await parser.finish();
  return seen;
}

test('round-trips a single file', async () => {
  const tar = await build([{ path: 'hello.txt', data: 'hi there' }]);
  const entries = await read(tar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'hello.txt');
  assert.equal(entries[0].type, 'file');
  assert.equal(entries[0].data, 'hi there');
});

test('round-trips directories and symlinks', async () => {
  const tar = await build([
    { type: 'dir', path: 'a' },
    { type: 'dir', path: 'a/b' },
    { type: 'symlink', path: 'a/b/link', target: '../target.txt' },
    { path: 'a/b/target.txt', data: 'payload' },
  ]);
  const entries = await read(tar);
  assert.deepEqual(entries.map((e) => [e.type, e.path]), [
    ['dir', 'a'],
    ['dir', 'a/b'],
    ['symlink', 'a/b/link'],
    ['file', 'a/b/target.txt'],
  ]);
  assert.equal(entries[2].linkname, '../target.txt');
});

test('splits long paths into ustar prefix without PAX', async () => {
  const tail = 'file.txt';
  const head = ('deep/'.repeat(20)).replace(/\/$/, '');
  const p = head + '/' + tail;
  assert.ok(Buffer.byteLength(p) > 100);
  assert.ok(Buffer.byteLength(p) <= 255);
  const tar = await build([{ path: p, data: 'x' }]);
  const entries = await read(tar);
  assert.equal(entries[0].path, p);
});

test('falls back to a PAX record for a single long segment', async () => {
  const p = 'y'.repeat(120) + '/leaf.txt';
  const tar = await build([{ path: p, data: 'pax' }]);
  const entries = await read(tar);
  assert.equal(entries[0].path, p);
  assert.equal(entries[0].data, 'pax');
});

test('a PAX body is padded, so the entry after it stays aligned', async () => {
  // A single path segment beyond 100 bytes forces a PAX record. Its body is
  // almost never a multiple of 512, and skipping that padding is what keeps the
  // next header on its boundary — this is the case a one-entry test cannot see.
  const long = 'd'.repeat(150) + '/leaf.txt';
  const tar = await build([
    { path: long, data: 'inside' },
    { path: 'after.txt', data: 'next' },
  ]);
  const entries = await read(tar);
  assert.deepEqual(entries.map((entry) => entry.path), [long, 'after.txt']);
  assert.deepEqual(entries.map((entry) => entry.data), ['inside', 'next']);
});

test('a PAX entry survives being fed in small chunks', async () => {
  const long = 'p'.repeat(140) + '/' + 'q'.repeat(60) + '.bin';
  const tar = await build([
    { path: long, data: 'x'.repeat(700) },
    { path: 'tail.txt', data: 'tail' },
  ]);
  const seen = [];
  const parser = new TarParser(async (fields) => {
    if (fields.type !== 'file') return;
    const parts = [];
    fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
    fields.end = async () => { seen.push({ path: fields.path, bytes: Buffer.concat(parts).length }); };
  });
  // 23 is coprime with 512, so every alignment (header, PAX body, padding)
  // gets split at least once.
  for (let i = 0; i < tar.length; i += 23) await parser.push(tar.subarray(i, i + 23));
  await parser.finish();
  assert.deepEqual(seen, [
    { path: long, bytes: 700 },
    { path: 'tail.txt', bytes: 4 },
  ]);
});

test('handles block boundaries 0, 512 and 513 bytes', async () => {
  const sizes = [0, 512, 513];
  const entries = sizes.map((n, i) => ({ path: 'f' + i + '.bin', data: 'z'.repeat(n) }));
  const tar = await build(entries);
  assert.equal(tar.length % 512, 0);
  const readBack = await read(tar);
  assert.deepEqual(readBack.map((e) => e.data.length), sizes);
});

test('streams across arbitrary chunk boundaries', async () => {
  const tar = await build([{ path: 'big.bin', data: 'q'.repeat(3000) }]);
  const seen = [];
  const parser = new TarParser(async (fields) => {
    if (fields.type !== 'file') return;
    const parts = [];
    fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
    fields.end = async () => { seen.push(Buffer.concat(parts).length); };
  });
  for (let i = 0; i < tar.length; i += 37) await parser.push(tar.subarray(i, i + 37));
  await parser.finish();
  assert.deepEqual(seen, [3000]);
});

test('survives a gzip round trip', async () => {
  const tar = await build([{ path: 'dir/f.txt', data: 'gz' }]);
  const entries = await read(gunzipSync(gzipSync(tar)));
  assert.equal(entries[0].data, 'gz');
});

test('rejects a body shorter than its header promises', async () => {
  const writer = new TarWriter(() => {});
  const short = (async function* () { yield Buffer.from('abc'); })();
  await assert.rejects(() => writer.addFile('x.bin', 10, short), /size mismatch for x\.bin: header 10, body 3/);
});

test('rejects a truncated archive', async () => {
  const tar = await build([{ path: 'f.bin', data: 'a'.repeat(2048) }]);
  const parser = new TarParser(() => {});
  await parser.push(tar.subarray(0, 1024));
  await assert.rejects(() => parser.finish(), /tar truncated: \d+ bytes missing/);
});
