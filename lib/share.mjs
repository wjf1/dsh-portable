/**
 * dsh-portable — the one-shot LAN handoff.
 *
 * A package on disk is only useful on the machine that made it. The alternative
 * to "copy it to a USB stick" is a short-lived HTTP server that serves exactly
 * one file, to exactly one download, over the local network — and then shuts
 * itself down.
 *
 * Design rules, in the order they constrain the code:
 *
 *  - **Only what was registered.** Requests never name a path; they carry a
 *    token that maps to a file already in the table. There is no traversal to
 *    defend against because no path is ever parsed out of a request.
 *  - **One download, then gone.** A share's remaining count hits zero on the
 *    first completed response. Serving a second copy requires a new share.
 *  - **Never bound to a routable interface by itself.** The server listens on
 *    0.0.0.0 because the point is another machine, but it only ever answers
 *    the tokens in the table, and every token expires.
 *  - **It dies on its own.** The whole server closes when the last share
 *    expires, so a forgotten tab does not leave a port open for a day.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_MAX_DOWNLOADS = 1;
const SWEEP_INTERVAL_MS = 15_000;

/** Every IPv4 address this machine can be reached on, excluding loopback. */
export function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // 169.254/16 is link-local: reachable only on a broken network.
      if (entry.address.startsWith('169.254.')) continue;
      found.push({ name, address: entry.address });
    }
  }
  return found;
}

/** Human URL for a share, given the address the other machine should use. */
function shareUrl(address, port, token) {
  return 'http://' + address + ':' + String(port) + '/d/' + token;
}

export class ShareServer {
  constructor({ ttlMinutes = DEFAULT_TTL_MINUTES, onEvent } = {}) {
    this.ttlMinutes = clampTtl(ttlMinutes);
    this.onEvent = onEvent;
    this.server = null;
    this.port = null;
    this.shares = new Map();
    // Tokens that were issued and are no longer valid. Without it a request for
    // a consumed link and a request for a random string look identical, and the
    // first one deserves "it expired" rather than "never existed".
    this.retired = new Set();
    this.sweeper = null;
    this.starting = null;
  }

  get running() {
    return this.server !== null;
  }

  /**
   * Publish a file. Starts the server if this is the first share.
   * @returns the share description, including every LAN URL that resolves to it.
   */
  async add({ filePath, displayName, maxDownloads = DEFAULT_MAX_DOWNLOADS, ttlMinutes } = {}) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('share target is not a file: ' + filePath);
    await this.ensureServer();

    const token = randomBytes(16).toString('hex');
    const share = {
      token,
      filePath,
      displayName: displayName ?? path.basename(filePath),
      size: info.size,
      downloadsMax: Math.max(1, Number(maxDownloads) || DEFAULT_MAX_DOWNLOADS),
      downloads: 0,
      /** 已预留但尚未结算的名额，见下载处理里的说明。 */
      active: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + clampTtl(ttlMinutes ?? this.ttlMinutes) * 60_000,
      lastDownloadAt: null,
    };
    this.shares.set(token, share);
    this.notify();
    return this.describe(share);
  }

  describe(share) {
    const addresses = lanAddresses();
    const urls = addresses.map((entry) => shareUrl(entry.address, this.port, share.token));
    return {
      token: share.token,
      displayName: share.displayName,
      size: share.size,
      downloads: share.downloads,
      downloadsMax: share.downloadsMax,
      remainingDownloads: Math.max(0, share.downloadsMax - share.downloads),
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      fileName: path.basename(share.filePath),
      urls,
      addresses,
      port: this.port,
    };
  }

  /** Currently live shares, newest first. */
  list() {
    this.sweep();
    return [...this.shares.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((share) => this.describe(share));
  }

  /** Revoke one share by token. Closes the server when none are left. */
  remove(token) {
    const share = this.shares.get(token);
    if (share === undefined) return false;
    this.shares.delete(token);
    this.retire(token);
    void this.closeIfIdle();
    this.notify();
    return true;
  }

  /** Revoke everything and stop listening. */
  async close() {
    this.shares.clear();
    await this.closeServer();
    this.notify();
  }

  /** Drop expired shares; stop the server when the table empties. */
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [token, share] of this.shares) {
      if (now >= share.expiresAt) {
        this.shares.delete(token);
        this.retire(token);
        changed = true;
      }
    }
    if (changed) this.notify();
    if (this.shares.size === 0) void this.closeIfIdle();
    return changed;
  }

  async ensureServer() {
    if (this.server !== null) return;
    // Two concurrent share.add() calls must not each start a server: the
    // second listen(0) would replace this.server and leak the first socket.
    if (this.starting === null) {
      this.starting = this.startServer();
    }
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async startServer() {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        try {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('internal error\n');
        } catch {
          // response already began; nothing left to do.
        }
        this.onEvent?.({ type: 'error', message: String(error?.message ?? error) });
      });
    });
    // Keep the bookkeeping truthful: a port that is taken must not look like a
    // successful share.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = server.address().port;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  async closeIfIdle() {
    if (this.shares.size > 0) return;
    await this.closeServer();
  }

  async closeServer() {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server === null) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      // No share counts here: the port is reachable from the whole LAN, and
      // "how many one-shot links are live" is not something a stranger needs.
      response.end('dsh-portable\n');
      return;
    }

    const match = /^\/d\/([a-f0-9]{32})$/.exec(url.pathname);
    if (match === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }

    this.sweep();
    const share = this.shares.get(match[1]);
    if (share === undefined) {
      const status = this.retired.has(match[1]) ? 410 : 404;
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(status === 410 ? 'this share has expired or was already downloaded\n' : 'no such share\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    // Reserve the delivery slot *now*, in the same tick as the check.
    //
    // Checking `downloads >= downloadsMax` here and incrementing only on
    // 'finish' left the whole transfer as a window: two concurrent requests
    // both passed the check and both counted, so "at most N downloads" was
    // never actually enforced. The reservation is released on every exit
    // path; only a complete delivery converts it into a counted download.
    const inFlight = Number.isFinite(share.active) ? share.active : 0;
    if (share.downloads + inFlight >= share.downloadsMax) {
      response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('this share has already been downloaded\n');
      return;
    }
    share.active = inFlight + 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      share.active = Math.max(0, (share.active ?? 1) - 1);
    };

    // The file can disappear between share.add() and the download (the user
    // pressed Delete in the panel). Answer like an expired link instead of
    // letting the stat throw into a bare 500.
    const info = await stat(share.filePath).catch(() => null);
    if (info === null) {
      this.shares.delete(share.token);
      this.retire(share.token);
      release();
      void this.closeIfIdle();
      response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('the shared file is gone\n');
      return;
    }
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(share.displayName),
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };

    // Range support exists for the case that actually happens: a transfer over
    // flaky Wi-Fi that dies at 80% should resume, not restart.
    const range = parseRange(request.headers.range, info.size);
    if (range === 'invalid') {
      release();
      response.writeHead(416, { 'content-range': 'bytes */' + String(info.size) });
      response.end();
      return;
    }
    if (range !== null) {
      headers['content-range'] = 'bytes ' + String(range.start) + '-' + String(range.end) + '/' + String(info.size);
      headers['content-length'] = String(range.end - range.start + 1);
      response.writeHead(206, headers);
    } else {
      headers['content-length'] = String(info.size);
      response.writeHead(200, headers);
    }

    if (request.method === 'HEAD') {
      // A probe never spends a download, but it did hold a reservation.
      response.on('finish', release);
      response.on('close', release);
      response.end();
      return;
    }

    const stream = createReadStream(share.filePath, range === null ? undefined : { start: range.start, end: range.end });
    stream.on('error', () => {
      try {
        response.destroy();
      } catch {
        // already gone
      }
    });
    response.on('close', () => stream.destroy());
    // A resumed slice does not spend a download, or flaky Wi-Fi would cost the
    // recipient their only copy. But one request that covers the whole file
    // (start 0 through the last byte) is a complete delivery, no matter which
    // status code it used — otherwise `Range: bytes=0-` would download forever.
    const complete = range === null || (range.start === 0 && range.end === info.size - 1);
    // Count a download only when the response finished cleanly. A client that
    // hangs up mid-transfer has not received a package, and burning the single
    // download on that would be indistinguishable from a bug.
    response.on('finish', () => {
      // 'finish' means the bytes reached the socket; a client that hangs up
      // mid-transfer aborts the response and never emits it. Counting on the
      // source 'end' instead would read `writableFinished` before the pipe had
      // ended the response — always false, never counted.
      if (!complete) {
        release();
        return;
      }
      share.downloads += 1;
      share.lastDownloadAt = Date.now();
      release();
      if (share.downloads >= share.downloadsMax) {
        this.shares.delete(share.token);
        this.retire(share.token);
        void this.closeIfIdle();
      }
      this.notify();
    });
    // An aborted transfer frees the slot without counting anything, so a
    // recipient whose link died can retry instead of finding it consumed.
    response.on('close', release);
    stream.pipe(response);
  }

  /** Remember a token that is gone, with a bound so a long session cannot grow it. */
  retire(token) {
    this.retired.add(token);
    if (this.retired.size > 512) {
      const oldest = this.retired.values().next().value;
      this.retired.delete(oldest);
    }
  }

  notify() {
    try {
      this.onEvent?.({ type: 'change', shares: this.list() });
    } catch {
      // A failing listener must never break a transfer.
    }
  }
}

function clampTtl(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(24 * 60, Math.max(1, Math.round(minutes)));
}

/** RFC 6266 filename, with the non-ASCII form kept when it applies. */
function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

/**
 * Parse a single-range header.
 * @returns null (no range), {start,end}, or 'invalid'.
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || header === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start;
  let end;
  if (rawStart === '') {
    // suffix form: the last N bytes
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}
