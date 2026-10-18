/**
 * dsh-portable — the worker that does the heavy work.
 *
 * Packaging a profile reads a gigabyte of node_modules; importing writes it.
 * Both would stall the editor's event loop (and the Web GUI with it) if they ran
 * on the host thread, so every long operation happens here and reports progress
 * back by message.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { writePackage, readManifest } from '../archive.mjs';
import { preview, install } from '../installer.mjs';

const { jobId, kind, args } = workerData;

function report(progress) {
  parentPort.postMessage({ type: 'progress', jobId, progress });
}

try {
  let result;
  if (kind === 'export') {
    result = await writePackage({ ...args, onProgress: report });
  } else if (kind === 'preview') {
    result = await preview({ ...args, onProgress: report });
  } else if (kind === 'import') {
    result = await install({ ...args, onProgress: report });
  } else if (kind === 'inspect') {
    result = await readManifest(args.filePath);
  } else {
    throw new Error('unknown job kind: ' + kind);
  }
  parentPort.postMessage({ type: 'done', jobId, result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    jobId,
    message: error?.message ?? String(error),
    code: error?.code,
    stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
  });
}
