/**
 * dsh-portable — reads and writes .dshpkg archives.
 *
 * A .dshpkg is a gzip stream carrying a POSIX tar. The manifest is always the
 * first entry. Everything here streams: a 1 GB profile is packaged and unpacked
 * without ever holding a file in memory, which matters because the export runs
 * inside a worker thread of the editor's host process.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { TarWriter, TarParser } from './tar.mjs';
import { collectEntries, createStats, sourceRoots, MAX_ENTRIES, MAX_TOTAL_BYTES, MAX_SINGLE_FILE } from './collect.mjs';
import { buildManifest, parseManifest, MANIFEST_PATH, FORMAT } from './manifest.mjs';
import { longPath, safeJoin } from './paths.mjs';

/** Decompressed-to-compressed ratio above which an archive is assumed hostile. */
const DEFAULT_MAX_RATIO = 200;
/** Ratio checks only kick in once this much output has been produced. */
const RATIO_FLOOR_BYTES = 64 * 1024 * 1024;

/**
 * Trailing entry carrying a sha256 per payload file.
 *
 * Kept out of the manifest on purpose: see the comment where it is written.
 * A package without this entry is still readable (older packages, hand-made
 * ones); verification is skipped with a warning rather than refused, and the
 * caller can tell the difference from `stats.verified`.
 */
export const CHECKSUMS_PATH = '.dsh-portable/checksums.json';
export const CHECKSUMS_FORMAT = 'dsh-portable/checksums-1';

/** Yield `chunks` unchanged while feeding their bytes into a sha256. */
async function* hashChunks(chunks, onDigest) {
  const hash = createHash('sha256');
  for await (const chunk of chunks) {
    hash.update(chunk);
    yield chunk;
  }
  onDigest(hash.digest('hex'));
}

function chunksOf(buffer) {
  return (async function* () { yield buffer; })();
}

async function* fileChunks(absolute) {
  const stream = createReadStream(longPath(absolute));
  for await (const chunk of stream) yield chunk;
}

/**
 * Read exactly `size` bytes from an already-open handle.
 *
 * The handle is opened before the tar header is written, so a file the system
 * will not hand over (a locked session database, a file another process holds
 * open without sharing) never corrupts the stream: the whole entry is skipped
 * instead of failing after its header is already on the wire.
 */
async function* handleChunks(handle, size, short) {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let read = 0;
  while (read < size) {
    const want = Math.min(buffer.length, size - read);
    const { bytesRead } = await handle.read(buffer, 0, want, read);
    if (bytesRead === 0) {
      // The tar header already promised `size` bytes, so the stream cannot be
      // abandoned here without corrupting the archive. A live file (a log being
      // rotated, a database being rewritten) is padded to the promised length
      // and reported as a warning: one stale file outranks a failed export.
      short.value = true;
      while (read < size) {
        const fill = Math.min(64 * 1024, size - read);
        read += fill;
        yield Buffer.alloc(fill);
      }
      return;
    }
    read += bytesRead;
    // The buffer is reused, so the consumer gets its own copy.
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
}

/** Sink wrapper that applies backpressure to the tar writer. */
async function writeTo(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

/**
 * Package the allow-listed parts of a DSH home into \`outPath\`.
 *
 * The file is written to \`<outPath>.part\` and renamed on success, so an
 * interrupted export never leaves a half-written package that looks valid.
 */
export async function writePackage({
  dshHome, profileName, options, outPath, exclude, onProgress, tool, source, signal,
}) {
  const stats = createStats();
  const entries = [];

  for await (const entry of collectEntries({ dshHome, profileName, options, stats, exclude })) {
    signal?.throwIfAborted();
    entries.push(entry);
    if (entries.length % 2000 === 0) onProgress?.({ phase: 'scan', entries: entries.length, bytes: stats.bytes });
  }

  const roots = sourceRoots({ profileName, options });
  const manifest = buildManifest({ tool, source, options, stats, roots });
  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  await mkdir(longPath(path.dirname(outPath)), { recursive: true });
  const partial = outPath + '.part';
  await rm(longPath(partial), { force: true });

  const pass = new PassThrough();
  const output = createWriteStream(longPath(partial));
  const finished = pipeline(pass, createGzip({ level: 6 }), output);
  // The failure path below destroys the writer; without a handler here the
  // pipeline promise would reject with nobody listening and take the process
  // down with a bare "Premature close" that hides the real cause.
  finished.catch(() => {});
  const writer = new TarWriter((chunk) => writeTo(pass, chunk));

  let writtenFiles = 0;
  let writtenBytes = 0;
  let current = MANIFEST_PATH;
  /** logical path -> sha256 of the bytes actually written into the archive. */
  const digests = new Map();
  try {
    await writer.addFile(MANIFEST_PATH, manifestJson.length, chunksOf(manifestJson), { mode: 0o644, mtimeSeconds: Math.floor(Date.now() / 1000) });

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.type === 'dir') {
        await writer.addDirectory(entry.logical, { mode: entry.mode, mtimeSeconds: entry.mtimeSeconds });
        continue;
      }
      if (entry.type === 'symlink') {
        await writer.addSymlink(entry.logical, entry.linkTarget, { mtimeSeconds: entry.mtimeSeconds });
        continue;
      }
      current = entry.logical;
      let handle;
      try {
        handle = await open(longPath(entry.absolute), 'r');
      } catch (error) {
        // A profile is still worth exporting without one locked file; the
        // manifest lists what was skipped so the recipient can see the gap.
        stats.warnings.push({ path: entry.logical, reason: error.code || 'open failed' });
        current = entry.logical;
        continue;
      }
      const short = { value: false };
      try {
        await writer.addFile(
          entry.logical,
          entry.size,
          hashChunks(handleChunks(handle, entry.size, short), (hex) => digests.set(entry.logical, hex)),
          { mode: entry.mode, mtimeSeconds: entry.mtimeSeconds },
        );
      } finally {
        await handle.close().catch(() => {});
      }
      if (short.value) stats.warnings.push({ path: entry.logical, reason: 'shrank while packaging' });
      writtenFiles += 1;
      writtenBytes += entry.size;
      // The panel draws a bar from progress.percent; without it a 1.8 GB export
      // shows a spinner and nothing else. Total files are known from the scan,
      // so the percentage is honest from the first report.
      if (writtenFiles % 500 === 0) {
        onProgress?.({
          phase: 'write',
          files: writtenFiles,
          bytes: writtenBytes,
          totalFiles: stats.files,
          totalBytes: stats.bytes,
          percent: stats.files > 0 ? Math.round((writtenFiles / stats.files) * 100) : null,
        });
      }
    }

    // Checksums trail the payload rather than living in the manifest: a
    // node_modules-heavy home has tens of thousands of files, and putting them
    // in the manifest would turn `readManifest` (the cheap "what is in this
    // package" probe) into a multi-megabyte read.
    const checksumsJson = Buffer.from(JSON.stringify({
      format: CHECKSUMS_FORMAT,
      algorithm: 'sha256',
      files: Object.fromEntries(digests),
    }) + '\n', 'utf8');
    await writer.addFile(CHECKSUMS_PATH, checksumsJson.length, chunksOf(checksumsJson), {
      mode: 0o644,
      mtimeSeconds: Math.floor(Date.now() / 1000),
    });

    await writer.end();
    pass.end();
    await finished;
  } catch (error) {
    pass.destroy();
    await rm(longPath(partial), { force: true }).catch(() => {});
    // `finished` rejects with a bare "Premature close" when the writer fails
    // first, which says nothing about the cause; name the entry instead.
    if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      error.message = `packaging failed at ${current}: ${error.message}`;
      error.entry = current;
    }
    throw error;
  }

  await rm(longPath(outPath), { force: true }).catch(() => {});
  await rename(longPath(partial), longPath(outPath));
  const info = await stat(longPath(outPath));
  return { path: outPath, bytes: info.size, manifest, rawBytes: stats.bytes, entries: entries.length };
}

/**
 * Read only the manifest of a package. Stops reading as soon as the first entry
 * has been consumed, so this is O(kilobytes) regardless of archive size.
 */
export async function readManifest(filePath) {
  const source = createReadStream(longPath(filePath));
  const gunzip = createGunzip();
  // A read error (deleted file, EACCES, disk fault) must reach the consumer as
  // that error. Without this handler pipe() swallows it and the for-await ends
  // with "missing manifest", which names the wrong cause and can also crash the
  // process with an unhandled 'error' event.
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);

  let text = null;
  const parser = new TarParser(async (fields) => {
    if (text !== null) return;
    if (fields.type !== 'file' || fields.path !== MANIFEST_PATH) return;
    const parts = [];
    fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
    fields.end = async () => { text = Buffer.concat(parts).toString('utf8'); };
  });

  try {
    for await (const chunk of gunzip) {
      await parser.push(chunk);
      if (text !== null) break;
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }

  if (text === null) throw new Error('not a dsh-portable package: missing ' + MANIFEST_PATH);
  return { manifest: parseManifest(text), raw: text };
}

/**
 * Write target for a single archive entry that can never hang.
 *
 * `fs.WriteStream` reports some failures asynchronously — most importantly a
 * duplicate path, where `flags: 'wx'` raises `EEXIST` on the 'error' event
 * rather than at creation time. The obvious implementation
 *
 *     if (!stream.write(chunk)) await once(stream, 'drain');
 *     await new Promise((resolve) => stream.end(resolve));
 *
 * then waits forever: an errored stream never emits 'drain', and `end()`'s
 * callback never runs either. A crafted package with two entries sharing a
 * path therefore froze the whole import with the UI spinning indefinitely.
 *
 * Every wait here settles on the first of 'drain' (buffer flushed), 'close'
 * (guaranteed once the stream is done or destroyed) and 'error' (failure
 * recorded), so a write error degrades to a warning and extraction moves on —
 * consistent with the rest of the extractor, which treats anything the
 * filesystem refuses as non-fatal.
 *
 * @param {string} absolute  absolute destination path
 * @param {string} label     entry path, used in warnings
 * @param {(warning: string) => void} onWarning  warning sink
 */
function createEntryWriter(absolute, label, onWarning) {
  const stream = createWriteStream(longPath(absolute), { flags: 'wx' });
  /** @type {Error | null} */
  let failure = null;
  let closed = false;
  /** @type {Set<() => void>} */
  const waiters = new Set();

  const settleAll = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  stream.on('drain', settleAll);
  stream.on('error', (error) => {
    // First failure wins; later events on a torn-down stream are noise.
    if (failure === null) {
      failure = error;
      onWarning('write failed for ' + label + ': ' + error.message);
    }
    settleAll();
  });
  stream.on('close', () => {
    closed = true;
    settleAll();
  });

  const waitSettled = () => new Promise((resolve) => {
    if (failure !== null || closed || stream.destroyed) {
      resolve();
      return;
    }
    waiters.add(resolve);
  });

  return {
    get failed() { return failure !== null; },
    async write(chunk) {
      if (failure !== null || stream.destroyed) return;
      if (stream.write(chunk)) return;
      await waitSettled();
    },
    async end() {
      if (failure !== null || stream.destroyed) {
        stream.destroy();
        return;
      }
      stream.end();
      await waitSettled();
    },
  };
}

/**
 * Unpack a package into \`destDir\`, streaming every file to disk.
 *
 * \`onEntry(meta)\` runs before an entry is materialised and may return the
 * string 'skip' to leave that entry out (a dry run uses this to compare without
 * writing). Anything the filesystem refuses — a reserved device name, a symlink
 * without privileges — becomes a warning, not a fatal error, because a partially
 * restorable profile is still useful.
 *
 * \`signal\` makes a long extraction abortable: the caller's \`finally\` blocks
 * then run normally, which is what lets a cancelled import clean up its staging
 * directory instead of leaking it.
 */
export async function extractPackage({
  filePath, destDir, onEntry, limits, onProgress, signal,
}) {
  const maxEntries = limits?.maxEntries ?? MAX_ENTRIES;
  const maxTotal = limits?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxRatio = limits?.maxRatio ?? DEFAULT_MAX_RATIO;
  const maxSingle = limits?.maxSingleFile ?? MAX_SINGLE_FILE;

  const info = await stat(longPath(filePath));
  const stats = {
    entries: 0, files: 0, dirs: 0, links: 0, bytes: 0,
    skipped: [], warnings: [], manifest: null,
    /** Whether per-file checksums were present and matched. */
    verified: null,
  };

  const dryRun = destDir === null || destDir === undefined;
  if (!dryRun) await mkdir(longPath(destDir), { recursive: true });

  let decompressed = 0;
  let manifestSeen = false;
  /** logical path -> sha256 of the bytes written to disk. */
  const actual = new Map();
  /** Contents of the trailing checksums entry, if the package has one. */
  let checksums = null;

  const parser = new TarParser(async (fields) => {
    stats.entries += 1;
    if (stats.entries > maxEntries) throw new Error('archive has too many entries: more than ' + maxEntries);

    if (fields.path === MANIFEST_PATH && fields.type === 'file') {
      const parts = [];
      fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
      fields.end = async () => {
        stats.manifest = parseManifest(Buffer.concat(parts).toString('utf8'));
        manifestSeen = true;
      };
      return;
    }

    if (fields.path === CHECKSUMS_PATH && fields.type === 'file') {
      const parts = [];
      fields.write = async (chunk) => { parts.push(Buffer.from(chunk)); };
      fields.end = async () => {
        checksums = parseChecksums(Buffer.concat(parts).toString('utf8'));
      };
      return;
    }

    if (fields.type === 'dir') {
      const decision = await onEntry?.({ path: fields.path, type: 'dir', size: 0 });
      if (decision === 'skip' || dryRun) { stats.skipped.push(fields.path); return; }
      try {
        await mkdir(longPath(safeJoin(destDir, fields.path)), { recursive: true });
        stats.dirs += 1;
      } catch (error) {
        stats.warnings.push('cannot create directory ' + fields.path + ': ' + error.code);
      }
      return;
    }

    if (fields.type === 'symlink') {
      const decision = await onEntry?.({ path: fields.path, type: 'symlink', size: 0, linkTarget: fields.linkname });
      if (decision === 'skip' || dryRun) { stats.skipped.push(fields.path); return; }
      const target = fields.linkname;
      const unsafe = target.startsWith('/') || /^[a-z]:/i.test(target) || target.split(/[\\/]/).includes('..');
      if (unsafe) {
        stats.warnings.push('refused unsafe symlink ' + fields.path + ' -> ' + target);
        return;
      }
      try {
        const absolute = safeJoin(destDir, fields.path);
        await mkdir(longPath(path.dirname(absolute)), { recursive: true });
        await symlink(target, longPath(absolute));
        stats.links += 1;
      } catch (error) {
        stats.warnings.push('cannot create symlink ' + fields.path + ' (needs privilege on Windows): ' + error.code);
      }
      return;
    }

    // regular file
    if (fields.size > maxSingle) throw new Error('entry too large: ' + fields.path + ' (' + fields.size + ' bytes)');
    stats.bytes += fields.size;
    if (stats.bytes > maxTotal) throw new Error('archive expands to more than ' + maxTotal + ' bytes');

    const decision = await onEntry?.({ path: fields.path, type: 'file', size: fields.size });
    if (decision === 'skip' || dryRun) { stats.skipped.push(fields.path); return; }

    let absolute;
    try {
      absolute = safeJoin(destDir, fields.path);
    } catch (error) {
      stats.warnings.push('refused unsafe path ' + fields.path + ': ' + error.message);
      fields.write = async () => {};
      fields.end = async () => {};
      return;
    }

    await mkdir(longPath(path.dirname(absolute)), { recursive: true });
    const writer = createEntryWriter(
      absolute,
      fields.path,
      (warning) => stats.warnings.push(warning),
    );
    // Hash what we actually write, so the comparison later detects a package
    // that was tampered with or truncated rather than silently restoring
    // different bytes than the sender packaged.
    const digest = createHash('sha256');
    fields.write = (chunk) => {
      digest.update(chunk);
      return writer.write(chunk);
    };
    fields.end = async () => {
      if (writer.failed) return;
      await writer.end();
      // The failure can surface while the last write is flushing (a duplicate
      // path raises EEXIST on open), so re-check before counting the file.
      if (writer.failed) return;
      actual.set(fields.path, digest.digest('hex'));
      stats.files += 1;
      if (stats.files % 500 === 0) onProgress?.({ files: stats.files, bytes: stats.bytes });
    };
  });

  const source = createReadStream(longPath(filePath));
  const gunzip = createGunzip();
  // A read error (deleted file, EACCES, disk fault) must reach the consumer as
  // that error. Without this handler pipe() swallows it and the for-await ends
  // with "missing manifest", which names the wrong cause and can also crash the
  // process with an unhandled 'error' event.
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);

  let failure = null;
  try {
    for await (const chunk of gunzip) {
      signal?.throwIfAborted();
      decompressed += chunk.length;
      if (decompressed > maxTotal) throw new Error('archive expands to more than ' + maxTotal + ' bytes');
      if (decompressed > RATIO_FLOOR_BYTES && info.size > 0 && decompressed / info.size > maxRatio) {
        throw new Error('suspicious compression ratio ' + (decompressed / info.size).toFixed(0) + ':1 (limit ' + maxRatio + ':1)');
      }
      await parser.push(chunk);
    }
    await parser.finish();
  } catch (error) {
    failure = error;
  } finally {
    source.destroy();
    gunzip.destroy();
  }

  if (failure !== null) throw failure;
  if (!manifestSeen) throw new Error('not a dsh-portable package: missing ' + MANIFEST_PATH);

  // Integrity check. A mismatch is fatal: the whole point is to stop a
  // tampered or truncated package from being silently restored as if it were
  // the one that was sent.
  if (checksums !== null) {
    const mismatched = [];
    for (const [logical, expected] of Object.entries(checksums.files)) {
      const got = actual.get(logical);
      // Not extracted at all (skipped by the caller, dry run, or a duplicate
      // entry that was refused) — nothing to compare against.
      if (got === undefined) continue;
      if (got !== expected) mismatched.push(logical);
    }
    if (mismatched.length > 0) {
      const sample = mismatched.slice(0, 5).join(', ');
      throw new Error(
        'package failed its checksum verification: ' + String(mismatched.length) + ' file(s) differ from the manifest, e.g. ' + sample,
      );
    }
    stats.verified = true;
  } else if (!dryRun) {
    // Older packages (and hand-built ones) carry no checksums; say so instead
    // of implying the import was verified.
    stats.verified = false;
    stats.warnings.push('package has no checksums; contents were not verified');
  }

  return stats;
}

/** Parse a checksums entry, rejecting anything shaped unexpectedly. */
function parseChecksums(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('checksums entry is not valid JSON: ' + error.message);
  }
  if (value === null || typeof value !== 'object') throw new Error('checksums entry is not an object');
  if (value.format !== CHECKSUMS_FORMAT) {
    throw new Error('unsupported checksums format: ' + String(value.format));
  }
  if (value.files === null || typeof value.files !== 'object') {
    throw new Error('checksums entry is missing the files map');
  }
  return value;
}

export { FORMAT };
