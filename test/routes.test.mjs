import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
    submitted,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
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

test('upload streams to disk and reports the same artifact id the list uses', async () => {
  const ctx = await harness();
  try {
    const response = await fetch(ctx.base + '/upload/moved.dshpkg', {
      method: 'PUT',
      body: 'payload-bytes',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.artifactId, 'uploads:moved.dshpkg');
    assert.equal(body.size, 13);
    const listed = await (await fetch(ctx.base + '/artifacts')).json();
    assert.equal(listed.artifacts[0].name, 'moved.dshpkg');
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
