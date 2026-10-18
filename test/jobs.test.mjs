import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobManager } from '../lib/jobs.mjs';

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
