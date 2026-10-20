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
  dshHome, profileName, options, outPath, exclude, onProgress, tool, source,
}) {
  const stats = createStats();
  const entries = [];

  for await (const entry of collectEntries({ dshHome, profileName, options, stats, exclude })) {
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
  try {
    await writer.addFile(MANIFEST_PATH, manifestJson.length, chunksOf(manifestJson), { mode: 0o644, mtimeSeconds: Math.floor(Date.now() / 1000) });

    for (const entry of entries) {
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
        await writer.addFile(entry.logical, entry.size, handleChunks(handle, entry.size, short), { mode: entry.mode, mtimeSeconds: entry.mtimeSeconds });
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
 * Unpack a package into \`destDir\`, streaming every file to disk.
 *
 * \`onEntry(meta)\` runs before an entry is materialised and may return the
 * string 'skip' to leave that entry out (a dry run uses this to compare without
 * writing). Anything the filesystem refuses — a reserved device name, a symlink
 * without privileges — becomes a warning, not a fatal error, because a partially
 * restorable profile is still useful.
 */
export async function extractPackage({
  filePath, destDir, onEntry, limits, onProgress,
}) {
  const maxEntries = limits?.maxEntries ?? MAX_ENTRIES;
  const maxTotal = limits?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxRatio = limits?.maxRatio ?? DEFAULT_MAX_RATIO;
  const maxSingle = limits?.maxSingleFile ?? MAX_SINGLE_FILE;

  const info = await stat(longPath(filePath));
  const stats = {
    entries: 0, files: 0, dirs: 0, links: 0, bytes: 0,
    skipped: [], warnings: [], manifest: null,
  };

  const dryRun = destDir === null || destDir === undefined;
  if (!dryRun) await mkdir(longPath(destDir), { recursive: true });

  let decompressed = 0;
  let manifestSeen = false;

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
    const stream = createWriteStream(longPath(absolute), { flags: 'wx' });
    stream.on('error', (error) => { stats.warnings.push('write failed for ' + fields.path + ': ' + error.message); });
    fields.write = async (chunk) => {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
    };
    fields.end = async () => {
      await new Promise((resolve) => stream.end(resolve));
      stats.files += 1;
      if (stats.files % 500 === 0) onProgress?.({ files: stats.files, bytes: stats.bytes });
    };
  });

  const source = createReadStream(longPath(filePath));
  const gunzip = createGunzip();
  source.pipe(gunzip);

  let failure = null;
  try {
    for await (const chunk of gunzip) {
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
  return stats;
}

export { FORMAT };
