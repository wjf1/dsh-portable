/**
 * dsh-portable — move a DeepSeek Harness profile between machines.
 *
 * One package file carries the profile's configuration, plugins, skills, hooks
 * and agent instructions. Import restores them on another machine, with the
 * recorded absolute paths rewritten for the new home.
 *
 * This file is the host half's entry point and does three things:
 *  1. own the plugin's directories and the two long-lived services (jobs, shares);
 *  2. register the HTTP routes the settings panel and the CLI drive;
 *  3. register the four model tools, so an agent can do the same without a panel.
 *
 * Nothing here reads a config file at load time. The panel edits the running
 * instance through the routes, and the first import on a machine is the one
 * thing that must never depend on configuration that is not there yet.
 */

import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JobManager } from './lib/jobs.mjs';
import { API_PREFIX, createRouter } from './lib/routes.mjs';
import { ShareServer } from './lib/share.mjs';
import { registerTools } from './lib/tools.mjs';

export const name = 'dsh-portable';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The plugin's own package version, read once. */
function pluginVersion() {
  try {
    const raw = readFileSync(path.join(here, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * DSH_HOME, resolved the way the host resolves it: the environment override
 * wins, the platform home follows. A relative override is resolved against the
 * working directory, matching the host rather than inventing a third rule.
 */
export function resolveDshHome(env = process.env, home = os.homedir()) {
  const raw = env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') {
    let expanded = raw.trim();
    if (expanded === '~') expanded = home;
    else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(home, expanded.slice(2));
    return path.isAbsolute(expanded) ? expanded : path.join(process.cwd(), expanded);
  }
  return path.join(home, '.dsh');
}

/** The profile this host actually booted, in order of authority. */
function resolveProfile(ctx, config) {
  const configured = typeof config?.profile === 'string' ? config.profile.trim() : '';
  if (configured !== '') return configured;
  const published = safeGet(ctx, 'profileContext');
  if (published !== null && typeof published.name === 'string' && published.name !== '') return published.name;
  const fromEnv = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : '';
  if (fromEnv !== '') return fromEnv;
  return 'desktop';
}

/** \`ctx.get\` is the sanctioned way to reach an optional service. */
function safeGet(ctx, key) {
  try {
    const get = ctx.get;
    return typeof get === 'function' ? get.call(ctx, key) : null;
  } catch {
    return null;
  }
}

export function apply(ctx, config) {
  const version = pluginVersion();
  const tool = { name, version };
  const settings = () => {
    // The host's profile context is the authority on where DSH home is (the
    // same order lib/paths.mjs uses); DSH_HOME covers headless tool runs and
    // ~/.dsh is the last resort. Keeping both files on one order matters:
    // the panel's meta line must name the directory the installer writes to.
    const published = safeGet(ctx, 'profileContext');
    const fromContext = published !== null && typeof published.dshHome === 'string' && published.dshHome.trim() !== ''
      ? path.resolve(published.dshHome)
      : null;
    const dshHome = fromContext ?? resolveDshHome();
    return { dshHome, profile: resolveProfile(ctx, config) };
  };

  const rootDir = path.join(settings().dshHome, 'dsh-portable');
  const store = {
    root: rootDir,
    dirs: { exports: path.join(rootDir, 'exports'), uploads: path.join(rootDir, 'uploads') },
  };

  const hostInfo = () => {
    const current = settings();
    return {
      version,
      profile: current.profile,
      dshHome: current.dshHome,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      storeRoot: store.root,
    };
  };

  /** What a package records about the machine it came from. */
  const source = (profileName) => ({
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    dshHome: settings().dshHome,
    profile: profileName,
    dshVersion: version,
  });

  const jobs = new JobManager({
    onChange: (job) => {
      // Progress is polled by the panel; nothing here needs a push channel, and
      // a listener that throws must not be able to fail an export.
      void job;
    },
  });

  const share = new ShareServer();

  // The directories are created lazily on first write, but a settings panel that
  // opens before any export would otherwise report an empty store with an error.
  void mkdir(store.dirs.exports, { recursive: true }).catch(() => {});
  void mkdir(store.dirs.uploads, { recursive: true }).catch(() => {});

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const handler = createRouter({ store, jobs, share, hostInfo, source, tool, hostContext: hostCtx });
      const dispose = hostCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    }, 'dsh-portable http routes');

    hostCtx.effect(() => {
      let stop = () => {};
      let cancelled = false;
      registerTools(hostCtx, { jobs, share, store, hostInfo, tool })
        .then((dispose) => {
          if (cancelled) {
            dispose();
            return;
          }
          stop = dispose;
        })
        .catch((error) => {
          // A host without the tool service, or one where the tools are not
          // ready yet, still gets a working panel. Losing the tools is a
          // degraded feature, not a broken plugin.
          log(hostCtx, 'warn', 'tool registration failed: ' + (error instanceof Error ? error.message : String(error)));
        });
      return () => {
        cancelled = true;
        try {
          stop();
        } catch {
          // Already gone.
        }
      };
    }, 'dsh-portable model tools');

    hostCtx.effect(() => () => {
      void jobs.dispose().catch(() => {});
      void share.close().catch(() => {});
    }, 'dsh-portable services');
  });
}

function log(ctx, level, message) {
  try {
    const logger = ctx.logger;
    if (logger !== null && typeof logger?.[level] === 'function') logger[level]('[dsh-portable] ' + message);
  } catch {
    // Logging must never be the reason a plugin fails to load.
  }
}
