import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobManager } from '../lib/jobs.mjs';
import { createTools } from '../lib/tools.mjs';

const OPTIONS = {
  includeNodeModules: false,
  includeSessions: false,
  includeRuntimes: false,
  includeCredentials: false,
  includeSourceMaps: true,
  includeBackups: false,
};

const TOOL = { name: 'dsh-portable', version: '0.0.0-test' };

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dp-inspect-'));
  await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true });
  await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"x"}\n');
  await writeFile(path.join(home, 'AGENTS.md'), 'rules\n');
  return home;
}

function fakeShare() {
  return {
    list: () => [],
    running: false,
    port: null,
    add: async () => { throw new Error('not used'); },
    remove: () => false,
  };
}

/** Model tools resolve the same manifest the routes do: { manifest, raw }. */
test('inspectPackage unwraps the manifest of a real package', async () => {
  const home = await makeHome();
  const store = {
    dirs: {
      exports: path.join(home, 'dsh-portable', 'exports'),
      uploads: path.join(home, 'dsh-portable', 'uploads'),
    },
  };
  await mkdir(store.dirs.exports, { recursive: true });
  await mkdir(store.dirs.uploads, { recursive: true });
  const jobs = new JobManager({});
  const info = { version: '0.0.0-test', profile: 'desktop', dshHome: home, platform: process.platform };
  const impl = createTools({ jobs, share: fakeShare(), store, hostInfo: () => info, tool: TOOL });
  try {
    const exported = await impl.exportPackage({ name: 'unit', options: OPTIONS });
    assert.equal(exported.ok, true);
    assert.equal(exported.artifactId, 'exports:unit.dshpkg');

    const inspected = await impl.inspectPackage({ artifactId: 'exports:unit.dshpkg' });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.manifest.format, 'dsh-portable/1');
    assert.ok(Array.isArray(inspected.roots), 'roots must be a list, not the job wrapper');
    const ids = inspected.roots.map((row) => row.id);
    assert.ok(ids.includes('profile'), 'profile is the one required root');
    assert.ok(ids.includes('agentInstructions'));
    for (const row of inspected.roots) assert.equal(typeof row.files, 'number');
    const profile = inspected.roots.find((row) => row.id === 'profile');
    assert.equal(profile.files, 1);
    assert.equal(typeof inspected.compatibility, 'object');
  } finally {
    jobs.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
