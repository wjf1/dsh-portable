/**
 * dsh-portable — the package manifest.
 *
 * The manifest is the first entry of every .dshpkg file, so inspecting a package
 * costs one gzip read of a few kilobytes instead of a full scan of a
 * multi-hundred-megabyte archive.
 *
 * It records what was taken, from where, under which options, and how much of it
 * there is. It deliberately does not record the source machine's absolute paths
 * for individual files: those exist only as \`source.dshHome\` metadata, which the
 * importer rewrites rather than trusts.
 */

export const FORMAT = 'dsh-portable/1';
export const FORMAT_NAME = 'dsh-portable';
export const MANIFEST_PATH = '.dsh-portable/manifest.json';

/**
 * @typedef {object} Manifest
 * @property {string} format
 * @property {string} createdAt ISO timestamp
 * @property {{name: string, version: string}} tool
 * @property {{hostname: string, platform: string, arch: string, node: string, dshHome: string, profile: string, dshVersion: string}} source
 * @property {Record<string, unknown>} options
 * @property {{entries: number, files: number, dirs: number, links: number, bytes: number}} stats
 * @property {{id: string, logical: string, files: number, bytes: number}[]} roots
 */

export function buildManifest({ tool, source, options, stats, roots, createdAt }) {
  const perRoot = roots.map((root) => {
    const bytes = stats.byRoot?.[root.id] ?? 0;
    const files = stats.filesByRoot?.[root.id] ?? 0;
    return { id: root.id, logical: root.logical, files, bytes };
  });
  return {
    format: FORMAT,
    createdAt: createdAt ?? new Date().toISOString(),
    tool,
    source,
    options,
    stats: {
      entries: stats.entries, files: stats.files, dirs: stats.dirs, links: stats.links, bytes: stats.bytes,
    },
    roots: perRoot,
  };
}

/** Throws a readable error when the JSON is not a manifest this plugin understands. */
export function parseManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('manifest is not valid JSON: ' + error.message);
  }
  if (value === null || typeof value !== 'object') throw new Error('manifest is not an object');
  if (value.format !== FORMAT) {
    throw new Error('unsupported package format: ' + String(value.format) + ' (this plugin reads ' + FORMAT + ')');
  }
  if (value.stats === undefined || typeof value.stats.bytes !== 'number') {
    throw new Error('manifest is missing stats');
  }
  return value;
}

/** A short, human-readable one-liner for logs and the UI. */
export function describeManifest(manifest) {
  const bytes = manifest.stats?.bytes ?? 0;
  const files = manifest.stats?.files ?? 0;
  const roots = (manifest.roots ?? []).map((root) => root.id).join(', ');
  return files + ' files / ' + formatBytesShort(bytes) + ' from ' + (roots.length > 0 ? roots : 'nothing');
}

export function formatBytesShort(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + units[unit];
}
