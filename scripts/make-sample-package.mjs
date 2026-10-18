import { createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { TarWriter } from '../lib/tar.mjs';

const target = process.argv[2];
const pass = new PassThrough();
const writing = pipeline(pass, createGzip({ level: 6 }), createWriteStream(target));

const writer = new TarWriter(async (chunk) => {
  if (!pass.write(chunk)) await new Promise((resolve) => pass.once('drain', resolve));
});

await writer.addDirectory('profiles/desktop');
await writer.addDirectory('profiles/desktop/node_modules');
await writer.addDirectory('profiles/desktop/node_modules/deep');

const small = Buffer.from('hello 中文世界\n', 'utf8');
await writer.addFile('profiles/desktop/README.md', small.length, (async function* () { yield small; })());

const big = Buffer.alloc(1500, 0x61);
await writer.addFile('profiles/desktop/node_modules/deep/big.bin', big.length, (async function* () { yield big; })());

await writer.addSymlink('profiles/desktop/node_modules/linked', '../target');

const longName = 'z'.repeat(130) + '.txt';
const longBody = Buffer.from('long\n', 'utf8');
await writer.addFile('profiles/desktop/' + longName, longBody.length, (async function* () { yield longBody; })());

const deepPath = 'a-very-long-directory-segment/'.repeat(6) + 'leaf.txt';
const deepBody = Buffer.from('deep\n', 'utf8');
await writer.addFile('profiles/desktop/' + deepPath, deepBody.length, (async function* () { yield deepBody; })());

await writer.end();
pass.end();
await writing;
console.log('wrote', target, writer.bytesWritten, 'tar bytes');