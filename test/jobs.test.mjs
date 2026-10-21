import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager } from '../lib/jobs.mjs';
import { writePackage } from '../lib/archive.mjs';
import { install } from '../lib/installer.mjs';

const OPTIONS = {
  includeNodeModules: true, includeSessions: false, includeRuntimes: false,
  includeCredentials: false, includeSourceMaps: true, includeBackups: false,
};

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-job-'));
  await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"x"}\n');
  await writeFile(path.join(home, 'AGENTS.md'), 'rules\n');
  return home;
}

function waitFor(job) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (job.state === 'succeeded') return resolve(job);
      if (job.state === 'failed' || job.state === 'cancelled') return reject(new Error('job ' + job.state + ': ' + JSON.stringify(job.error)));
      if (Date.now() - started > 30_000) return reject(new Error('job timed out'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('runs an export job in a worker and reports a result', async () => {
  const home = await makeHome();
  const out = path.join(home, 'exports', 'one.dshpkg');
  const manager = new JobManager({});
  try {
    const job = manager.start({
      kind: 'export',
      args: {
        dshHome: home, profileName: 'desktop', options: OPTIONS, outPath: out,
        tool: { name: 'dsh-portable', version: '0.0.0' },
        source: { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'desktop', dshVersion: '' },
      },
    });
    assert.equal(job.state, 'running');
    await waitFor(job);
    assert.ok(job.result.bytes > 0);
    await access(out);
  } finally {
    manager.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('refuses a second heavy job while one is running', async () => {
  const home = await makeHome();
  const manager = new JobManager({});
  try {
    const args = {
      dshHome: home, profileName: 'desktop', options: OPTIONS, outPath: path.join(home, 'exports', 'a.dshpkg'),
      tool: { name: 'dsh-portable', version: '0.0.0' },
      source: { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'desktop', dshVersion: '' },
    };
    const first = manager.start({ kind: 'export', args });
    assert.throws(() => manager.start({ kind: 'export', args }), /another package job is still running/);
    await waitFor(first);
  } finally {
    manager.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

async function makePackage(home, name = 'pkg.dshpkg') {
  const out = path.join(home, 'exports', name);
  await writePackage({
    dshHome: home,
    profileName: 'desktop',
    options: OPTIONS,
    outPath: out,
    tool: { name: 'dsh-portable', version: '0.0.0' },
    source: { hostname: 'h', platform: process.platform, arch: process.arch, node: process.version, dshHome: home, profile: 'desktop', dshVersion: '' },
  });
  return out;
}

/** Staging must be empty: a cancelled import may not leave a copy behind. */
async function assertNoStagingLeft(dshHome) {
  const stagingRoot = path.join(dshHome, 'portable-staging');
  let entries = [];
  try {
    entries = await readdir(stagingRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert.deepEqual(entries, [], 'staging left behind: ' + entries.join(', '));
}

/** Poll until the manager has no worker for the job, or the deadline passes. */
async function waitForWorkerGone(manager, id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!manager.workers.has(id)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('an aborted import removes its staging directory', async () => {
  const source = await makeHome();
  const packagePath = await makePackage(source);
  const target = await makeHome();
  try {
    const controller = new AbortController();
    // `onStage` fires once the staging path is known but before extraction
    // copies anything, so the abort is deterministic rather than a race.
    await assert.rejects(() => install({
      filePath: packagePath,
      dshHome: target,
      mode: 'merge',
      signal: controller.signal,
      onStage: () => controller.abort(),
    }));
    await assertNoStagingLeft(target);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('cancelling an import job does not leave staging behind', async () => {
  const source = await makeHome();
  // Enough files that extraction is still running when the cancel lands: a
  // tiny package could finish first and hide the leak.
  const bulk = path.join(source, 'profiles', 'desktop', 'node_modules', 'bulk');
  await mkdir(bulk, { recursive: true });
  for (let i = 0; i < 400; i += 1) {
    await writeFile(path.join(bulk, 'f' + i + '.js'), 'export const v = ' + i + ';\n');
  }
  const packagePath = await makePackage(source);
  const target = await makeHome();
  const manager = new JobManager({});
  try {
    const job = manager.start({
      kind: 'import',
      args: { filePath: packagePath, dshHome: target, mode: 'merge' },
    });

    // Cancel only once something is actually staged on disk, otherwise the
    // assertion below can pass by luck: terminating before extraction starts
    // leaves nothing to leak. Watching the directory (rather than the job's
    // reported stageDir) keeps this honest regardless of how the worker
    // communicates.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && job.state === 'running') {
      const staged = await readdir(path.join(target, 'portable-staging')).catch(() => []);
      if (staged.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    manager.cancel(job.id);
    assert.equal(job.state, 'cancelled');

    // Cancellation settles in the background; wait for the worker to go away
    // before checking the disk, otherwise the assertion races the cleanup.
    await waitForWorkerGone(manager, job.id);
    await assertNoStagingLeft(target);
    // A cancelled job never turns back into a finished one.
    assert.equal(job.state, 'cancelled');
  } finally {
    manager.dispose();
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
