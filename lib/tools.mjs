/**
 * dsh-portable — the four model tools.
 *
 * They exist so an agent can move a profile between machines without a human
 * clicking through a panel: export here, inspect what arrived, import it, and
 * hand it to another machine over the LAN.
 *
 * Every tool addresses packages by **artifactId** (\`exports:<name>\`), never by
 * a path. A tool that accepted a path would let a model read or overwrite any
 * file the DSH process can reach — export and import both write real files, so
 * that latitude is exactly what must not be granted.
 *
 * Long operations go through the same JobManager the browser uses. That keeps
 * the tools honest about progress and keeps a 1 GB count off the event loop.
 */

import os from 'node:os';
import path from 'node:path';

const JOB_POLL_MS = 250;

/**
 * Wrap a tool definition. \`defineTool\` is a typed identity helper in the host
 * package; when a deployment does not publish it, the plain object is what the
 * registry consumes anyway. Importing it statically would make this plugin fail
 * to load on any host that moved the package, for a wrapper that adds nothing.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    // Optional peer; the registry accepts the same shape.
  }
  return (spec) => spec;
}

function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function createTools({ jobs, share, store, hostInfo, tool }) {
  /** Resolve an artifactId to a path inside the plugin's own directories. */
  function artifactPath(artifactId) {
    if (typeof artifactId !== 'string' || artifactId === '') {
      throw new Error('artifactId is required (for example exports:dsh-portable-20261018-101500.dshpkg)');
    }
    const separator = artifactId.indexOf(':');
    if (separator <= 0) throw new Error('artifactId must look like exports:<name>');
    const kind = artifactId.slice(0, separator);
    const name = artifactId.slice(separator + 1);
    if (kind !== 'exports' && kind !== 'uploads') throw new Error('unknown artifact kind: ' + kind);
    if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('invalid artifact name');
    }
    return { filePath: path.join(store.dirs[kind], name), kind, name };
  }

  /** Wait for a job to settle, reporting the failure the job recorded. */
  async function awaitJob(job, { timeoutMs = 15 * 60_000 } = {}) {
    const started = Date.now();
    let current = job;
    while (current.state === 'running' || current.state === 'queued') {
      if (Date.now() - started > timeoutMs) {
        throw new Error('job ' + current.id + ' did not finish within ' + Math.round(timeoutMs / 1000) + 's');
      }
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
      const next = jobs.get(current.id);
      if (next === null) throw new Error('job ' + current.id + ' disappeared');
      current = next;
    }
    if (current.state === 'failed') {
      throw new Error('job failed: ' + (current.error?.message ?? 'unknown error'));
    }
    if (current.state === 'cancelled') throw new Error('job was cancelled');
    return current;
  }

  return {
    async exportPackage(args) {
      const info = hostInfo();
      const profileName = trimOrUndefined(args.profile) ?? info.profile;
      const baseName = trimOrUndefined(args.name) ?? 'dsh-portable-' + stampNow();
      const fileName = (baseName.endsWith('.dshpkg') ? baseName : baseName + '.dshpkg').replace(/[\\/:*?"<>|]/g, '_');
      const outPath = path.join(store.dirs.exports, fileName);
      const job = jobs.start({
        kind: 'export',
        args: {
          dshHome: info.dshHome,
          profileName,
          outPath,
          tool,
          source: {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            dshHome: info.dshHome,
            profile: profileName,
            dshVersion: info.version,
          },
          options: {
            includeNodeModules: args.includeNodeModules !== false,
            includeSessions: args.includeSessions === true,
            includeRuntimes: args.includeRuntimes === true,
            includeCredentials: args.includeCredentials === true,
            includeSourceMaps: args.includeSourceMaps !== false,
            includeBackups: args.includeBackups === true,
          },
        },
      });
      const done = await awaitJob(job);
      const result = done.result;
      return {
        ok: true,
        artifactId: 'exports:' + fileName,
        file: fileName,
        bytes: result.bytes,
        entries: result.entries,
        stats: result.manifest.stats,
        roots: result.manifest.roots.map((root) => ({ id: root.id, files: root.files, bytes: root.bytes })),
        options: result.manifest.options,
        warnings: result.manifest.warnings ?? [],
      };
    },

    async inspectPackage(args) {
      const target = artifactPath(args.artifactId);
      const job = jobs.start({ kind: 'inspect', args: { filePath: target.filePath } });
      const done = await awaitJob(job, { timeoutMs: 120_000 });
      const manifest = done.result;
      return {
        ok: true,
        artifactId: args.artifactId,
        file: target.name,
        manifest,
        roots: manifest.roots.map((root) => ({ id: root.id, logical: root.logical, files: root.files, bytes: root.bytes })),
        compatibility: compareEnvironments(manifest, hostInfo()),
      };
    },

    async importPackage(args) {
      const target = artifactPath(args.artifactId);
      const info = hostInfo();
      if (args.confirm !== true) {
        const job = jobs.start({
          kind: 'preview',
          args: { filePath: target.filePath, dshHome: info.dshHome, profileName: trimOrUndefined(args.profile) },
        });
        const done = await awaitJob(job, { timeoutMs: 5 * 60_000 });
        return { ok: true, dryRun: true, artifactId: args.artifactId, plan: done.result, next: 'call again with confirm:true to apply this plan' };
      }
      const job = jobs.start({
        kind: 'import',
        args: {
          filePath: target.filePath,
          dshHome: info.dshHome,
          profileName: trimOrUndefined(args.profile),
          mode: args.mode === 'replace' ? 'replace' : 'merge',
          keepBackups: Number.isFinite(args.keepBackups) ? args.keepBackups : 5,
        },
      });
      const done = await awaitJob(job);
      return { ok: true, dryRun: false, artifactId: args.artifactId, report: done.result };
    },

    async sharePackage(args) {
      const target = artifactPath(args.artifactId);
      const created = await share.add({
        filePath: target.filePath,
        displayName: target.name,
        maxDownloads: Number.isFinite(args.maxDownloads) ? Math.max(1, Math.trunc(args.maxDownloads)) : 1,
        ttlMinutes: Number.isFinite(args.ttlMinutes) ? args.ttlMinutes : undefined,
      });
      return {
        ok: true,
        artifactId: args.artifactId,
        token: created.token,
        urls: created.urls,
        port: created.port,
        expiresAt: created.expiresAt,
        remainingDownloads: created.remainingDownloads,
        note: created.urls.length === 0
          ? 'no LAN address was found; the other machine cannot reach this share until the network has a non-loopback IPv4 address'
          : 'the link works once, until it expires; the server stops on its own when it has no shares left',
      };
    },

    async listShares() {
      return { ok: true, running: share.running, port: share.port, shares: share.list() };
    },

    async stopShare(args) {
      if (typeof args.token === 'string' && args.token !== '') {
        return { ok: true, removed: share.remove(args.token) };
      }
      await share.close();
      return { ok: true, removed: 'all' };
    },
  };
}

/** Register the tools against the host's tool service; a no-op without one. */
export async function registerTools(ctx, deps) {
  const service = ctx.get('tools');
  if (service === null || service === undefined || typeof service.register !== 'function') {
    return () => {};
  }
  const defineTool = await loadDefineTool();
  const impl = createTools(deps);
  const disposers = [];

  const register = (spec) => {
    const result = service.register(defineTool(spec));
    if (typeof result === 'function') disposers.push(result);
  };

  register({
    name: 'portable_export',
    description: 'Package this machine profile into a single .dshpkg file that another machine can import offline. Includes the profile configuration, plugins, skills, hooks and agent instructions; node_modules is included by default so the package is self-contained. Returns an artifactId used by the other portable_* tools.',
    parameters: {
      profile: { type: 'string', description: 'Profile name to package; defaults to the profile this DSH host booted.' },
      name: { type: 'string', description: 'File name for the package (a .dshpkg suffix is added).' },
      includeNodeModules: { type: 'boolean', description: 'Bundle installed plugins (default true; without them the target must run a package install).' },
      includeSessions: { type: 'boolean', description: 'Include session logs (default false; they contain conversation text).' },
      includeRuntimes: { type: 'boolean', description: 'Include downloaded runtimes such as browser payloads (default false; usually large).' },
      includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml (default false; that file holds secrets).' },
      includeSourceMaps: { type: 'boolean', description: 'Include *.map files (default true; they make plugin stack traces readable).' },
      includeBackups: { type: 'boolean', description: 'Include *.bak backups next to configuration files (default false).' },
    },
    output: { schema: { type: 'json', description: 'The package id, size, entry count and per-root breakdown.' }, render: textRender },
    async execute(args) {
      return impl.exportPackage(args ?? {});
    },
  });

  register({
    name: 'portable_inspect',
    description: 'Read the manifest of a .dshpkg package without importing it: what it was made from, which roots it carries, how many files and bytes each holds, and whether its recorded paths still match this machine.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Package id, for example exports:dsh-portable-20261018-101500.dshpkg.' },
    },
    output: { schema: { type: 'json', description: 'The package manifest plus a compatibility summary.' }, render: textRender },
    async execute(args) {
      return impl.inspectPackage(args ?? {});
    },
  });

  register({
    name: 'portable_import',
    description: 'Import a .dshpkg package. Without confirm:true this only reports what would change (dry run, zero writes). With confirm:true it stages the package under the DSH home, rewrites recorded paths, backs up the configuration it is about to touch, then merges (default) or replaces the matching top-level items.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Package id, for example exports:dsh-portable-20261018-101500.dshpkg.' },
      confirm: { type: 'boolean', description: 'Set true to actually write. Omit for a dry run.' },
      profile: { type: 'string', description: 'Target profile name; defaults to the package own profile (renamed when this machine lacks it).' },
      mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge adds and overwrites files but never deletes (default); replace moves the existing top-level item aside first.' },
      keepBackups: { type: 'number', description: 'How many previous backups under the DSH home to keep (default 5).' },
    },
    output: { schema: { type: 'json', description: 'Either a dry-run plan or the install report.' }, render: textRender },
    async execute(args) {
      return impl.importPackage(args ?? {});
    },
  });

  register({
    name: 'portable_share',
    description: 'Serve a package to another machine on the local network over a one-shot HTTP link. The link works once, expires, and the server shuts itself down when no shares remain.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Package id to hand out.' },
      maxDownloads: { type: 'number', description: 'How many completed downloads are allowed (default 1).' },
      ttlMinutes: { type: 'number', description: 'How long the link stays valid (default 60, at most 1440).' },
    },
    output: { schema: { type: 'json', description: 'The LAN URLs, token and expiry.' }, render: textRender },
    async execute(args) {
      return impl.sharePackage(args ?? {});
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A tool that is already gone needs no second removal.
      }
    }
  };
}

function trimOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stampNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function compareEnvironments(manifest, info) {
  const origin = manifest.source ?? {};
  const notes = [];
  if (origin.dshHome !== undefined && origin.dshHome !== info.dshHome) {
    notes.push('the package was made on a different DSH home; recorded paths will be rewritten on import');
  }
  if (origin.platform !== undefined && origin.platform !== process.platform) {
    notes.push('the package was made on ' + origin.platform + '; file modes and symlinks may not survive intact');
  }
  if (origin.node !== undefined && origin.node !== process.version) {
    notes.push('the package was made under ' + origin.node + ', this host runs ' + process.version);
  }
  return { sameHome: origin.dshHome === info.dshHome, notes };
}
