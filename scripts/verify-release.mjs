#!/usr/bin/env node
/**
 * verify-release.mjs — 发布门禁。
 *
 * 检查项：
 *  1. package.json 必需字段与 dsh 清单（bundle.patch / client.platform）
 *  2. 发布文件是否齐全（README 双语、CHANGELOG、HANDOFF、PUBLISHING、LICENSE、bootstrap）
 *  3. 版本一致性：package.json ↔ CHANGELOG 最新标题 ↔ HANDOFF 版本行
 *  4. 语法：node --check index.js / lib/client.js，以及 import 冒烟
 *  5. 测试：node --test（--skip-tests 可跳过）
 *  6. 包内容：npm pack --dry-run --json，断言不含 test/scripts/_e2e/_tmp/真实凭据
 *
 * 用法: node scripts/verify-release.mjs [--skip-tests] [--quiet]
 * 退出码: 0 通过 / 1 不通过
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const skipTests = argv.includes('--skip-tests');
const quiet = argv.includes('--quiet');

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

if (pkg.type !== 'module') fail('package.json: type 必须是 module');
if (!pkg.main) fail('package.json: 缺 main');
if (!pkg.dsh || !pkg.dsh.bundle || pkg.dsh.bundle.patch !== './cordis.patch.yml') {
  fail('package.json: 缺 dsh.bundle.patch（市场要求，缺了无法 dsh plugin add）');
}
if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') {
  note('package.json: 未声明 dsh.client.platform=web —— 面板不会加载');
}
if (!pkg.exports || pkg.exports['.'] !== './index.js') fail('package.json: exports["."] 必须是 ./index.js');
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail('package.json: 声明了运行时依赖 ' + Object.keys(pkg.dependencies).join(', ') + '（本插件约定零依赖）');
}
if (!pkg.repository || !pkg.repository.url) fail('package.json: 缺 repository');
else if (!/wjf1/.test(pkg.repository.url)) note('package.json: repository 指向 ' + pkg.repository.url + '（本机 gh 账号是 wjf1）');

const required = [
  'index.js', 'cordis.patch.yml', 'lib/client.js', 'lib/archive.mjs', 'lib/installer.mjs',
  'lib/tar.mjs', 'lib/collect.mjs', 'lib/rewrite.mjs', 'lib/routes.mjs', 'lib/share.mjs', 'lib/tools.mjs',
  'bootstrap/bootstrap.mjs', 'bootstrap/install.ps1', 'bootstrap/install.sh',
  'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'HANDOFF.md', 'PUBLISHING.md', 'LICENSE',
];
for (const rel of required) {
  if (!existsSync(path.join(ROOT, rel))) fail('缺文件: ' + rel);
}

const changelog = existsSync(path.join(ROOT, 'CHANGELOG.md')) ? await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
const topHeading = (changelog.match(/^##\s+(\S+)\s+—/m) || [])[1];
if (!topHeading) fail('CHANGELOG.md: 找不到形如 "## 0.1.0 — 2026-10-18" 的最新标题');
else if (topHeading !== version) fail('版本不一致: package.json=' + version + '，CHANGELOG 最新=' + topHeading);

const handoff = existsSync(path.join(ROOT, 'HANDOFF.md')) ? await readFile(path.join(ROOT, 'HANDOFF.md'), 'utf8') : '';
const handoffVersion = (handoff.match(/版本\s+(\d+\.\d+\.\d+)/) || [])[1];
if (!handoffVersion) note('HANDOFF.md: 没找到 "版本 x.y.z" 行');
else if (handoffVersion !== version) fail('版本不一致: package.json=' + version + '，HANDOFF=' + handoffVersion);

for (const rel of ['README.md', 'README.zh-CN.md']) {
  const body = existsSync(path.join(ROOT, rel)) ? await readFile(path.join(ROOT, rel), 'utf8') : '';
  if (!body.includes('dsh.bundle')) note(rel + ': 未提到 dsh.bundle（可选）');
  if (/\b(TODO|FIXME|待补)\b/.test(body)) fail(rel + ': 含未完成的 TODO/FIXME 标记');
}

function run(command, commandArgs, options = {}) {
  // 只有 .cmd/.bat 才需要 shell：走 shell 会把参数里的引号弄丢（Windows 上尤其明显）。
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8', shell: needsShell, ...options });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

for (const rel of ['index.js', 'lib/client.js']) {
  if (!existsSync(path.join(ROOT, rel))) continue;
  const check = run(process.execPath, ['--check', rel]);
  if (check.status !== 0) fail('语法错误 ' + rel + ': ' + (check.stderr.trim().split('\n')[0] || 'node --check 失败'));
}

const smoke = run(process.execPath, ['-e', "import('./index.js').then(m => { if (typeof m.apply !== 'function') process.exit(1); })"]);
if (smoke.status !== 0) fail('import 冒烟失败: ' + (smoke.stderr.trim().split('\n')[0] || '非零退出'));

if (!skipTests) {
  const tests = run(process.execPath, ['--test']);
  const passed = (tests.stdout.match(/^# pass (\d+)/m) || [])[1];
  const failed = (tests.stdout.match(/^# fail (\d+)/m) || [])[1];
  if (tests.status !== 0) fail('测试未通过（pass=' + (passed || '?') + ' fail=' + (failed || '?') + '）');
  else note('测试: pass=' + (passed || '?'));
}

const pack = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json']);
if (pack.status !== 0) note('npm pack --dry-run 失败，跳过包内容检查: ' + (pack.stderr.trim().split('\n')[0] || ''));
else {
  try {
    const info = JSON.parse(pack.stdout);
    // npm 的 --json 输出是 { "<包名>": { id, files: [...] } }，不是数组。
    const entry = Array.isArray(info) ? info[0] : (info[pkg.name] || info);
    const packed = (entry.files || []).map((file) => file.path);
    note('包内文件: ' + packed.length + ' 个，' + Math.round((entry.size || 0) / 1024) + ' KB packed');
    const forbidden = packed.filter((file) => /^(test|scripts|_e2e|_tmp)/.test(file) || /\.credentials$|\.env$/.test(file));
    if (forbidden.length > 0) fail('包内含不该发布的文件: ' + forbidden.slice(0, 6).join(', '));
    for (const rel of ['index.js', 'cordis.patch.yml', 'lib/client.js', 'LICENSE']) {
      if (!packed.includes(rel)) fail('发布包漏了 ' + rel);
    }
  } catch (error) {
    note('无法解析 npm pack 输出: ' + error.message);
  }
}

if (!quiet) {
  console.log('dsh-portable ' + version + ' 发布检查');
  for (const line of notes) console.log('  · ' + line);
}
if (problems.length > 0) {
  for (const line of problems) console.error('  ✗ ' + line);
  console.error('\n发布检查未通过：' + problems.length + ' 项');
  process.exit(1);
}
console.log('发布检查通过（' + version + '）。');
