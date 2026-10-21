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

// Cooperative cancellation. The host asks us to stop before it resorts to
// terminate(), so our own `finally` blocks get to clean up the staging
// directory. A hard kill skips them and leaks a copy of the package.
const abort = new AbortController();
parentPort.on('message', (message) => {
  if (message?.type === 'abort') abort.abort();
});
// A live 'message' listener is a ref'd handle: without unref the worker would
// never exit on its own once the work is done, so every cancel would sit out
// the host's full grace period and then be terminated anyway.
parentPort.unref();

// Only the import path creates staging, but reporting it costs nothing and
// gives the host a fallback it can delete if the abort above cannot finish.
function onStage(stageDir) {
  parentPort.postMessage({ type: 'staging', jobId, stageDir });
}

try {
  let result;
  if (kind === 'export') {
    result = await writePackage({ ...args, onProgress: report, signal: abort.signal });
  } else if (kind === 'preview') {
    result = await preview({ ...args, onProgress: report, signal: abort.signal });
  } else if (kind === 'import') {
    result = await install({ ...args, onProgress: report, signal: abort.signal, onStage });
  } else if (kind === 'inspect') {
    result = await readManifest(args.filePath);
  } else {
    throw new Error('unknown job kind: ' + kind);
  }
  parentPort.postMessage({ type: 'done', jobId, result });
} catch (error) {
  if (abort.signal.aborted) {
    // The host already marked this job cancelled; this message only matters
    // for a worker that outlived a host that stopped listening.
    parentPort.postMessage({ type: 'cancelled', jobId });
  } else {
    parentPort.postMessage({
      type: 'error',
      jobId,
      message: error?.message ?? String(error),
      code: error?.code,
      stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
    });
  }
}
