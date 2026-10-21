import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ShareServer, lanAddresses } from '../lib/share.mjs';

async function fixture(bytes = 'abcdefghij') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-portable-share-'));
  const filePath = path.join(dir, 'sample.dshpkg');
  await writeFile(filePath, bytes);
  return { dir, filePath };
}

test('a share serves the file once and then disappears', async () => {
  const { filePath } = await fixture('payload');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 1 });
    assert.equal(created.token.length, 32);
    assert.equal(share.list().length, 1);
    assert.ok(share.port > 0);

    const response = await fetch('http://127.0.0.1:' + share.port + '/d/' + created.token);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'payload');
    assert.match(response.headers.get('content-disposition'), /attachment/);

    // The count is settled on the response 'finish' event, which has fired by
    // the time the body has been fully read.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(share.list().length, 0);
    // A one-download share leaves nothing to serve, so the listener goes too:
    // no forgotten port stays open behind an exhausted link.
    assert.equal(share.running, false);
  } finally {
    await share.close();
  }
});

test('a range request is answered with 206 and the requested slice', async () => {
  const { filePath } = await fixture('0123456789');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 3 });
    const base = 'http://127.0.0.1:' + share.port + '/d/' + created.token;
    const response = await fetch(base, { headers: { range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '2345');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  } finally {
    await share.close();
  }
});

test('an expired share is refused with 410 while the server is still up', async () => {
  const { filePath } = await fixture('x');
  // The TTL is clamped to at least a minute so a caller cannot mint a link that
  // is already dead; expiry is therefore exercised by moving the deadline.
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 5 });
    const other = await share.add({ filePath, maxDownloads: 5 });
    const live = share.shares.get(created.token);
    live.expiresAt = Date.now() - 1;
    const response = await fetch('http://127.0.0.1:' + share.port + '/d/' + created.token);
    assert.equal(response.status, 410);
    // A second, live share keeps the server listening, which is what makes the
    // 410 observable at all.
    const still = await fetch('http://127.0.0.1:' + share.port + '/d/' + other.token);
    assert.equal(still.status, 200);
  } finally {
    await share.close();
  }
});

test('an unknown token is a 404, not a 500', async () => {
  const { filePath } = await fixture('x');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    await share.add({ filePath, maxDownloads: 1 });
    const response = await fetch('http://127.0.0.1:' + share.port + '/d/' + 'f'.repeat(32));
    assert.equal(response.status, 404);
  } finally {
    await share.close();
  }
});

test('removing a share closes the server when it was the last one', async () => {
  const { filePath } = await fixture('x');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 1 });
    assert.equal(share.remove(created.token), true);
    assert.equal(share.list().length, 0);
    assert.equal(share.remove(created.token), false);
  } finally {
    await share.close();
  }
});

test('the health endpoint does not disclose how many links are live', async () => {
  const { filePath } = await fixture('x');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    await share.add({ filePath, maxDownloads: 5 });
    const response = await fetch('http://127.0.0.1:' + share.port + '/health');
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.trim(), 'dsh-portable');
    // An unauthenticated caller must not learn how much is being shared.
    assert.doesNotMatch(text, /[0-9]/);
  } finally {
    await share.close();
  }
});

test('a full-range download counts against the limit', async () => {
  const { filePath } = await fixture('0123456789');
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 1 });
    const base = 'http://127.0.0.1:' + share.port + '/d/' + created.token;
    // Browsers resume with bytes=0-; that is a complete download and must be
    // counted, or a one-download link would serve forever.
    const first = await fetch(base, { headers: { range: 'bytes=0-' } });
    assert.equal(first.status, 206);
    assert.equal(await first.text(), '0123456789');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(share.list().length, 0);
    // The only link is spent, so the listener retires too: a retry cannot even
    // reach the token again.
    assert.equal(share.running, false);
  } finally {
    await share.close();
  }
});

test('lanAddresses never reports loopback or link-local addresses', () => {
  for (const address of lanAddresses()) {
    assert.ok(!address.address.startsWith('127.'), 'loopback leaked: ' + address.address);
    assert.ok(!address.address.startsWith('169.254.'), 'link-local leaked: ' + address.address);
  }
});

test('concurrent downloads cannot exceed downloadsMax', async () => {
  // 4 MB so both requests are still in flight when the second one arrives;
  // with a tiny file the first transfer could finish first and hide the race.
  const { filePath } = await fixture('z'.repeat(4 * 1024 * 1024));
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 1 });
    const url = 'http://127.0.0.1:' + share.port + '/d/' + created.token;

    // Fire both before either can settle: the slot must be reserved up front,
    // not counted on 'finish'.
    const [a, b] = await Promise.all([
      fetch(url).then(async (r) => ({ status: r.status, body: await r.arrayBuffer() })).catch((error) => ({ status: 'aborted', error })),
      fetch(url).then(async (r) => ({ status: r.status, body: await r.arrayBuffer() })).catch((error) => ({ status: 'aborted', error })),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one delivery: ' + JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 410).length, 1, 'the other must be refused: ' + JSON.stringify(statuses));

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(share.list().length, 0, 'share is retired after its single download');
  } finally {
    await share.close();
  }
});

test('an aborted transfer frees its reserved slot without spending a download', async () => {
  const { filePath } = await fixture('y'.repeat(2 * 1024 * 1024));
  const share = new ShareServer({ ttlMinutes: 5 });
  try {
    const created = await share.add({ filePath, maxDownloads: 1 });
    const url = 'http://127.0.0.1:' + share.port + '/d/' + created.token;

    // Abort mid-body: the client never received a package, so the link must
    // still work afterwards instead of reporting itself consumed.
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const retry = await fetch(url);
    assert.equal(retry.status, 200, 'an aborted download must not consume the share');
    await retry.arrayBuffer();
  } finally {
    await share.close();
  }
});
