import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writePackage } from '../lib/archive.mjs';
import { API_PREFIX, createRouter } from '../lib/routes.mjs';

/** A job manager that never runs anything: these tests are about the surface. */
function fakeJobs() {
  let counter = 0;
  return {
    busyJob: null,
    list: () => [],
    get: () => null,
    start(spec) {
      counter += 1;
      return { id: 'job-' + counter, kind: spec.kind, state: 'running', startedAt: Date.now(), progress: {}, args: spec.args };
    },
    cancel: () => false,
  };
}

async function harness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-portable-routes-'));
  const store = {
    dirs: { exports: path.join(home, 'dsh-portable', 'exports'), uploads: path.join(home, 'dsh-portable', 'uploads') },
  };
  await mkdir(store.dirs.exports, { recursive: true });
  await mkdir(store.dirs.uploads, { recursive: true });
  // A real profile, so a test can build a real package inside this home.
  await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"x"}\n');

  const jobs = fakeJobs();
  const submitted = [];
  const start = jobs.start;
  jobs.start = (spec) => {
    submitted.push(spec);
    return start(spec);
  };
  const share = {
    list: () => [],
    running: false,
    port: null,
    add: async (input) => ({ token: 'a'.repeat(32), urls: ['http://127.0.0.1:9/d/' + 'a'.repeat(32)], port: 9, displayName: input.displayName, remainingDownloads: 1, expiresAt: Date.now() + 60_000 }),
    remove: () => true,
  };
  const handler = createRouter({
    store,
    jobs,
    share,
    hostInfo: () => ({ version: '0.1.0', profile: 'desktop', dshHome: home, platform: process.platform }),
    source: () => ({ h: 1 }),
    tool: { name: 'dsh-portable', version: '0.1.0' },
    hostContext: { get: () => null },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + API_PREFIX;
  return {
    home,
    store,
    jobs,
    share,
    submitted,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Write a genuine package so routes that validate the archive have something real to read. */
async function writeRealPackage(home, outPath) {
  await writePackage({
    dshHome: home,
    profileName: 'desktop',
    options: {
      includeNodeModules: false,
      includeSessions: false,
      includeRuntimes: false,
      includeCredentials: false,
      includeSourceMaps: true,
      includeBackups: false,
    },
    outPath,
    tool: { name: 'dsh-portable', version: '0.0.0-test' },
    source: {
      hostname: 'h',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      dshHome: home,
      profile: 'desktop',
      dshVersion: '',
    },
  });
}

test('status reports the plugin and the host it lives on', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.plugin.name, 'dsh-portable');
    assert.equal(body.profile, 'desktop');
    assert.equal(body.busyJobId, null);
  } finally {
    await ctx.close();
  }
});

test('artifacts lists files, skipping partial writes', async () => {
  const ctx = await harness();
  try {
    await writeFile(path.join(ctx.store.dirs.exports, 'one.dshpkg'), 'x'.repeat(10));
    await writeFile(path.join(ctx.store.dirs.exports, 'two.dshpkg.part'), 'y'.repeat(10));
    await writeFile(path.join(ctx.store.dirs.uploads, 'three.dshpkg'), 'z'.repeat(5));
    const body = await (await fetch(ctx.base + '/artifacts')).json();
    const names = body.artifacts.map((row) => row.name).sort();
    assert.deepEqual(names, ['one.dshpkg', 'three.dshpkg']);
    const upload = body.artifacts.find((row) => row.name === 'three.dshpkg');
    assert.equal(upload.id, 'uploads:three.dshpkg');
    assert.equal(upload.size, 5);
  } finally {
    await ctx.close();
  }
});

test('an artifact id cannot escape its directory', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:../secrets.yaml' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'BAD_ARTIFACT');
  } finally {
    await ctx.close();
  }
});

test('import refuses to write without an explicit confirmation', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:one.dshpkg' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'CONFIRM_REQUIRED');
  } finally {
    await ctx.close();
  }
});

test('import accepts the same request once confirmed', async () => {
  const ctx = await harness();
  try {
    // /import pre-checks that the package is on disk, so the fixture must exist.
    await writeFile(path.join(ctx.store.dirs.exports, 'one.dshpkg'), 'not read by this route\n');
    const response = await fetch(ctx.base + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:one.dshpkg', confirm: true, mode: 'replace' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.job.kind, 'import');
  } finally {
    await ctx.close();
  }
});

test('a JSON body that is not an object is refused', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_JSON');
  } finally {
    await ctx.close();
  }
});

test('unknown routes answer 404 rather than falling through', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/no-such-thing');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NO_ROUTE');
  } finally {
    await ctx.close();
  }
});

test('export maps the option switches and names the artifact it will produce', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'trip', includeSessions: true }),
    });
    const body = await response.json();
    assert.equal(body.artifactId, 'exports:trip.dshpkg');
    assert.equal(body.job.kind, 'export');
    // The response carries the public job shape (no args); the options live in
    // what the route handed to the manager.
    const options = ctx.submitted.at(-1).args.options;
    assert.equal(options.includeNodeModules, true);
    assert.equal(options.includeSessions, true);
    assert.equal(options.includeCredentials, false);
    assert.equal(options.includeBackups, false);
  } finally {
    await ctx.close();
  }
});

test('upload streams a real package to disk and reports the same artifact id the list uses', async () => {
  const ctx = await harness();
  try {
    const source = path.join(ctx.home, 'upload-source.dshpkg');
    await writeRealPackage(ctx.home, source);
    const bytes = await readFile(source);
    const response = await fetch(ctx.base + '/upload/moved.dshpkg', {
      method: 'PUT',
      body: bytes,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.artifactId, 'uploads:moved.dshpkg');
    assert.equal(body.size, bytes.length);
    const listed = await (await fetch(ctx.base + '/artifacts')).json();
    assert.equal(listed.artifacts[0].name, 'moved.dshpkg');
  } finally {
    await ctx.close();
  }
});

test('a truncated upload is refused instead of landing in the store', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/upload/broken.dshpkg', {
      method: 'PUT',
      body: 'not-a-package',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_ARCHIVE');
    const listed = await (await fetch(ctx.base + '/artifacts')).json();
    assert.equal(listed.artifacts.find((row) => row.name === 'broken.dshpkg'), undefined);
  } finally {
    await ctx.close();
  }
});

test('an upload name with a separator is refused', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/upload/..%2Fescape.dshpkg', { method: 'PUT', body: 'x' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_UPLOAD_NAME');
  } finally {
    await ctx.close();
  }
});

test('a share request mints a link for a package that exists', async () => {
  const ctx = await harness();
  try {
    await writeFile(path.join(ctx.store.dirs.exports, 'trip.dshpkg'), 'x'.repeat(4));
    const body = await (await fetch(ctx.base + '/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:trip.dshpkg' }),
    })).json();
    assert.equal(body.share.remainingDownloads, 1);
    assert.equal(body.share.urls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('artifact metadata returns the manifest, not the reader wrapper', async () => {
  const ctx = await harness();
  try {
    await writePackage({
      dshHome: ctx.home,
      profileName: 'desktop',
      options: {
        includeNodeModules: false,
        includeSessions: false,
        includeRuntimes: false,
        includeCredentials: false,
        includeSourceMaps: true,
        includeBackups: false,
      },
      outPath: path.join(ctx.store.dirs.exports, 'real.dshpkg'),
      tool: { name: 'dsh-portable', version: '0.0.0-test' },
      source: {
        hostname: 'h',
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        dshHome: ctx.home,
        profile: 'desktop',
        dshVersion: '',
      },
    });
    const response = await fetch(ctx.base + '/artifacts/meta?artifactId=exports:real.dshpkg');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.manifest.format, 'dsh-portable/1');
    assert.equal(body.manifest.source.profile, 'desktop');
    assert.ok(Array.isArray(body.roots), 'roots must be a list of what the package carries');
    assert.equal(body.roots[0].id, 'profile');
  } finally {
    await ctx.close();
  }
});

test('download streams the package under a filename the browser can save', async () => {
  const ctx = await harness();
  try {
    const payload = 'DSHPKG-payload-' + 'x'.repeat(120);
    await writeFile(path.join(ctx.store.dirs.exports, 'trip.dshpkg'), payload);
    const response = await fetch(ctx.base + '/artifacts/download?artifactId=' + encodeURIComponent('exports:trip.dshpkg'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="trip\.dshpkg"$/);
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(payload)));
    assert.equal(await response.text(), payload);
  } finally {
    await ctx.close();
  }
});

test('download reports a missing package instead of answering with an empty file', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/artifacts/download?artifactId=exports:gone.dshpkg');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});

test('download refuses an artifact id that tries to leave the store', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/artifacts/download?artifactId=exports:..%2F..%2Fsecrets.yaml');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_ARTIFACT');
  } finally {
    await ctx.close();
  }
});

test('a backup restores over the live files and keeps what it replaced', async () => {
  const ctx = await harness();
  try {
    const live = path.join(ctx.home, 'profiles', 'desktop', 'cordis.patch.yml');
    const backupDir = path.join(ctx.home, 'portable-backups', '20261019-120000', 'profiles', 'desktop');
    await mkdir(backupDir, { recursive: true });
    await writeFile(live, 'live\n');
    await writeFile(path.join(backupDir, 'cordis.patch.yml'), 'from-backup\n');

    const response = await fetch(ctx.base + '/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stamp: '20261019-120000' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.restored, ['profiles/desktop/cordis.patch.yml']);
    assert.equal(await readFile(live, 'utf8'), 'from-backup\n');

    // What the restore overwrote is kept under its own stamp, one restore away.
    const preRoot = path.join(ctx.home, 'portable-backups');
    const pre = (await readdir(preRoot)).find((name) => name.endsWith('-pre-restore'));
    assert.notEqual(pre, undefined);
    assert.equal(await readFile(path.join(preRoot, pre, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'live\n');
  } finally {
    await ctx.close();
  }
});

test('restoring a backup that does not exist reports it', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stamp: '20200101-000000' }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});

test('a backup stamp cannot point outside the backup store', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stamp: '../profiles' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_STAMP');
  } finally {
    await ctx.close();
  }
});

test('deleting a package that is already gone answers 404', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/artifacts/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:gone.dshpkg' }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});

test('import refuses a package that is not on disk', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:missing.dshpkg', confirm: true }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});

test('download answers HEAD with the headers but no body', async () => {
  const ctx = await harness();
  try {
    const payload = 'HEAD-payload';
    await writeFile(path.join(ctx.store.dirs.exports, 'head.dshpkg'), payload);
    const response = await fetch(ctx.base + '/artifacts/download?artifactId=' + encodeURIComponent('exports:head.dshpkg'), {
      method: 'HEAD',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(payload)));
    assert.equal(await response.text(), '');
  } finally {
    await ctx.close();
  }
});

test('a busy job manager is a 409, not an internal error', async () => {
  const ctx = await harness();
  try {
    await writeFile(path.join(ctx.store.dirs.exports, 'busy.dshpkg'), 'anything\n');
    ctx.jobs.start = () => {
      const error = new Error('another job is running');
      error.code = 'JOB_BUSY';
      error.busyJobId = 'job-7';
      throw error;
    };
    const response = await fetch(ctx.base + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: 'exports:busy.dshpkg', confirm: true }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'JOB_BUSY');
    assert.equal(body.busyJobId, 'job-7');
  } finally {
    await ctx.close();
  }
});

test('removing a share that is gone answers 404', async () => {
  const ctx = await harness();
  try {
    ctx.share.remove = () => false;
    const response = await fetch(ctx.base + '/share/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'f'.repeat(32) }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});
