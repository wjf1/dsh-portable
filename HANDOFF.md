# HANDOFF — dsh-portable 接力开发文档

> 新会话接手：先读本文件，再读 `README.md`（行为契约）与 `CHANGELOG.md`（当前版本做了什么），最后才看代码。
> 最后更新：2026-10-18 · 版本 0.1.0

---

## 1. 项目概况与当前状态

**它是什么**：DeepSeek Harness（DSH）插件。把一台机器上正在工作的 DSH 主目录按白名单打包成单个 `.dshpkg`（gzip tar，manifest 为首条目），在另一台机器上预览、合并或替换式还原；支持文件拷贝、HTTP 上传、一次性局域网分享三种传输方式。

**解决的问题**：DSH 的 profile 是"配置 + 带 node_modules 的插件 + 技能 + hooks + 任务板"的集合，且配置里写死本机绝对路径与 profile 名。换机时直接复制目录会导致插件路径失效，而插件安装依赖联网 pnpm，在内网机上根本不可行。

**当前状态（0.1.0，可交付）**：

| 维度 | 状态 |
| --- | --- |
| 功能完整度 | 导出 / 预览 / 导入（merge、replace）/ 上传 / 局域网分享 / 备份 / 四个模型工具 / 设置页面板 —— 全部落地 |
| 测试 | `npm test` 40 项全绿（tar 11、archive 5、installer 5、jobs 2、routes 11、share 6） |
| 真实数据验证 | 对本机 `C:\\Users\\admin\\.dsh` 真导出：20 664 511 字节 / 13 774 条目 / 2.8 秒；再对临时 home 真安装：9 个顶层项全部落地、13491 文件、3 个文件 3 处路径被重写 |
| 发布状态 | **未发布**：仓库尚未 `git init`，未建 GitHub 仓库，未 `npm publish`，未进市场清单 |
| 上架路径 | npm 发包 + 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交条目（见 `PUBLISHING.md`） |

## 2. 技术栈与运行基线

- **运行时**：Node `^22.15.0 || >= 24.0.0`（本机 `C:\\Users\\admin\\AppData\\Local\\hermes\\node\\node.exe` v22.23.2）；DSH `>= 0.1.7-rc.2`。
- **依赖**：**零运行时依赖**。只 import Node 内置模块（`node:fs`、`node:zlib`、`node:http`、`node:worker_threads`、`node:crypto`、`node:os`、`node:path`、`node:stream/promises`），客户端半边只 `require('react')`。
- **没有构建步骤**：`index.js` / `lib/client.js` / `lib/*.mjs` 都是发布即运行的源码。改完直接 `npm run check` + `npm test`。
- **测试框架**：`node --test`（Node 内置）。脚本必须是 `node --test`，写成 `node --test test/` 在 Node 22 会报 `Cannot find module ...\\test`。
- **压缩**：`node:zlib` `createGzip({level:6})`；tar 读写自实现（`lib/tar.mjs`），与系统 `tar` 双向互通。

## 3. 核心架构与文件拓扑

```text
dsh-portable/
├─ index.js                 宿主端入口：export name / resolveDshHome / resolveProfile / apply
├─ cordis.patch.yml         插件注册补丁（- insert: id=dsh-portable, name=dsh-portable）
├─ package.json             dsh.bundle.patch 指向补丁；dsh.client.platform=web
├─ lib/
│  ├─ collect.mjs           白名单采集：sourceRoots + collectEntries（async generator）
│  ├─ tar.mjs               tar 读写：PAX 长路径、增量 pad、hdr/body 状态机
│  ├─ archive.mjs           writePackage（.part+rename 原子写）/ readManifest / extractPackage
│  ├─ rewrite.mjs           6 个配置文件的路径重写 + package.json 合并
│  ├─ installer.mjs         preview（dry-run）/ install（暂存→重写→备份→落地→清理）
│  ├─ jobs.mjs              JobManager + worker_threads 调度，HEAVY_KINDS 串行化
│  ├─ worker/job-worker.mjs 导出/预览/导入/inspect 的 worker 实现
│  ├─ routes.mjs            /dsh-portable/api 路由表、鉴权、上传流
│  ├─ share.mjs             ShareServer：一次性下载链接、TTL、410/404、Range
│  ├─ tools.mjs             四个模型工具（portable_export/inspect/import/share）
│  ├─ client.js             浏览器端 bundle（无构建，React.createElement + 原生 DOM）
│  └─ manifest.mjs          格式常量、buildManifest、parseManifest、describeManifest
├─ bootstrap/               无宿主引导安装：bootstrap.mjs + install.ps1 + install.sh
├─ scripts/                 sync-profile.mjs（真机联调拷贝）、verify-release.mjs（发布门禁）
├─ market/                  上架材料：data/plugins/wjf1__dsh-portable.yml（PR 用条目）+ PR.md（PR 正文）
├─ .github/workflows/       ci.yml（Node 22/24 矩阵）、release.yml（tag → 测试 → npm publish → Release）
└─ test/                    tar / archive / installer / jobs / routes / share
```

**数据流**：面板 / 模型工具 → `routes.mjs` 或 `tools.mjs` → `JobManager.start()` → worker → `archive.mjs` 或 `installer.mjs` → 进度 `postMessage` 回主线程 → 面板轮询 `/jobs/detail`。

**关键约定**：

- 所有"哪个包"的参数是 `artifactId`（`exports:<文件名>`），**绝不接受文件路径**。
- 存储目录：`<DSH_HOME>/dsh-portable/{exports,uploads}`、`<DSH_HOME>/portable-staging/<stamp>`、`<DSH_HOME>/portable-backups/<stamp>`。
- 配置解析顺序：`config.profile` → `ctx.get('profileContext').name` → `DSH_PROFILE` → `desktop`。
- 对外服务一律 `ctx.get('svc')`，未在 `inject` 里声明的属性直接访问会抛。

## 4. 最近一轮变更与交付成果（0.1.0）

新增：打包格式与 manifest、白名单采集、两级体积开关、两阶段导入、merge/replace、安装前备份、路径重写与 package.json 合并、profile 改名、worker 后台任务、16 个 HTTP 端点、设置页六卡片面板、四个模型工具、一次性局域网分享、无宿主 bootstrap CLI、40 项测试。

修复（都是实现期真实撞到的）：

- **tar 在 PAX 长路径后错位**：PAX 正文长度非 512 整数倍时未跳 padding，其后条目头全错，报 `tar header checksum mismatch`。修法：pad 增量消费 + `parsePax` 按长度前缀逐条解析。
- **打包中文件变短**：改补零 + warning，不再中断。
- **未处理的 `ERR_STREAM_PREMATURE_CLOSE`** 掩盖真实导出错误：`finished.catch(() => {})` + 重写消息。
- **打开失败即写坏 header**：先开句柄再写头。
- **分享下载计数不生效**（`writableFinished` 在 `end` 里恒 false）：改挂 `finish`，且 206 不计数。
- **过期 token 的 410/404 语义**：加 `retired` 集合。

验证：真实 DSH_HOME 导出 + 临时 home 安装全链路通过（数字见第 1 节表格）。

## 5. 待办与下一步

按优先级：

1. **发布进度**：仓库已建并推送（<https://github.com/wjf1/dsh-portable>，main，topic：dsh-plugin / deepseek-harness / migration / backup）。**剩余阻塞 = npm 登录**：本机无任何 npm 凭据（`~/.npmrc` 只有 `prefix=E:\OpenCode`，无 token、无环境变量），`npm publish` 报 `ENEEDAUTH`。需人工执行 `npm login`（或提供 automation token 写进 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken`）才能发布；包名 `dsh-portable` 在 npm 上仍是空闲（404）。发布后再推 `v0.1.0` tag 并提市场 PR（条目文件已备好在 `market/`）。
2. **截图**：`README` 目前没有界面截图（本机浏览器工具不可用，无法自动截图）。上架前应人工截 3 张：导出卡片、导入预览、分享链接。
3. **性能**：`skills-disabled` 在本机占 44.6 MB（整包 86%）。可考虑"默认排除已被禁用技能"的开关。
4. **加密**：当前包是明文 tar。凭据入包时应支持口令加密（AES-256-GCM + scrypt）。
5. **单文件选择器**：v0.1.0 只能按顶层根整体导入，后续可支持勾选具体子路径。
6. **e2e 测试**：目前 installer 用临时目录 + fixture，缺"真实 profile 装完能被 DSH 启动"的验证。

## 6. 关键避坑与运行约束

- **`node --test`**：不要写 `node --test test/`。
- **`String.raw` 里的正则**：字符类中 `{` 紧跟 `$` 会被模板插值解析成 `Expression expected`，把花括号挪到字符类末尾。
- **`worker_threads`**：只用 `new Worker(url)` 会报 `Worker is not defined`，必须先 `import { Worker } from 'node:worker_threads'`。
- **HTTP 下载计数**：`source.on('end')` 里 `response.writableFinished` 恒为 false，用 `response.on('finish')`。
- **分享 TTL**：`clampTtl` 下限 1 分钟，测试用过小 TTL 无效，要白盒改 `share.shares.get(token).expiresAt`。
- **Windows 长路径**：所有 fs 调用都过 `longPath()`（加 `\\?\` 前缀），否则深层 node_modules 会 `ENOENT`。
- **符号链接**：Windows 无开发者模式时创建失败，必须降级为 warning，不能中断导入。
- **真实 DSH 目录**：`app.asar` 是**文件**不是目录，PowerShell 无法进入；要读源码得用 `npx asar extract` 或直接看 `resources/app.asar.unpacked`。
- **市场是策展清单**：`dshmarket` 从 `https://awesome-dsh-plugin.com/plugins.json` 读目录，条目来自 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin`；上架是提 PR，不是自己上传。环境变量 `DSHM_REGISTRY_URL` 只能在进程级覆盖。
- **本机 gh 账号是 `wjf1`**（不是 `XINY11451`，历史 package.json 里那个是错的，已改）。
- **破坏性动作**：本机 `danger-full-access` 且无审批弹窗；删除/覆盖前先打印解析后的绝对路径，优先 move 到 `_trash_<时间戳>`。
- **git 推送不能走本机代理**：全局 `git config http.proxy = http://127.0.0.1:7900` 会让 GitHub 报 `schannel: failed to receive handshake, SSL/TLS connection failed`；推送要用 `git -c http.proxy= push`（仓库已设 `http.proxy=""` 本地覆盖）。npm 同理：registry.npmjs.org 直连可用（`NO_PROXY` 已含 localhost），不要给 npm 配代理。
- **默认分支**：本机 `git init` 默认 `master`，已 `git branch -m main`，CI 与文档都按 main。
- **手工装插件（本机无 `dsh` CLI）**：把包复制到 `<DSH_HOME>/profiles/<profile>/node_modules/<包名>`，再把包名追加进该 profile `package.json` 的 `dsh.profile.bundles`，靠 watcher 热加载，**不需要重启 DSH**（重启会杀掉当前会话的 GUI）。
- **验"插件是否真加载"**：宿主对**已注册路由**统一回 403 `refused by the host request gate`（未登录/不受信 origin），未注册路径回 404。所以 `/dsh-portable/api/status` 从 404 变 403 就是路由已挂载的证据；另可看副作用目录 `<DSH_HOME>/dsh-portable/{exports,uploads}` 是否被 apply 创建。想拿 200 必须在带登录 cookie 的浏览器页面里请求。
