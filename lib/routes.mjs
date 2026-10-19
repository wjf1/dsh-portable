/**
 * dsh-portable — the HTTP surface.
 *
 * The browser half and the model tools both drive this; nothing else does. Two
 * rules shape every handler:
 *
 *  - **A route is a promise about a path, never a path argument.** Files are
 *    addressed as \`<kind>:<basename>\` where kind is \`exports\` or \`uploads\`;
 *    the basename is validated to contain no separator, so no request can name
 *    a file outside the two directories this plugin owns.
 *  - **Long work returns a job, not a response.** Scanning gigabytes and
 *    writing a tar both take minutes; a handler that blocks that long is a
 *    handler that gets a gateway timeout and leaves the user guessing.
 *
 * The request fence mirrors what the other first-party plugins do: the host's
 * own gate when it publishes one, loopback otherwise.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readManifest } from './archive.mjs';

export const API_PREFIX = '/dsh-portable/api';

const MAX_JSON_BODY = 1 << 20; // 1 MiB: config payloads, never file data
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const ARTIFACT_KINDS = new Set(['exports', 'uploads']);

/* ------------------------------------------------------------------ helpers */

export function sendJson(response, status, value) {
  // A handler that streamed a file has already written the headers; writing a
  // JSON head on top of them throws ERR_HTTP_HEADERS_SENT instead of answering.
  if (response.writableEnded || response.headersSent || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function sendText(response, status, text) {
  if (response.writableEnded || response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badRequest(message, code = 'BAD_REQUEST') {
  return new HttpError(400, message, code);
}

function notFound(message) {
  return new HttpError(404, message, 'NOT_FOUND');
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BODY) throw new HttpError(413, 'request body is too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('request body is not valid JSON', 'BAD_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('request body must be a JSON object', 'BAD_JSON');
  }
  return parsed;
}

/** Loopback-only, unless the host publishes its own request gate. */
function makeFence(hostCtx) {
  return (request, response) => {
    try {
      const connection = hostCtx.get?.('connection');
      const gate = connection?.requestRejection;
      if (typeof gate === 'function') {
        const verdict = gate.call(connection, request);
        if (verdict) {
          if (!response.headersSent) sendText(response, 403, 'refused by the host request gate' + '\n');
          return true;
        }
        return false;
      }
    } catch {
      // A gate that throws is not a gate; fall through to the loopback rule.
    }
    const address = request.socket?.remoteAddress ?? '';
    const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
    if (!loopback) {
      sendText(response, 403, 'this endpoint is only reachable from loopback' + '\n');
      return true;
    }
    return false;
  };
}

/** \`exports:name.dshpkg\` -> absolute path, with the basename already proven safe. */
/** Backup folders are named after the stamp that created them, plus the safety copies a restore writes first. */
const BACKUP_STAMP = /^\d{8}-\d{6}(?:-pre-restore)?$/;

/**
 * Every regular file inside a backup folder, as paths relative to the DSH home.
 *
 * `replaced/` is deliberately skipped: that tree holds what an import moved
 * aside, not the configuration a restore should put back.
 */
async function listBackupFiles(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (base === '' && entry.name === 'replaced') continue;
    const rel = base === '' ? entry.name : base + '/' + entry.name;
    if (entry.isDirectory()) out.push(...(await listBackupFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

function resolveArtifact(store, id) {
  if (typeof id !== 'string' || id === '') throw badRequest('artifactId is required', 'BAD_ARTIFACT');
  const separator = id.indexOf(':');
  if (separator <= 0) throw badRequest('artifactId must look like exports:<name>', 'BAD_ARTIFACT');
  const kind = id.slice(0, separator);
  const name = id.slice(separator + 1);
  if (!ARTIFACT_KINDS.has(kind)) throw badRequest('unknown artifact kind: ' + kind, 'BAD_ARTIFACT');
  if (safePackageName(name) === null) throw badRequest('invalid artifact name', 'BAD_ARTIFACT');
  return { kind, name, filePath: path.join(store.dirs[kind], name) };
}

async function listArtifacts(store, kind) {
  const dir = store.dirs[kind];
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const name of names) {
    if (name.endsWith('.part') || name.startsWith('_')) continue;
    const filePath = path.join(dir, name);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    rows.push({ id: kind + ':' + name, kind, name, size: info.size, mtime: info.mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/* ------------------------------------------------------------------- router */

/**
 * @param options.store - { dirs: { exports, uploads } }
 * @param options.jobs - the JobManager
 * @param options.share - the ShareServer
 * @param options.hostInfo - () => ({ version, profile, dshHome, platform })
 * @param options.source - (profileName) => source descriptor for a manifest
 * @param options.tool - { name, version }
 */
export function createRouter(options) {
  const { store, jobs, share, hostInfo, source, tool } = options;

  const table = [
    ['GET', '/status', async () => {
      const info = hostInfo();
      return {
        ok: true,
        plugin: tool,
        ...info,
        capabilities: { export: true, import: true, share: true, tools: true },
        busyJobId: jobs.busyJob?.id ?? null,
      };
    }],

    ['GET', '/profiles', async () => {
      const profilesDir = path.join(hostInfo().dshHome, 'profiles');
      let names = [];
      try {
        const entries = await readdir(profilesDir, { withFileTypes: true });
        names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { profiles: names, current: hostInfo().profile };
    }],

    ['GET', '/jobs', async () => ({ jobs: jobs.list().map((job) => publicJob(job)) })],

    ['GET', '/jobs/detail', async ({ url }) => {
      const job = jobs.get(url.searchParams.get('id') ?? '');
      if (job === null) throw notFound('no such job');
      return { job: publicJob(job, true) };
    }],

    ['POST', '/jobs/cancel', async ({ body }) => {
      if (!jobs.cancel(String(body.id ?? ''))) throw notFound('no such job');
      return { cancelled: true };
    }],

    ['POST', '/export', async ({ body }) => {
      const info = hostInfo();
      const profileName = trimmed(body.profile) ?? info.profile;
      const fileName = safePackageName(trimmed(body.name) ?? 'dsh-portable-' + timestamp()) ?? null;
      if (fileName === null) throw badRequest('invalid package name', 'BAD_NAME');
      const outPath = path.join(store.dirs.exports, fileName);
      const job = jobs.start({
        kind: 'export',
        args: {
          dshHome: info.dshHome,
          profileName,
          options: normalizeExportOptions(body),
          outPath,
          tool,
          source: source(profileName),
        },
      });
      return { job: publicJob(job), artifactId: 'exports:' + fileName };
    }],

    ['GET', '/artifacts', async () => {
      const exports_ = await listArtifacts(store, 'exports');
      const uploads = await listArtifacts(store, 'uploads');
      return { artifacts: [...exports_, ...uploads] };
    }],

    ['GET', '/artifacts/meta', async ({ url }) => {
      const target = resolveArtifact(store, url.searchParams.get('artifactId'));
      const { manifest } = await readManifest(target.filePath);
      return {
        artifactId: url.searchParams.get('artifactId'),
        manifest,
        roots: (manifest.roots ?? []).map((root) => ({ id: root.id, logical: root.logical, files: root.files, bytes: root.bytes })),
      };
    }],

    // The one route that answers with a file instead of JSON. The panel links
    // here with `a[download]`, so the browser saves the package to disk and it
    // can travel on a USB stick to a machine with no network at all — which is
    // the case this plugin exists for. Streamed, never buffered: a package is
    // routinely hundreds of megabytes.
    ['GET', '/artifacts/download', async ({ url, response }) => {
      const artifactId = url.searchParams.get('artifactId');
      const target = resolveArtifact(store, artifactId);
      const info = await stat(target.filePath).catch(() => null);
      if (info === null || !info.isFile()) throw notFound('artifact not found: ' + artifactId);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="' + target.name.replace(/["\\\r\n]/g, '') + '"',
        'content-length': String(info.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      try {
        await pipeline(createReadStream(target.filePath), response);
      } catch {
        // The browser cancelled the save, or the disk failed mid-stream. The
        // headers are already out, so dropping the socket is the only honest
        // signal left; the outer handler must not try to write JSON on top.
        response.destroy();
      }
      return { ok: true, artifactId, size: info.size };
    }],

    ['POST', '/artifacts/delete', async ({ body }) => {
      const target = resolveArtifact(store, body.artifactId);
      await rm(target.filePath, { force: true });
      return { deleted: true, artifactId: body.artifactId };
    }],

    ['POST', '/import/preview', async ({ body }) => {
      const target = resolveArtifact(store, body.artifactId);
      const info = hostInfo();
      const job = jobs.start({
        kind: 'preview',
        args: {
          filePath: target.filePath,
          dshHome: info.dshHome,
          profileName: trimmed(body.profile),
        },
      });
      return { job: publicJob(job) };
    }],

    ['POST', '/import', async ({ body }) => {
      if (body.confirm !== true) {
        throw badRequest('import writes into DSH_HOME; pass confirm:true to proceed', 'CONFIRM_REQUIRED');
      }
      const target = resolveArtifact(store, body.artifactId);
      const info = hostInfo();
      const job = jobs.start({
        kind: 'import',
        args: {
          filePath: target.filePath,
          dshHome: info.dshHome,
          profileName: trimmed(body.profile),
          mode: body.mode === 'replace' ? 'replace' : 'merge',
          keepBackups: Number.isFinite(body.keepBackups) ? body.keepBackups : 5,
        },
      });
      return { job: publicJob(job) };
    }],

    ['GET', '/backups', async () => {
      const root_ = path.join(hostInfo().dshHome, 'portable-backups');
      let names = [];
      try {
        const entries = await readdir(root_, { withFileTypes: true });
        names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { backups: names };
    }],

    ['POST', '/backups/restore', async ({ body }) => {
      const stamp = typeof body.stamp === 'string' ? body.stamp.trim() : '';
      if (!BACKUP_STAMP.test(stamp)) throw badRequest('invalid backup stamp: ' + stamp, 'BAD_STAMP');
      const rootDir = path.join(hostInfo().dshHome, 'portable-backups');
      const sourceDir = path.join(rootDir, stamp);
      const info = await stat(sourceDir).catch(() => null);
      if (info === null || !info.isDirectory()) throw notFound('backup not found: ' + stamp);

      const files = await listBackupFiles(sourceDir);
      if (files.length === 0) throw badRequest('backup ' + stamp + ' holds no configuration files', 'EMPTY_BACKUP');

      // Restoring is itself a write: the files it is about to replace get their
      // own folder first, so a restore made by mistake is one more restore away.
      const preDir = path.join(rootDir, timestamp() + '-pre-restore');
      const restored = [];
      const failed = [];
      for (const rel of files) {
        const source = path.join(sourceDir, ...rel.split('/'));
        const target = path.join(hostInfo().dshHome, ...rel.split('/'));
        const current = await stat(target).catch(() => null);
        if (current !== null && current.isFile()) {
          const aside = path.join(preDir, ...rel.split('/'));
          await mkdir(path.dirname(aside), { recursive: true });
          await copyFile(target, aside).catch(() => {});
        }
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(source, target);
          restored.push(rel);
        } catch (error) {
          failed.push(rel + ': ' + (error.code ?? error.message));
        }
      }
      return { stamp, restored, failed, preRestore: preDir };
    }],

    ['GET', '/share', async () => ({ shares: share.list(), running: share.running, port: share.port })],

    ['POST', '/share', async ({ body }) => {
      const target = resolveArtifact(store, body.artifactId);
      const info = await stat(target.filePath).catch(() => null);
      if (info === null || !info.isFile()) throw notFound('artifact not found: ' + body.artifactId);
      const created = await share.add({
        filePath: target.filePath,
        displayName: target.name,
        maxDownloads: Number.isFinite(body.maxDownloads) ? Math.max(1, Math.trunc(body.maxDownloads)) : 1,
        ttlMinutes: Number.isFinite(body.ttlMinutes) ? body.ttlMinutes : undefined,
      });
      return { share: created };
    }],

    ['POST', '/share/remove', async ({ body }) => ({ removed: share.remove(String(body.token ?? '')) })],
  ];

  const compiled = table.map(([method, pattern, handler]) => ({
    method,
    segments: pattern.split('/').filter(Boolean),
    handler,
  }));

  function match(method, pathname) {
    const trimmed = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname;
    let parts;
    try {
      parts = trimmed.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    for (const route of compiled) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let index = 0; index < parts.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = parts[index];
        else if (segment !== parts[index]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  const fence = makeFence(options.hostContext);

  return async function handle(request, response) {
    if (fence(request, response)) return;
    const url = new URL(request.url ?? '/', 'http://localhost');

    // Uploads are their own thing: a raw PUT stream, deliberately not JSON.
    if (request.method === 'PUT' && url.pathname.startsWith(API_PREFIX + '/upload/')) {
      const name = safePackageName(decodeURIComponentSafe(url.pathname.slice((API_PREFIX + '/upload/').length)));
      if (name === null) {
        sendJson(response, 400, { ok: false, error: 'invalid upload name', code: 'BAD_UPLOAD_NAME' });
        return;
      }
      await receiveUpload(request, response, path.join(store.dirs.uploads, name));
      return;
    }

    const found = match(request.method, url.pathname);
    if (found === null) {
      sendJson(response, 404, { ok: false, error: 'no such route: ' + request.method + ' ' + url.pathname, code: 'NO_ROUTE' });
      return;
    }

    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? {} : await readJsonBody(request);
      const result = await found.handler({ params: found.params, body, url, request, response });
      if (!response.writableEnded) sendJson(response, 200, result);
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      if (error instanceof HttpError) {
        sendJson(response, error.status, { ok: false, error: error.message, code: error.code });
        return;
      }
      // A failed download has already sent its 200 head; there is no status
      // line left to change, so the only truthful move is to cut the stream.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error), code: 'INTERNAL' });
    }
  };
}

function publicJob(job, verbose = false) {
  const base = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    error: job.error,
  };
  return verbose ? { ...base, result: job.result, args: job.args } : base;
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function normalizeExportOptions(body) {
  return {
    includeNodeModules: body.includeNodeModules !== false,
    includeSessions: body.includeSessions === true,
    includeRuntimes: body.includeRuntimes === true,
    includeCredentials: body.includeCredentials === true,
    includeSourceMaps: body.includeSourceMaps !== false,
    includeBackups: body.includeBackups === true,
  };
}

/** A package name this plugin is willing to write: no separators, no surprises. */
function safePackageName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed_ = raw.trim();
  if (trimmed_ === '' || trimmed_.length > 160) return null;
  if (trimmed_.includes('/') || trimmed_.includes('\\') || trimmed_.includes('..')) return null;
  if (/[\x00-\x1f<>:"|?*]/.test(trimmed_)) return null;
  return trimmed_.endsWith('.dshpkg') ? trimmed_ : trimmed_ + '.dshpkg';
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

/** Stream an upload straight to disk, with a hard byte cap. */
async function receiveUpload(request, response, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const part = destination + '.part';
  let written = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > MAX_UPLOAD_BYTES) {
        callback(new Error('upload exceeds the 8 GiB limit'));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(request, limiter, createWriteStream(part, { flags: 'w' }));
    await rename(part, destination);
    sendJson(response, 200, { ok: true, artifactId: 'uploads:' + path.basename(destination), size: written });
  } catch (error) {
    await rm(part, { force: true }).catch(() => {});
    sendJson(response, 400, { ok: false, error: error.message, code: 'UPLOAD_FAILED' });
  }
}
