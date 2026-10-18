/**
 * dsh-portable — job bookkeeping.
 *
 * A package operation outlives a single HTTP request: the browser gets a job id
 * immediately and polls for state. Jobs are kept in memory and expire after
 * \`jobTtlMinutes\`; the files they produce live outside the job table, so letting
 * a job record expire never deletes a package the user might still want.
 *
 * Only one heavy job runs at a time. Two concurrent 1 GB exports on the same
 * disk finish later than running them in sequence, and the second one makes the
 * progress bar of the first one meaningless.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker/job-worker.mjs', import.meta.url);

export const HEAVY_KINDS = new Set(['export', 'import', 'preview']);

export class JobManager {
  constructor({ jobTtlMinutes = 1440, onChange } = {}) {
    this.ttlMs = Math.max(1, Number(jobTtlMinutes) || 1440) * 60_000;
    this.onChange = onChange;
    this.jobs = new Map();
    this.workers = new Map();
  }

  /** True when a job of a heavy kind is already running. */
  get busyJob() {
    for (const job of this.jobs.values()) {
      if (HEAVY_KINDS.has(job.kind) && (job.state === 'running' || job.state === 'queued')) return job;
    }
    return null;
  }

  start({ kind, args }) {
    this.prune();
    if (HEAVY_KINDS.has(kind)) {
      const busy = this.busyJob;
      if (busy !== null) {
        const error = new Error('another package job is still running (' + busy.kind + ' ' + busy.id + ')');
        error.code = 'JOB_BUSY';
        error.busyJobId = busy.id;
        throw error;
      }
    }

    const id = randomUUID();
    const job = {
      id, kind,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      args: describeArgs(kind, args),
    };
    this.jobs.set(id, job);
    this.notify(job);

    let worker;
    try {
      worker = new Worker(WORKER_URL, { workerData: { jobId: id, kind, args } });
    } catch (error) {
      job.state = 'failed';
      job.error = { message: error.message };
      job.finishedAt = Date.now();
      this.notify(job);
      return job;
    }
    this.workers.set(id, worker);

    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        job.progress = message.progress;
        this.notify(job);
        return;
      }
      if (message?.type === 'done') {
        job.state = 'succeeded';
        job.result = message.result;
        job.finishedAt = Date.now();
        this.notify(job);
        return;
      }
      if (message?.type === 'error') {
        job.state = 'failed';
        job.error = { message: message.message, code: message.code, stack: message.stack };
        job.finishedAt = Date.now();
        this.notify(job);
      }
    });

    worker.on('error', (error) => {
      if (job.state === 'succeeded' || job.state === 'failed') return;
      job.state = 'failed';
      job.error = { message: error.message, stack: String(error.stack ?? '').split('\n').slice(0, 8).join('\n') };
      job.finishedAt = Date.now();
      this.notify(job);
    });

    worker.on('exit', (code) => {
      this.workers.delete(id);
      if (job.state === 'running' && code !== 0) {
        job.state = 'failed';
        job.error = { message: 'worker exited with code ' + code };
        job.finishedAt = Date.now();
        this.notify(job);
      }
    });

    return job;
  }

  get(id) {
    this.prune();
    return this.jobs.get(id) ?? null;
  }

  list() {
    this.prune();
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    const worker = this.workers.get(id);
    if (worker !== undefined) {
      worker.terminate().catch(() => {});
      this.workers.delete(id);
    }
    if (job.state === 'running') {
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      this.notify(job);
    }
    return true;
  }

  /** Drop finished jobs older than the TTL. */
  prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > this.ttlMs) {
        this.jobs.delete(id);
      }
    }
  }

  /** Terminate every worker; used when the plugin unloads. */
  dispose() {
    for (const worker of this.workers.values()) worker.terminate().catch(() => {});
    this.workers.clear();
  }

  notify(job) {
    try {
      this.onChange?.(job);
    } catch {
      // A failing listener must never break a job.
    }
  }
}

/** Keep only what the UI needs to describe a job, never the whole config. */
function describeArgs(kind, args) {
  if (kind === 'export') {
    return { dshHome: args.dshHome, profileName: args.profileName, outPath: path.basename(args.outPath ?? '') };
  }
  if (kind === 'import' || kind === 'preview') {
    return { filePath: args.filePath, profileName: args.profileName ?? null, mode: args.mode ?? null };
  }
  return { filePath: args.filePath };
}
