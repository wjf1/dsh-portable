# AGENTS.md

本文件为 AI 代理（ZCode / Claude Code 等）提供本项目级上下文。接手任务前先通读，再读 `HANDOFF.md` 了解最新进展与完整避坑清单。

## 项目概览

DeepSeek Harness（DSH）配置导入导出迁移工具：把整个 DSH home（profile、插件含 node_modules、skills、hooks、AGENTS.md、任务看板）打成单个 `.dshpkg`，在另一台机器经文件 / URL / 一次性局域网分享恢复，目标机无需网络与 pnpm install。同时是 DSH bundle 插件（带 web 面板）。

- 包名 `dsh-portable`，当前版本 **0.1.11**（2026-11-08，口令加密 / 子路径选择器 / 断点续传批次）。
- 技术栈：纯 Node ESM（`lib/*.mjs` + `index.js`），**零第三方运行时依赖**（加密用内置 AES-256-GCM + scrypt）；Node `^22.15.0 || >=24.0.0`，engines 另要求 `dsh >= 0.1.7-rc.2`。
- 关键目录：`lib/archive.mjs`（tar/gzip 流式打包，manifest 永远是首条目）、`lib/installer.mjs`（恢复与 replace 语义）、`lib/jobs.mjs` + `lib/worker/`（worker_threads 后台任务）、`lib/crypto.mjs`（加密容器）、`lib/routes.mjs`（面板 API）、`lib/client.js`（web 面板）、`bootstrap/`（无 DSH 环境引导）、`scripts/verify-release.mjs`（发布校验）。
- 有 Windows exe 构建产物线（离线迁移套件，见 HANDOFF 4.1）。
- 面板挂载路径：宿主内路由为 `/dsh-portable/api/*`；宿主对已注册路由统一回 403（未登录），未注册路径回 404——404 变 403 即「路由已挂载」的证据，想拿 200 需带登录 cookie。
- 分享下载 TTL：`clampTtl` 下限 1 分钟，测试用小 TTL 无效，需白盒改 `share.shares.get(token).expiresAt`。

## 构建与测试命令

均已在 `package.json` scripts 与 `.github/workflows/{ci,release}.yml` 中验证真实存在：

```bash
npm test                                    # node --test（测试入口，89 项）
npm run check                               # node --check index.js && node --check lib/client.js && node -e "import('./index.js')"
node scripts/verify-release.mjs --skip-tests  # CI 发布检查（CHANGELOG 顶段版本 == package.json）
node scripts/sync-profile.mjs               # 同步 profile（npm run sync）
```

- CI（ci.yml）：Node 22 / 24 双矩阵，check → `node --test` → `verify-release.mjs --skip-tests`。
- release.yml：`v*` tag 触发，先测试与发布检查，再 npm publish（Node 22）。
- 发布关键命令：打 annotated tag `vX.Y.Z` → push tags → release.yml 自动 npm publish + 建 Release。

## 代码风格约定

- 缩进 2 空格，单引号，**语句末尾加分号**（注意：与 dsh-commandcode 的无分号风格不同，勿混淆）。
- 文件头 JSDoc 块注释讲模块职责与不变量（见 `lib/archive.mjs` 头部）；常量 UPPER_SNAKE_CASE 并配一行说明。
- 一律流式处理：大文件不整读进内存；所有 fs 调用过 `longPath()`（加 `\\?\` 前缀）兼容 Windows 长路径。
- 测试为 `node:test` 风格的 `*.test.mjs`；新功能必须附回归测试（本仓 0.1.11 的五个修复全部带测试）。
- 错误处理口径：文件系统拒绝的条目不算致命（降级 warning 继续），结构损坏才是错误。
- 流式坑位约定：`pipe` 不转发 source 的 error（须显式 `gunzip.destroy(error)`）；`source.on('end')` 里 `response.writableFinished` 恒为 false，用 `response.on('finish')`。
- 回调里读 state 防闭包旧值：用 `setSelected((current) => ...)` 函数式更新取当前值，别捕获 render 时刻的变量。
- `String.raw` 模板里的正则：字符类中 `{` 紧跟 `$` 会被模板插值解析报错，花括号挪到字符类末尾；`worker_threads` 必须显式 `import { Worker }`。

## 提交与发布规范

- 提交信息 Conventional Commits + 中文描述：`feat: ...`、`fix: ...`、`docs: ...`、`chore(release): v0.1.11 定版——<摘要>`、`docs(handoff): ...`。
- 变更写 `CHANGELOG.md`（`X.Y.Z — 日期`，中文「新增/修复」分类）；四文档（package.json / CHANGELOG / README 双语 / HANDOFF）同分支同步。
- 发布：测试通过 → 四文档齐备且版本一致 → `git tag -a vX.Y.Z -m "vX.Y.Z: 中文摘要"` → push tags → release.yml 自动发布；GitHub Release 标题 `vX.Y.Z: 中文摘要`。
- npm 发布需 bypass-2FA 的 granular token（普通 token 报 403）；发布输出重定向到文件再看（`| Select-Object -First N` 会杀掉 npm 进程）。

## 项目专属注意

1. **`node --test` 不要写成 `node --test test/`**——直接裸跑即可，带目录参数行为不同。
2. **本仓库 git push 必须绕过本机代理**：全局 `http.proxy=127.0.0.1:7900` 会让 GitHub 握手失败（schannel SSL 错误），仓库内已设 `http.proxy=""` 本地覆盖，不要再配代理；npm registry 同理直连。
3. **CHANGELOG 顶段版本必须等于 package.json**：`verify-release.mjs` 强制比对，纯文档提交写了「未发布」而没动版本号，CI 直接红（0.1.4 踩过）；改完文档先本地跑一次该脚本再 push。
4. **「文档宣称」的功能要用调用链验证**：`mergeProfilePackage` 在 lib 里躺了 8 个版本、HANDOFF 写了、install 从未调用——审计用「函数名 grep + 调用点 grep + 测试 grep」三查，别只看函数存在。
5. **后台任务终态是 `succeeded` 而非 `done`**，`failed` / `cancelled` 是另外两个终态；前端 `follow` 轮询必须认 `succeeded`，否则面板按钮永久禁用（0.1.0–0.1.5 都错在这里）。
