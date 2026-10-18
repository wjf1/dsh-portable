#!/usr/bin/env node
/**
 * sync-profile.mjs — 把当前工作区拷进某个 profile 已安装的 dsh-portable 目录。
 *
 * 用途：真机联调。DSH 的插件目录是 <DSH_HOME>/profiles/<p>/node_modules/<包名>，
 * 改完源码不必重新 npm publish / dsh plugin add，直接同步过去、重启宿主即可。
 *
 * 用法：
 *   node scripts/sync-profile.mjs [--profile desktop] [--home C:\Users\x\.dsh] [--dry-run]
 *
 * 只做两件事：确认目标目录已存在（即插件已装过），然后把发布用的文件复制过去。
 * 它**不会**替用户修改 cordis.patch.yml —— 插件注册由 `dsh plugin add` 负责。
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { profile: null, home: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '-p') out.profile = argv[++i];
    else if (arg === '--home') out.home = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-')) out.profile = out.profile ?? arg;
  }
  return out;
}

function resolveHome(explicit) {
  const raw = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~' + path.sep) || raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node scripts/sync-profile.mjs [--profile desktop] [--home <DSH_HOME>] [--dry-run]');
  process.exit(0);
}

const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const pkgName = manifest.name;
const profile = args.profile || process.env.DSH_PROFILE || 'desktop';
const home = resolveHome(args.home);
const target = path.join(home, 'profiles', profile, 'node_modules', pkgName);

if (!existsSync(path.join(home, 'profiles'))) {
  console.error('找不到 DSH 主目录: ' + home + '（用 --home 指定，或先设置 DSH_HOME）');
  process.exit(1);
}
if (!existsSync(target)) {
  console.error('目标目录不存在: ' + target);
  console.error('插件还没装进这个 profile。先执行:');
  console.error('  dsh plugin --profile ' + profile + ' add "' + ROOT + '"');
  process.exit(1);
}

const SKIP = new Set(['node_modules', '.git', 'test', 'scripts', '_e2e', '_tmp']);
const destRoots = ['index.js', 'cordis.patch.yml', 'package.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'HANDOFF.md', 'PUBLISHING.md', 'LICENSE'];

async function listTree(from, rel) {
  const entries = await readdir(from, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(from, entry.name);
    const relPath = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await listTree(abs, relPath));
    else if (entry.isFile()) files.push(relPath);
  }
  return files;
}

const files = [];
for (const item of destRoots) {
  const abs = path.join(ROOT, item);
  if (!existsSync(abs)) continue;
  const info = await stat(abs);
  if (info.isDirectory()) files.push(...await listTree(abs, item));
  else files.push(item);
}
files.push(...await listTree(path.join(ROOT, 'lib'), 'lib'));
files.push(...await listTree(path.join(ROOT, 'bootstrap'), 'bootstrap'));

const unique = [...new Set(files)].sort();
console.log('源: ' + ROOT);
console.log('目标: ' + target);
console.log('文件: ' + unique.length + ' 个' + (args.dryRun ? '（dry-run，不写盘）' : ''));

if (!args.dryRun) {
  await mkdir(target, { recursive: true });
  for (const rel of unique) {
    const src = path.join(ROOT, rel);
    const dst = path.join(target, rel);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst);
  }
  const installed = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  installed.version = manifest.version;
  await writeFile(path.join(target, 'package.json'), JSON.stringify(installed, null, 2) + '\n', 'utf8');
}

for (const rel of unique.slice(0, 8)) console.log('  ' + rel);
if (unique.length > 8) console.log('  … 其余 ' + (unique.length - 8) + ' 个');
console.log(args.dryRun ? 'dry-run 结束。' : '同步完成。重启 DSH（或重载插件）后生效。');
