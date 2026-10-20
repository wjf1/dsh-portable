# HANDOFF — dsh-portable 接力开发文档

> 新会话接手：先读本文件，再读 `README.md`（行为契约）与 `CHANGELOG.md`（当前版本做了什么），最后才看代码。
> 最后更新：2026-10-20 · 版本 0.1.9

---

## 1. 项目概况与当前状态

**它是什么**：DeepSeek Harness（DSH）插件。把一台机器上正在工作的 DSH 主目录按白名单打包成单个 `.dshpkg`（gzip tar，manifest 为首条目），在另一台机器上预览、合并或替换式还原；支持浏览器直接下载存盘（U 盘 / 内网拷贝）、HTTP 上传、一次性局域网分享三种传输方式。

**解决的问题**：DSH 的 profile 是"配置 + 带 node_modules 的插件 + 技能 + hooks + 任务板"的集合，且配置里写死本机绝对路径与 profile 名。换机时直接复制目录会导致插件路径失效，而插件安装依赖联网 pnpm，在内网机上根本不可行。

**当前状态（0.1.9，可交付）**：

| 维度 | 状态 |
| --- | --- |
| 功能完整度 | 导出（带百分比）/ 下载到本机 / 预览 / 导入（merge、replace，带二次确认与 package.json 合并）/ 上传（百分比）/ 局域网分享 / 备份（可恢复）/ 任务可取消 / 四个模型工具 / 设置页面板 —— 全部落地 |
| 测试 | `npm test` 59 项全绿（tar 11、archive 5、installer 8、jobs 2、routes 24、share 8、inspect 1） |
| 真实数据验证 | 对本机 `C:\\Users\\admin\\.dsh` 真导出：20 664 511 字节 / 13 774 条目 / 2.8 秒；再对临时 home 真安装：9 个顶层项全部落地、13491 文件、3 个文件 3 处路径被重写 |
| 发布状态 | **已发布 0.1.0 / 0.1.1 / 0.1.2 / 0.1.3 / 0.1.4 / 0.1.5 / 0.1.6 / 0.1.7 / 0.1.8 / 0.1.9**：0.1.9（补审计清单最后一项 P3-6：`notice` 成功提示 4 秒自动收起、`copyText` 超时计时器用 `try/finally` 释放，59 项测试全绿，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.9>）· 0.1.8（按同类问题审计清单逐项收口：`package.json` 合并真正接入 install 路径、备份恢复不再覆盖没有应急副本的文件、Range 完整区间才计数、`JOB_BUSY` 409、失败导入清理 staging、面板任务可取消 / 请求 60 秒超时 / 导出百分比 / 插件清单合并展示，59 项测试全绿，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.8>，tag 触发 release.yml 自动 npm publish）· 0.1.7（修「预览变更没反应」：任务失败的错误改用 `refresh().finally(...)` 兜底显示，上传落盘前用 `readManifest` 校验、截断包直接 400 `BAD_ARCHIVE`，50 项测试全绿）· 0.1.6（真机走查修复：任务终态改用 `succeeded`，进度条不再不收尾导致整面板按钮永久禁用；剪贴板写入加 1.5 秒超时兜底，49 项测试全绿，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.6>）· 0.1.5（面板可用性修复：备份恢复、导入二次确认、上传进度、真正写剪贴板、导入结果表格化、凭据警示，49 项测试全绿，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.5>，tag 触发 release.yml 自动 npm publish）· 0.1.4（新增「下载」按钮与 `GET /artifacts/download` 路由，46 项测试全绿，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.4>，tag 触发 release.yml 自动 npm publish）· 0.1.3（24 文件 / shasum `6dd21365…` / 200529 B 解包，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.3>，ci + release 全绿，本机 profile 已升到 `^0.1.3`）· 0.1.2（24 文件 / shasum `6d1db122…`，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.2>，ci + release 全绿，本机 profile 已升到 `^0.1.2`）· 0.1.1（24 文件 / shasum `660369b0…`，Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.1>，release.yml run 39103118643 真跑 npm publish）· 0.1.0 详情：npm <https://www.npmjs.com/package/dsh-portable>（24 文件 / 60.2 kB / shasum `1684d7b8…`）、GitHub Release <https://github.com/wjf1/dsh-portable/releases/tag/v0.1.0>、tag `v0.1.0`；线上安装 + `import('dsh-portable')` 冒烟通过 |
| 本机集成 | desktop profile 里已用 `npm install dsh-portable --legacy-peer-deps` 装好（`dependencies` 有记录、`dsh.profile.bundles` 有条目），面板在 设置 → 便携迁移。**2026-10-18 21:33 已按计划重启收尾**：临时热挂载条目 `mkt-dsh-portable` 已从 `<profile>/cordis.patch.yml` 删除（备份 `.bak-20261018-restart`），重启后由 bundle 层正式加载一份实例，`/dsh-portable/api/status` 回 403（身份闸）、未知路径 404，模型工具 `portable_export` 在真机上导出 118 MB / 14 841 条目成功。**踩过的坑**：早先手工拷贝的目录被同 profile 的 `npm install` 当 extraneous 清掉，插件静默消失、面板只剩 `HTTP 404` |
| 上架路径 | 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交条目（材料在 `market/`，见 `PUBLISHING.md`）；仓库创建未满 1 天前投不进去 |

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

## 4. 最近一轮变更与交付成果（0.1.9）

**0.1.9（当前）**：补审计清单的最后一项 P3-6（纯前端计时器）。`notice` 成功提示（导出完成 / 上传完成 / 备份已恢复）原本会永久留在面板顶部，下一次操作的反馈会叠在旧提示下面；现在 4 秒自动收起，并在 `notice` 重置或组件卸载时清掉计时器。`copyText` 里 1.5 秒超时用的 `setTimeout` 在 `navigator.clipboard.writeText` 成功时不会释放，页面留下悬空计时器；现在用 `try/finally` 保证 `clearTimeout`。无 API 变更，`node --check` + 59 项测试全过。

**0.1.8**：按「同类问题全项目审计」的 27 项清单逐项收口（P1 5 / P2 10 / P3 7 / 疑似 6）。关键的几条：`mergeProfilePackage` 从 0.1.0 起就写在 `lib/rewrite.mjs` 里，但 install 路径从未调用它（只调 `rewriteExtractedTree` 做路径替换），所以「按目标机现状合并 package.json」一直是文档宣称、代码没做——现在 `rewriteExtractedTree` 接收 `targetPackagePath` 并真正合并，结果进 `report.rewrites.merged` 并由面板显示；`/backups/restore` 的 pre-restore 拷贝失败此前被 `catch(() => {})` 吞掉后照样覆盖目标文件（现在失败项跳过，不覆盖没有应急副本的文件）；`jobs.dispose()` 无返回值导致 worker 退出不被等待（返回 `Promise.all`）；分享的 Range 请求此前一律不计数（浏览器发 `bytes=0-` 可无限下载，现在只认完整区间）；worker 未上报结果就退出会永久 running（现在 running/queued 状态下的任何退出都记 failed 并带退出码）。面板侧：`refresh` 成功不再清错误、上传改 XHR 带百分比与防重入、轮询防重叠、`call` 加 60 秒超时、JobBar 加取消按钮、导出进度补 `percent`、`report.rewrites.merged` 展示。边界与清理：delete / import 预检 / share remove 404、download 支持 HEAD、`keep:0` 真的清空普通快照且 `-pre-restore` 永不修剪、失败导入在 `finally` 里清 staging、`settings()` 优先 `profileContext.dshHome`、删掉 7 个死导出与 2 个死函数。测试 50 → 59（新增 9 项：删除 404、导入预检 404、下载 HEAD、JOB_BUSY 409、分享移除 404、/health 不暴露数量、完整 Range 计数、keep:0 与 -pre-restore、失败导入不留 staging）。

**0.1.7**：真机反馈「预览变更点了没反应」。直接打 API 复现：`POST /import/preview` 回 200 并启动 job，但 job 在 763 毫秒后 `state=failed`、`error.message=unexpected end of file`（`Z_BUF_ERROR`，zlib 解压到一半没了）——列表里选中的那个 22.7 MB 包是截断的上传（同一份包的完整导出是 521.5 MB / 546850812 B）。可前端什么都没显示：`lib/client.js` 的 `follow` 在 failed 分支先 `setError(...)` 再 `void refresh()`，而 `refresh()` 成功时第 462 行 `setError(null)` 把刚设的错误清掉，错误只活一帧，面板看起来像没响应。修法：failed 分支改 `void refresh().finally(() => setError(message))`，错误稳定留在顶部。第二层修上传：`lib/routes.mjs` 的 `receiveUpload` 在 `rename(part, destination)` 前用 `readManifest(part)` 校验，读不出 manifest 就删掉临时文件并回 400 `BAD_ARCHIVE`，截断包再也进不了库。测试新增 1 项（截断包被拒且不落库），`upload` 用例改为上传真实包，全量 50 项通过。

**0.1.6**：真机复测 0.1.5 时发现面板会在导出 / 预览 / 导入结束后「假死」：后端 `lib/jobs.mjs` 第 83 行的终态是 `succeeded`，而 `lib/client.js` 的 `follow` 只认 `done`，于是 `stopPolling()` 与 `setBusyJob(null)` 永不执行、`busy` 恒真 —— 创建包、刷新、选择、分享、删除、执行导入全部禁用（本机导出 568.4 MB 后稳定复现；该判断自 0.1.0 首版就是 `done`，属历史缺陷，直到这轮真机走查才暴露）。改为按 `succeeded` 收尾，并补 `state.succeeded` 文案（此前 JobBar 直接显示英文枚举）。另一处：`copyText` 直接 `await navigator.clipboard.writeText(...)`，在未聚焦或受限窗口里该 Promise 既不 resolve 也不 reject，分享后的自动复制会永久待定；改为 `Promise.race` 加 1.5 秒超时，超时后落到 `textarea` + `execCommand('copy')`。全量 49 项测试通过。

**0.1.5**：按真机走查修面板可用性。分享按钮此前只 `setCopied(url)` 从未写剪贴板、复制按钮在剪贴板不可用时也标「已复制」——新增 `copyText()`（`navigator.clipboard` → `textarea` + `document.execCommand` 兜底，返回布尔），两处都以真实结果为准；「执行导入」原来一击落盘，改为内联确认块（写明 merge / replace，并提示 replace 会先移走旧项）；包列表的「导入」改名「选择」（它只做选中）；merge/replace 按钮由 `disabled` 改成 `active` + `aria-pressed`；上传改 XHR 带百分比；导出 / 上传 / 恢复完成都有 notice 行；导入结果由裸 `<pre>` 换成键值表格（applied / rewritten / backupDir / warnings）；勾选「凭据文件」时红字警示；删掉死键 `act.inspect`。新增 `POST /backups/restore`（`lib/routes.mjs`）：校验 `\d{8}-\d{6}` 形式的 stamp → 逐文件写回主目录，写回前把当前版本另存到 `<stamp>-pre-restore`（所以恢复也能反悔），备份里的 `replaced/` 不参与恢复；备份卡片每条加「恢复」+ 二次确认。测试 46 → 49（恢复写入并保留被覆盖文件、缺备份 404、stamp 越界 400 `BAD_STAMP`）。**踩坑**：`copyFile(source, aside)` 写成把备份文件拷进 pre-restore 目录，测试报 `Expected 'live' but got 'from-backup'`，应为 `copyFile(target, aside)`。

**0.1.4**：补上「把包交给另一台机器」的最后一环 —— 面板的包列表此前只有导入 / 分享 / 删除，没有下载，导出后的 `.dshpkg` 只能留在本机，U 盘 / 内网机这条最常用的离线路径走不通（分享是局域网临时链接，解决不了跨网）。新增两个入口：`GET /artifacts/download?id=`（`lib/routes.mjs`，按 artifact id 校验后以 `application/octet-stream` + `content-disposition: attachment` 流式发送，`pipeline` 直连磁盘，几百 MB 的包不进内存；缺包 404、越界 id 400）与包卡片的「下载」按钮（`lib/client.js`，`a[download]` 同源下载，自带宿主 cookie）。同时给 `sendJson` / `sendText` 加 `headersSent` / `destroyed` 防护、外层 catch 在响应头已发出时改 `response.destroy()`，避免下载中断触发 `ERR_HTTP_HEADERS_SENT` 盖掉真实错误。新增 3 项路由测试，全量 46 项；双语 README 的面板说明与 API 表同步；界面截图沿用 0.1.3 之后新增的 `assets/` 两张脱敏图，本版 `files` 已含 `assets`。

**0.1.3**：修「同机同主目录」导入的收尾崩溃 —— `lib/installer.mjs` 只在源 home ≠ 本机 home 时才做路径重写（否则 `report.rewrites` 为 `null`），而 `bootstrap/bootstrap.mjs` 无条件读 `result.rewrites.files.length`，于是在**文件已落盘之后**抛 `TypeError: Cannot read properties of null`，误导用户以为导入失败。改为分情况打印（有重写报「N 个文件 M 处路径」，没有时打印 `none (package was already built for <home>)`）；新增 1 项回归测试（同 home 既导出又导入，断言 `rewrites === null` 且文件照常落地），全量 43 项。同日空白 home 全链路手测通过：`bootstrap.mjs install` 输出 `applied AGENTS.md, hooks, profiles` + `rewrites 3 files, 1 paths`，新 home 里插件与 `cordis.patch.yml` 均按新 home 重写。

**0.1.2**：修两个读取缺陷 —— `readManifest()` 返回 `{ manifest, raw }`，而 `lib/tools.mjs` 的 `inspectPackage` 与 `lib/routes.mjs` 的 `GET /artifacts/meta` 都把整个返回值当 manifest 用，导致模型工具抛 `Cannot read properties of undefined (reading 'map')`、HTTP 入口把 manifest 原文多包一层。两处改为显式取 `.manifest`，`meta` 额外返回拍平的 `roots`；`inspectPackage` 缺 manifest 时报可读错误。新增 2 项测试（真包跑模型工具、真包跑 meta），全量 42 项。

**0.1.1**：面板在宿主端未加载时不再裸抛 `HTTP 404` —— `describeFailure()`（`lib/client.js`）把 404 翻成「宿主端未加载：插件可能没装完，或者装好后还没重启 DSH」，403 翻成「请求被宿主拒绝：请在 DSH 窗口里打开这个面板」，其余状态码保留 `HTTP <code>`，文案随宿主语言；双语 README 的安装章节写明包必须登记进 profile 的 `dependencies` + `dsh.profile.bundles`，手工拷 `node_modules` 会被下一次 `npm install` 清掉。无 API / 格式变更，40 项测试全绿。

**0.1.0（首发）**：新增：打包格式与 manifest、白名单采集、两级体积开关、两阶段导入、merge/replace、安装前备份、路径重写与 package.json 合并、profile 改名、worker 后台任务、16 个 HTTP 端点、设置页六卡片面板、四个模型工具、一次性局域网分享、无宿主 bootstrap CLI、40 项测试。

修复（都是实现期真实撞到的）：

- **tar 在 PAX 长路径后错位**：PAX 正文长度非 512 整数倍时未跳 padding，其后条目头全错，报 `tar header checksum mismatch`。修法：pad 增量消费 + `parsePax` 按长度前缀逐条解析。
- **打包中文件变短**：改补零 + warning，不再中断。
- **未处理的 `ERR_STREAM_PREMATURE_CLOSE`** 掩盖真实导出错误：`finished.catch(() => {})` + 重写消息。
- **打开失败即写坏 header**：先开句柄再写头。
- **分享下载计数不生效**（`writableFinished` 在 `end` 里恒 false）：改挂 `finish`，且 206 不计数。
- **过期 token 的 410/404 语义**：加 `retired` 集合。

验证：真实 DSH_HOME 导出 + 临时 home 安装全链路通过（数字见第 1 节表格）。

### 4.1 离线迁移套件（U 盘，2026-10-18）

给「纯内网目标机」准备的一整套搬运介质，落在 `G:\DSH-Migration\`（exFAT，共约 875 MB）：

| 目录 | 内容 | 说明 |
| --- | --- | --- |
| `01-installer` | `deepseek-harness-0.2.1-rc.2-win-x64.exe`（276 MB） | 从 updater 缓存取得；SHA-512 与 `update-info.json` 逐字节一致 |
| `02-package` | `dsh-portable-20261018-2315.dshpkg`（597 MB，10.5 万条目 / 1.8 GB 展开） | `includeNodeModules=true`，其余开关全关（不含 sessions/runtimes/credentials/backups） |
| `03-plugin` | 插件本体 28 文件 | 从仓库工作树拷出，含 `bootstrap/`，可直接落地 |
| `04-docs` | PPT《DSH迁移-纯内网版.pptx》（14 页）/ `迁移说明.txt` / `SHA256SUMS.txt` | 演示 + 可打印速查 + 校验值 |

验收证据（都实测过）：

- 包里确实带着插件：`tar -tzf <pkg> | grep node_modules/dsh-portable/` 命中 28 条，含 `package.json` 与 `bootstrap/bootstrap.mjs`。
- 目标机无 Node 也能导入：`$env:ELECTRON_RUN_AS_NODE='1'` + `DeepSeek Harness.exe <bootstrap.mjs> preview <pkg> --profile desktop --home <临时目录>` → 退出码 0，打印 `contents 97979 files, 1.8 GB, 9 top-level items` 与九项明细，末行 `nothing was written (preview).`。
- 安装器完整：`Get-FileHash -Algorithm SHA512` 的 Base64 与官方 `update-info.json` 的 `sha512` 完全相等。
- PPT 版面自检脚本（`_tmp_check_ppt.py` 思路）为 0 问题：14 页、无越界、无文字溢出。

## 5. 待办与下一步

按优先级：

1. ~~重启 DSH 收尾集成~~（已完成 2026-10-18 21:33）：临时热挂载条目 `mkt-dsh-portable` 已从 `<profile>/cordis.patch.yml` 删除并备份为 `.bak-20261018-restart`，重启后由 bundle 层正常加载（新端口 52803，`/dsh-portable/api/status` 回 403 = 路由已挂载）。
2. ~~市场 PR~~（已提交 2026-10-19 22:33）：PR [awesome-dsh-plugin#8129](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8129)「Add wjf1/dsh-portable」，仅新增 `data/plugins/wjf1__dsh-portable.yml`（+6 行，0 删除），CI 全绿（stale-fork guard、awesome-lint、READMEs/data 一致性、build 均 success），现在等维护者评审合并。**注意**：本机 git HTTPS 直连克隆会被重置（`curl 56 Recv failure`），实际提交走的是 GitHub REST API（`gh api` 建 ref + PUT contents + `gh pr create`）；后续同步 fork 也优先走 API 或 `git -c http.proxy=`。
3. ~~截图~~（已完成 2026-10-19）：两张面板截图已脱敏并入仓 —— `assets/panel-export.png`（导出卡片 + 包列表）与 `assets/panel-import-share.png`（上传 / 导入 / 局域网分享 / 备份）。脱敏点：图 B 的主目录 `C:\Users\admin\.dsh` 已改为 `C:\Users\you\.dsh`；图 A 的分享链接真实内网 IP `192.168.0.1`、端口 `60571` 与 32 位 token 已整体替换为示例值（`http://192.168.1.10:60571/d/` + 32 个 `0`）。同时新增仓库根 `screenshots.json`（2 张相对路径，市场详情页按此展示），双语 README 各加「界面截图 / Screenshots」小节。原计划 3 张里的「导入预览」「分享链接」由含导入与分享的同一张图覆盖，不再单拆。
4. **性能**：`skills-disabled` 在本机占 44.6 MB（整包 86%）。可考虑"默认排除已被禁用技能"的开关。
5. **加密**：当前包是明文 tar。凭据入包时应支持口令加密（AES-256-GCM + scrypt）。
6. **单文件选择器**：v0.1.x 只能按顶层根整体导入，后续可支持勾选具体子路径。
7. **e2e 测试**：目前 installer 用临时目录 + fixture，缺"真实 profile 装完能被 DSH 启动"的验证。
8. **下载的后续改进**（0.1.4 已落地主体）：当前 `GET /artifacts/download` 整文件流式发送，未实现 Range 断点续传，也没有面板内进度条——500 MB 以上的包只能看浏览器自己的下载提示。可复用分享路由里已有的 Range/HEAD 处理。
9. ~~0.1.5 真机走查~~（已完成 2026-10-20，产物是 0.1.6 / 0.1.7）：按清单在真机上逐项点了面板 —— 下载链接指向 `GET /artifacts/download?artifactId=exports%3A…` 且带 `download` 文件名；「选择」后导入卡显示当前包；「执行导入」先出内联确认块（确认写入？/ merge 与 replace 说明 / 覆盖同名文件警告 / 确认导入 + 取消）；「分享」生成一次性链接并自动尝试写剪贴板（无聚焦环境下会降级提示「复制失败：请手动选中链接复制。」，按钮「复制链接」可重试）；勾「凭据文件」出红字警示；上传卡 hint 与百分比行就位。走查还揪出 0.1.6 修的两个缺陷（进度条不收尾、剪贴板挂起），见第 4 节。**二轮（2026-10-20 晚）**：用户报「预览变更点了没反应」，用不带 UI 的 fetch 直接打 `/import/preview` 复现出 job `failed`（`unexpected end of file`），再对照前端代码发现错误被 `refresh()` 清掉 —— 0.1.7 同时修了错误显示与上传完整性校验。

10. **0.1.8 真机走查**（待做，需重启后）：确认导出进度条有百分比、任务可取消、失败任务错误常驻、导入结果多出「插件清单合并」行、`HEAD /artifacts/download` 回 200 空 body、备份恢复保留 `-pre-restore`、`keep:0` 不误删 pre-restore。

## 6. 关键避坑与运行约束

- **「文档宣称」的功能要用调用链验证**：`mergeProfilePackage` 在 `lib/rewrite.mjs` 里躺了 8 个版本，install 路径从未调用它——定义在、HANDOFF 写了、测试 0 命中。审计这类「实现了但没接线」的缺陷，用「函数名 grep + 调用点 grep + 测试 grep」三查，别只看函数存在。
- **`-pre-restore` 不能进备份保留预算**：`pruneBackups` 若把 `*-pre-restore` 当普通快照计数，`keep:0` 会把「唯一能反悔的副本」删掉；stamp 正则要区分 `^\d{8}-\d{6}$` 与 `-pre-restore`，只对前者计数。

- **失败任务的消息会被 refresh 吃掉**：`refresh()` 成功时第 462 行 `setError(null)`；`follow` 若先 `setError(...)` 再 `void refresh()`，错误只活一帧，用户看到的是「点了没反应」。失败分支要用 `void refresh().finally(() => setError(message))`（0.1.7）。排查这类「无反应」先看 `follow` 的终态分支与 `refresh` 的清理顺序，再看 job 的 `error.message`。
- **上传必须校验 manifest**：`receiveUpload` 的 `pipeline` 成功只代表字节写完，不代表包完整；截断包（521.5 MB 只传了 22.7 MB）会让之后每次预览 / 导入报 `unexpected end of file`（`Z_BUF_ERROR`）。落盘前 `readManifest(part)` 一次，失败 `rm(part)` 并回 400 `BAD_ARCHIVE`（0.1.7）。
- **`node --test`**：不要写 `node --test test/`。
- **`String.raw` 里的正则**：字符类中 `{` 紧跟 `$` 会被模板插值解析成 `Expression expected`，把花括号挪到字符类末尾。
- **`worker_threads`**：只用 `new Worker(url)` 会报 `Worker is not defined`，必须先 `import { Worker } from 'node:worker_threads'`。
- **HTTP 下载计数**：`source.on('end')` 里 `response.writableFinished` 恒为 false，用 `response.on('finish')`。
- **分享 TTL**：`clampTtl` 下限 1 分钟，测试用过小 TTL 无效，要白盒改 `share.shares.get(token).expiresAt`。
- **npm 发布必须带 bypass-2FA 的 granular token**：普通 granular token 即使账号 2FA 关闭也会被拒，报 `403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。网页端建 token 时勾 **Bypass two-factor authentication (2FA)**，Permissions 选 *Read and write (publish and stage)*，Packages 选 *All packages*；账号无组织时，组织权限必须选 *No access*，否则页面顶部报 *You must select at least one organization…*。
- **`~/.npmrc` 追加 token 必须先补换行**：原文件末行无换行时 `Add-Content` 会把新行接到 `prefix=…` 后面拼成一行，npm 报 `ENEEDAUTH`。用 `Get-Content` 重写整个文件最稳。
- **发布命令不要用 `| Select-Object -First N`**：管道被提前关闭会**杀掉 npm 进程**，日志停在 `Publishing to …`，既不报错也不成功。改为 `*>` 重定向到文件再读尾部。
- **刚发布的包 fetch 会命中旧缓存**：`npm install dsh-portable@0.1.0` 可能报 `ETARGET No matching version`（缓存里只有占位的 `0.0.0-stage`），加 `--prefer-online` 即可。新包首次上线时 registry 元数据里会短暂只有 `0.0.0-stage` 占位版本。
- **本仓库 `git push` 必须绕过全局代理**：`http.proxy=http://127.0.0.1:7900` 会让 GitHub 握手失败（`schannel: failed to receive handshake`），用 `git -c http.proxy= push`（仓库内已设 `http.proxy ""`）。
- **release.yml 的 tag 标题**：`actions/checkout` 可能把 annotated tag 落成轻量标签，`%(contents:subject)` 退化成提交信息。工作流已改为先 `git fetch --force --tags`，非 tag 对象时走 GitHub API 取 message；标题与 tag subject 不一致时用 `gh release edit --title` 手工纠正。
- **CHANGELOG 顶段版本必须等于 package.json**：`scripts/verify-release.mjs` 会比对两者；纯文档提交若在顶部写「未发布」而版本号没动，CI 的 `node scripts/verify-release.mjs --skip-tests` 会直接失败（0.1.4 就红过一次）。改完文档先本地跑一次这个脚本再 push。
- **后台任务终态是 `succeeded`，不是 `done`**：`lib/jobs.mjs` 只在 `done` 消息到达时置 `succeeded`，`failed` / `cancelled` 是另外两个终态。前端 `follow` 的轮询判断必须认 `succeeded`，否则 `stopPolling()` 与 `setBusyJob(null)` 永不执行，`busy` 恒真会让整面板按钮永久禁用（0.1.0–0.1.5 都错在这里，0.1.6 修）。新增任务类型时同步检查 `i18n` 里的 `state.*` 文案。
- **Windows 长路径**：所有 fs 调用都过 `longPath()`（加 `\\?\` 前缀），否则深层 node_modules 会 `ENOENT`。
- **符号链接**：Windows 无开发者模式时创建失败，必须降级为 warning，不能中断导入。
- **真实 DSH 目录**：`app.asar` 是**文件**不是目录，PowerShell 无法进入；要读源码得用 `npx asar extract` 或直接看 `resources/app.asar.unpacked`。
- **市场是策展清单**：`dshmarket` 从 `https://awesome-dsh-plugin.com/plugins.json` 读目录，条目来自 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin`；上架是提 PR，不是自己上传。环境变量 `DSHM_REGISTRY_URL` 只能在进程级覆盖。
- **本机 gh 账号是 `wjf1`**（不是 `XINY11451`，历史 package.json 里那个是错的，已改）。
- **破坏性动作**：本机 `danger-full-access` 且无审批弹窗；删除/覆盖前先打印解析后的绝对路径，优先 move 到 `_trash_<时间戳>`。
- **git 推送不能走本机代理**：全局 `git config http.proxy = http://127.0.0.1:7900` 会让 GitHub 报 `schannel: failed to receive handshake, SSL/TLS connection failed`；推送要用 `git -c http.proxy= push`（仓库已设 `http.proxy=""` 本地覆盖）。npm 同理：registry.npmjs.org 直连可用（`NO_PROXY` 已含 localhost），不要给 npm 配代理。
- **默认分支**：本机 `git init` 默认 `master`，已 `git branch -m main`，CI 与文档都按 main。
- **装插件不能只拷目录**：把包复制进 `<DSH_HOME>/profiles/<profile>/node_modules/<包名>` 也能被加载，但该 profile 下一次 `npm install` 会把它当 extraneous 删掉（2026-10-18 本机就是这样让面板变成「卡片照常渲染、每个请求 404」）。正确姿势：在 profile 目录里 `npm install <包名> --legacy-peer-deps`（profile 有宿主导入的 peer，直装会 `ERESOLVE`），它会把包同时写进 `dependencies`；再确认 `dsh.profile.bundles` 里有条目。
- **bundle 插件在当前进程里的热挂载**：新增 bundle 只在下次启动加载。想不动进程就挂上，往 `<profile>/cordis.patch.yml` 末尾追加两行 —— `- id: mkt-<包名>` 与 `  name: <包名>`，loader 十几秒内热挂载该条目（`/dsh-portable/api/status` 会从 404 变 403）。**id 必须与 bundle 层插入的 id 不同**（同 id 是启动硬失败，dshmarket 的注释原话：inserting an id the bundle layer also inserts is a hard boot failure）；重启后这条会变成第二份实例，所以重启前要删掉。
- **在 profile 里跑 `npm install` 会顺带 prune**：它会删除所有没在 `dependencies` 里声明的手工目录（本机一次删了 6 个包）。执行前先确认这些目录不是别处手装的，或先拷一份到 `_trash_<时间戳>`。
- **验"插件是否真加载"**：宿主对**已注册路由**统一回 403 `refused by the host request gate`（未登录/不受信 origin），未注册路径回 404。所以 `/dsh-portable/api/status` 从 404 变 403 就是路由已挂载的证据；另可看副作用目录 `<DSH_HOME>/dsh-portable/{exports,uploads}` 是否被 apply 创建。想拿 200 必须在带登录 cookie 的浏览器页面里请求。
