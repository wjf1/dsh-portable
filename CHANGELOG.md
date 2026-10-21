# CHANGELOG

本文件记录 dsh-portable 的所有重要变更，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

### 修复

- **含重复路径条目的包会让导入永久挂起**（`lib/archive.mjs`）：`flags: 'wx'` 的重复路径错误是异步抛出的，而写入端只在等 `'drain'`。出错后的流永远不会再发 `drain`，`end()` 的回调也不会执行，于是 promise 永不 settle，界面一直转圈。现在收尾同时监听 `drain`/`close`/`error`，写入失败降级为 warning 并继续（与解包器"文件系统拒绝的条目不算致命"的既有口径一致），`O_EXCL` 仍然保证不覆盖已写入的文件。附「重复路径条目」回归测试。
- **取消导入会残留整包大小的暂存垃圾**（`lib/jobs.mjs`、`lib/worker/job-worker.mjs`）：取消直接 `worker.terminate()` 硬杀线程，worker 里 `finally` 的暂存清理永远不执行，每次取消都在 `portable-staging/` 留下一个目录。现在先向 worker 发 `abort` 消息、等它自行清理退出（5 秒宽限），确认退出不了才 terminate；宿主侧还会按 worker 上报的 stagePath 兜底删除。附两条回归测试（中止导入、取消任务）。
- **解包失败同样会残留暂存**（`lib/installer.mjs`）：解包的 `catch` 原本在 `finally` 之外，抽取阶段抛错时不会被清理。现在解包也纳入 `finally` 保护范围。
- **分享下载计数存在竞态**（`lib/share.mjs`）：`检查 downloads>=max → 传输 → +1` 不是原子的，两个并发请求能双双通过检查，"最多下载 N 次"不被严格执行。现在在检查的同一 tick 内预留名额，传输完成才结算，中断则释放（中断不算一次下载）。
- **恢复时可能还原越界的符号链接**（`lib/installer.mjs`）：`mergeTree` 直接 `readlink` + `symlink`，没有校验目标。现在绝对路径、盘符、含 `..` 的目标一律拒绝并记 warning（纵深防御：解包侧本来也会拒）。

### 新增

- **`.dshpkg` 文件级 sha256 校验**（`lib/archive.mjs`）：打包时边写边算，包尾写一个 `.dsh-portable/checksums.json`；导入时边写边算并与它比对，任何一个文件不一致就拒绝导入（不再静默还原坏数据）。没有该条目的旧包仍可导入，`stats.verified` 为 `false` 并记一条 warning。校验清单放在包尾而不是 manifest 里，是为了保住「读 manifest 只花几 KB」这个用于预览/检查的约定。
- 导出/预览解包（`extractPackage`、`writePackage`、`install`）都接受 `AbortSignal`，长任务可协作式中止。

### 移除

- `lib/schema.mjs`（16 个配置项的 schemastery 面板）：全文零引用，仓库也没有配置 UI，用户改不到这些开关——尤其 `shareEnabled` 被承诺能关掉分享却完全没接线。分享本身是逐次显式动作（`POST /share` 或 `portable_share` 工具），不会常驻监听，因此直接删除这份死配置而不是接一条新的配置链路。
- 根目录被误提交的 `{` 空文件（某次 shell 花括号展开的残留）。

## 0.1.10 — 2026-10-20

### 修复

- **上传输入没有禁用**（`lib/client.js`）：上传进行中仍能再次选择文件，第二次点击会被 `uploadBusy` 静默丢弃，用户看不出为什么没反应。现在上传或任务进行中文件输入框是 `disabled`。
- **删除包用的是闭包里的旧选中值**（`lib/client.js` 的 `deleteArtifact`）：回调捕获的 `selected` 可能是上一次渲染的值，删掉当前选中的包时不会清空导入卡片。现在改用函数式 `setSelected`，删除任何包后都清空预览结果。
- **刷新后丢失正在运行的任务**（`lib/client.js` 的 `refresh`）：面板重载只恢复数据、不恢复 `busyJobId`，进度条消失、按钮全部可点。现在 `refresh` 读到 `status.busyJobId` 且当前没有轮询时，取 `/jobs/detail` 重新接管该任务。
- **导入与恢复完成后没有提示重启**（`lib/client.js`）：写入的配置要重启 DSH 才生效，面板此前只报「已恢复」。现在导入完成与备份恢复的提示都带「需要重启 DSH 才会生效」。
- **包读取失败被伪装成「缺 manifest」**（`lib/archive.mjs` 的 `readManifest` / `extractPackage`）：`createReadStream` 的错误没有转发给 `gunzip`，`pipe` 会吞掉它，调用方拿到的是 `missing dsh-portable/package.json`（指向包内容而不是不可读的路径），还可能因未处理的 `error` 事件让进程退出。现在 source 的错误直接 `gunzip.destroy(error)`。

### 测试

- 新增 1 项（缺失文件抛 `ENOENT` 而不是「缺 manifest」），全量 60 项通过。

## 0.1.9 — 2026-10-20

### 修复

- **成功提示永不消失**（`lib/client.js`）：导出完成、上传完成、备份已恢复这些 `notice` 提示此前会一直挂在面板顶部，下一次操作的反馈只能叠在旧提示下面。现在 4 秒后自动收起，重设或组件卸载时清掉计时器。
- **复制超时的计时器不释放**（`lib/client.js` 的 `copyText`）：1.5 秒超时用的 `setTimeout` 在 `navigator.clipboard.writeText` 成功时不会被清理，页面里留下一个悬空计时器。现在用 `try/finally` 保证 `clearTimeout`。

### 测试

- 无新增（纯前端计时器行为，`node --check` + 59 项全量通过）。

## 0.1.8 — 2026-10-20

按「同类问题全项目审计」的结论逐项收口：4 个 P1 正确性缺陷、8 个 P2 健壮性缺陷、6 个 P3 细节与 2 个疑似项。没有新功能，全部是让既有行为按文档所写的方式兑现。

### 修复（正确性）

- **`package.json` 合并从来没有执行过**（`lib/rewrite.mjs` / `lib/installer.mjs`）：`mergeProfilePackage` 写好了、HANDOFF 也宣称「按目标机现状合并」，但 install 路径只调用了 `rewriteExtractedTree`，后者只做路径替换。结果导入会把源机的 `dependencies` 直接盖在目标机上，目标机后来装的插件在下次 `npm install` 时会被当成 extraneous 删掉。现在 `rewriteExtractedTree` 接收 `targetPackagePath`，读目标机 `package.json` 后按 `mergeProfilePackage` 合并，结果写入 `report.rewrites.merged` 并在面板显示（保留 / 缺失的 bundle）。
- **备份恢复会覆盖无法回滚的文件**（`lib/routes.mjs` 的 `/backups/restore`）：pre-restore 拷贝失败时被 `catch(() => {})` 吞掉，接着照样把备份写回去。现在失败项进入 `failed` 并跳过，绝不覆盖没有留下应急副本的文件。
- **`jobs.dispose()` 返回 `undefined`**（`lib/jobs.mjs`）：`index.js` 写的是 `void jobs.dispose().catch(...)`，worker 优雅退出路径根本没有被等待。现在 `dispose()` 收集每个 `worker.terminate()` 并返回 `Promise.all`。
- **Range 下载不计入次数**（`lib/share.mjs`）：浏览器断点续传会发 `Range: bytes=0-`，此前只看「有没有 Range 头」，于是一次性链接可以无限下载。现在只有完整区间（`range === null` 或 `0..size-1`）才计数。
- **worker 退出未上报结果时任务永久 running**（`lib/jobs.mjs`）：原逻辑只在退出码非 0 时标失败，code 0 会让任务卡在 running、面板按钮全禁用。现在任何「running/queued 状态下退出且没上报结果」都记为 failed 并带退出码。

### 修复（面板）

- **刷新会清掉刚显示的错误**（`lib/client.js` 的 `refresh`）：成功分支的 `setError(null)` 会吃掉 `follow` 刚设置的失败信息（0.1.7 只修了时序，本次从根上去掉）。
- **上传没有进度、也没有防重入**（`lib/client.js`）：`fetch` 改 `XMLHttpRequest`，`upload.onprogress` 驱动百分比；`uploadBusy` ref 挡住连点。
- **轮询可能重叠**（`lib/client.js` 的 `follow`）：前一次 `jobs/detail` 未返回时不会发起下一次（`pollBusy` ref）。
- **请求没有超时**（`lib/client.js` 的 `call`）：统一 60 秒 `AbortController`，超时错误写明 `timeout after 60s: <path>`。
- **任务无法取消**：`JobBar` 增加取消按钮（`POST /jobs/cancel`），running 时才显示。
- **导出没有百分比**（`lib/archive.mjs`）：write 阶段进度补 `percent`，面板显示 `已完成 / 总数 files`。
- **`JOB_BUSY` 被当成 500**（`lib/routes.mjs`）：现在回 409 并带 `busyJobId`。

### 修复（边界与清理）

- `/artifacts/delete` 删除不存在的包：404，不再是静默成功。
- `/import` 预检：包不在磁盘上直接 404，不进 worker。
- `/share/remove` 移除不存在的分享：404。
- `/artifacts/download` 支持 `HEAD`（返回头、空 body），`handle` 把 HEAD 映射到 GET 路由。
- 备份保留策略（`lib/installer.mjs`）：`keep: 0` 现在真的清空普通快照；`*-pre-restore` 目录永不被预算修剪（否则「恢复」唯一能撤销的手段会被自己删掉）。
- 导入中途失败不再留下 `portable-staging` 目录：staging 清理移入 `finally`。
- `settings()` 优先取 `profileContext.dshHome`，`lib/paths.mjs` 删除 7 个死导出与 `fs`/`os` 引用；`lib/manifest.mjs` 删除 `describeManifest`/`formatBytesShort`。

### 安全

- `/health` 不再回报当前连接数（未认证调用者不该知道有多少条链接在跑）。

### 测试

- 新增 9 项：删除不存在 404、导入预检 404、下载 HEAD、`JOB_BUSY` 409、分享移除 404、`/health` 不暴露数量、完整 Range 计数、`keep:0` 与 `-pre-restore`、失败导入不留 staging。全量 **59 项**通过。

### 文档

- README 双语补 `report` 合并展示、取消按钮、下载 HEAD 与测试数；HANDOFF 记录审计分类与逐项结论。

## 0.1.7 — 2026-10-20

真机反馈「预览变更点了没反应」：查下来是两层问题叠在一起 —— 一个被截断的包，以及失败原因刚显示就被自己清掉。

### 修复

- **任务失败的错误只存在一帧**（`lib/client.js` 的 `follow`）：failed 分支先 `setError(...)` 再 `void refresh()`，而 `refresh()` 成功时会 `setError(null)`，于是错误立刻被清空，面板看起来像什么都没发生。改为 `refresh().finally(() => setError(message))`，失败原因稳定留在顶部。
- **上传不校验包是否完整**（`lib/routes.mjs` 的 `receiveUpload`）：截断的上传文件（例如 521.5 MB 的包只传了 22.7 MB）会被当成正常包收下，之后每次预览 / 导入都报 `unexpected end of file`。现在落盘前先用 `readManifest` 读一次 manifest，读不出就删掉临时文件并回 400 `BAD_ARCHIVE`。

### 测试

- `upload` 用例改为上传真实包（`writeRealPackage` 辅助）；新增「截断包被拒且不落库」（400 `BAD_ARCHIVE`，列表里看不到）。全量 50 项。

### 文档

- HANDOFF 记录两处根因与排查路径。

## 0.1.6 — 2026-10-20

0.1.5 的真机走查揪出两个让面板「看起来卡死」的缺陷：一个是自 0.1.0 就写错的终态判断，一个是剪贴板 API 挂起。

### 修复

- **导出/预览/导入的进度条永不收尾**（`lib/client.js` 的 `follow`）：后端任务终态是 `succeeded`（`lib/jobs.mjs` 第 83 行），前端却等 `done`，于是 `stopPolling()` 与 `setBusyJob(null)` 永不执行、`busy` 一直为真 —— 创建包、刷新、选择、分享、删除、执行导入全部禁用。本机导出 568.4 MB 后稳定复现。现在按 `succeeded` 收尾；`state.succeeded` 也补了 i18n 文案（此前直接显示英文枚举）。
- **剪贴板写入可能永久挂起**：`copyText` 直接 `await navigator.clipboard.writeText`，在未聚焦或受限窗口里该 Promise 既不 resolve 也不 reject，按钮停在待定态。现在 1.5 秒超时后兜底到 `textarea` + `document.execCommand('copy')`。

### 测试

- 全量 49 项通过（本次只改客户端行为，未新增用例）。

### 文档

- HANDOFF 增加「job 终态是 `succeeded`，不是 `done`」的避坑条目。

## 0.1.5 — 2026-10-19

按一次真机走查的结论修面板：功能都在，但「点了到底发生了什么」不清楚，还有两处会让人误判成功。

### 新增

- **备份可恢复**（`lib/routes.mjs` 的 `POST /backups/restore` + `lib/client.js` 的「恢复」按钮）：把某份导入前备份写回主目录；写回前先把当前版本另存为 `<stamp>-pre-restore`，所以恢复本身也能反悔。恢复只覆盖备份里存在的文件，`replaced/` 目录不参与。
- **执行导入前弹内联确认**：原来点「执行导入」直接落盘，和同一面板里「删除」的二次确认不一致。现在先展开确认块（写明当前是 merge 还是 replace、并提示 replace 会先移走旧项），确认后才调 `POST /import`。
- **上传进度**：上传改走 `XMLHttpRequest`，显示百分比；完成/失败都有明确提示，不再「选完文件就没了动静」。
- **导出完成提示**、以及删除/预览/恢复后清空的 notice 行：每张卡片操作完都有可读结果。
- **导入结果表格化**：`applied` / `rewritten` / `backupDir` / `warnings` 用键值表格呈现，不再把整个 report 塞进 `<pre>`。
- **凭据勾选警示**：勾上「凭据文件（含密钥）」时，导出卡片下方出现红字提示（此前 PR 正文声称有警告，实际没有）。

### 修复

- **分享链接实际没进剪贴板**：`shareArtifact` 原来只 `setCopied(url)` 就显示「已复制」，从未调用剪贴板 API。现在真正写入并把结果作为显示依据；失败时给出提示。
- **「复制」按钮的兜底分支假成功**：剪贴板不可用或写入失败时仍无条件标记已复制。现在两条路径都返回布尔值，只有成功才显示「已复制」；纯 HTTP 来源下走 `textarea` + `document.execCommand('copy')` 兜底。
- **包列表的「导入」按钮名不副实**：它只做选中，真正导入在下方卡片。改名「选择」，并同步清空上一次的预览/结果/确认状态。
- **模式按钮用 `disabled` 表示选中**：视觉上像「不可用」，改成 `active` 高亮 + `aria-pressed`，点击不再被吞。
- **`act.inspect` 死键**：i18n 里定义了却没有引用，删掉。

### 测试

- 新增 3 项：备份恢复写入并保留被覆盖文件（`<stamp>-pre-restore`）、恢复不存在的备份回 404、stamp 越界（`../profiles`）回 400 `BAD_STAMP`。全量 49 项。

### 文档

- 双语 README 的六卡说明与 HTTP API 表补上「恢复」与执行导入确认、上传进度、复制兜底；测试数改为 49。

## 0.1.4 — 2026-10-19

补上一条实际卡住换机流程的缺口：包能导出来，却没有任何入口把它交给浏览器存盘，U 盘 / 内网机这条离线路径走不通。

### 新增

- **包列表新增「下载」按钮**（`lib/client.js`）：每个 `.dshpkg` 旁边都有「下载」，浏览器按 `a[download]` 同源下载存盘，文件名沿用包名；悬停提示说明用途。
- **新路由 `GET /artifacts/download?id=`**（`lib/routes.mjs`）：按 artifact id 校验（只认 `exports:` / `uploads:` 前缀，拒绝路径分隔符与 `..`），返回 `application/octet-stream` + `content-disposition: attachment` + `content-length`，用 `pipeline` 流式发送，几百 MB 的包也不会进内存。缺包回 404、越界 id 回 400，与其它 JSON 端点口径一致。

### 修复

- **流式响应之后不能再写 JSON**：`sendJson` / `sendText` 增加 `headersSent` / `destroyed` 防护，外层 catch 在响应头已经发出时改为 `response.destroy()`；否则下载中断（浏览器取消、磁盘错误）会触发 `ERR_HTTP_HEADERS_SENT` 覆盖真实错误。

### 测试

- 新增 3 项：下载正常路径（200、类型、`attachment; filename="trip.dshpkg"`、长度与正文一致）、包不存在（404 `NOT_FOUND`）、artifact id 越界（400 `BAD_ARTIFACT`）。全量 46 项。

### 文档

- 双语 README 的面板说明与 HTTP API 表补上「下载 / download」。
- 两张已脱敏的面板截图并入仓库 `assets/`（导出卡片 + 包列表、上传 / 导入 / 局域网分享 / 备份），仓库根新增 `screenshots.json` 声明这两张图，供插件市场详情页展示；`package.json` 的 `files` 加入 `assets`，下一次发版起 npm 页面里的 README 截图才不会 404。
- 脱敏说明：主目录路径里的用户名改为 `you`，分享链接的内网 IP、端口与 32 位 token 换成示例值。

## 0.1.3 — 2026-10-18

修一个只在「同机同主目录」导入时才会触发的崩溃：安装其实已经成功，但 bootstrap CLI 在打印结果时把 `null` 当对象读，直接抛 `TypeError`。无 API／包格式变更，`dsh-portable/1` 与 0.1.x 互通。

### 修复

- **同机导入（源 home 与目标 home 相同）时 bootstrap 装完就崩**：`lib/installer.mjs` 只在「包内记录的源 home ≠ 本机 home」时才做路径重写，其余情况把 `report.rewrites` 留成 `null`；而 `bootstrap/bootstrap.mjs` 无条件读 `result.rewrites.files.length`，于是在**文件已全部落盘之后**抛 `TypeError: Cannot read properties of null (reading 'files')`，让用户以为导入失败。现在改为区分两种情况打印：有重写时报「N 个文件 M 处路径」，没有时明确说 `none (package was already built for <home>)`。

### 测试

- 新增 1 项：`test/installer.test.mjs` 用同一主目录既导出又导入，断言 `report.rewrites === null` 且文件照常落地（回归上面那个崩溃）。全量 43 项。

### 验证

- 空机器全链路手测：在临时 home 里造「源机器」目录树并打包 → 用一个**完全空白**的新 home 跑 `node bootstrap/bootstrap.mjs install <pkg> --home <新home> --profile desktop --yes` → 输出 `applied AGENTS.md, hooks, profiles`、`rewrites 3 files, 1 paths`；新 home 里 `profiles/desktop/node_modules/dsh-portable/index.js` 就位、`cordis.patch.yml` 里的旧 home 全部换成本机 home。
- 无 Node 的机器也能跑：`ELECTRON_RUN_AS_NODE=1` + `DeepSeek Harness.exe` 可当 Node 24.21.0 用，实测能执行 `bootstrap.mjs --help`（exit 0）。
- 插件自身可从包里捞出来再跑：`tar -xzf <pkg> -C <kit> profiles/<p>/node_modules/dsh-portable` 抽出插件（含 `bootstrap/install.ps1`），再用它导入同一个包。

## 0.1.2 — 2026-10-18

修两个只在真机上才会撞到的读取缺陷：包内 manifest 被多包了一层，导致「查看包」和「包元信息」两个入口都拿不到 roots。无 API／包格式变更，`dsh-portable/1` 与 0.1.0／0.1.1 互通。

### 修复

- **`portable_inspect` 与 `GET /artifacts/meta` 都无法列出包内根目录**：`readManifest()` 返回的是 `{ manifest, raw }`，两处调用点却把整个返回值当成 manifest 用，于是 `manifest.roots` 为 `undefined`，模型工具直接抛 `Cannot read properties of undefined (reading 'map')`，HTTP 入口则把 `raw`（整份 manifest 原文）多包一层返回。现在两处都显式取 `.manifest`，并让 `inspectPackage` 在缺少 manifest 时报可读错误（`lib/tools.mjs`、`lib/routes.mjs`）。
- **元信息响应补 `roots`**：`GET /artifacts/meta` 现在除 `manifest` 外再返回拍平后的 `roots`（`{id, logical, files, bytes}`），与面板和模型工具用同一份形状。

### 测试

- 新增 2 项：`test/inspect.test.mjs` 用真包跑 `createTools().inspectPackage`（断言 roots 是数组而不是 worker 包装对象）、`test/routes.test.mjs` 用 `writePackage` 造真包验证 `/artifacts/meta`。全量 42 项。
## 0.1.1 — 2026-10-18

修一个会把面板变成「能看不能点」的安装陷阱，并把那种状态下甩给用户的裸状态码换成人话。无 API 变更、无包格式变更，`dsh-portable/1` 与 0.1.0 互通。

### 修复

- **面板在宿主端未加载时只显示 `HTTP 404`**：客户端 bundle 与宿主半边是分开加载的，宿主半边缺失时（插件没装完、被 `npm install` 清掉、或装好后还没重启 DSH）六个卡片照常渲染，但每个请求都拿 404，用户只看到一行红字。现在 `404` 提示「宿主端未加载：插件可能没装完，或者装好后还没重启 DSH」，`403` 提示「请求被宿主拒绝：请在 DSH 窗口里打开这个面板」，其余状态码仍回落到 `HTTP <code>`；文案随宿主语言切换（`lib/client.js` 的 `describeFailure`）。
- **安装文档漏了「必须登记为依赖」**：把包目录手工拷进 `profiles/<p>/node_modules` 也能跑，但该 profile 下一次 `npm install` 会把未声明的包当 extraneous 清掉，插件随后静默失效、面板只剩 404。README 双语在安装章节写明：用 `dsh plugin add` 或 `npm install` 写进 `dependencies`，不要手工拷贝。

### 安全加固

- 错误提示只暴露宿主已经返回的状态码语义，不回显请求路径、包名或文件系统路径。

## 0.1.0 — 2026-10-18

首个可用版本：把一台机器上正在工作的 DSH 主目录整体打包成单个 `.dshpkg` 文件，在另一台机器上离线还原；也支持在线（HTTP 上传 / 一次性局域网分享）传输。

### 新增

- **打包格式** `.dshpkg`：基于标准 tar（PAX 长路径）+ gzip，manifest 为包内第一条目 `.dsh-portable/manifest.json`，格式标识 `dsh-portable/1`。任何 `tar -xzf` 都能直接打开，不依赖本插件也能取证。
- **采集白名单**（`lib/collect.mjs`）：profile（`profiles/<name>`，含已装插件与 `node_modules`）、`skills`、`skills-disabled`、`hooks`、`storages`、task-board、todo-board、dsh-builtin-browser-host、`AGENTS.md`、sessions、dsh-runtimes、`.credentials.yaml`。白名单之外的路径永不进包。
- **两级体积开关**：`includeNodeModules`（默认开）、`includeSessions`/`includeRuntimes`/`includeCredentials`/`includeBackups`（默认关）、`includeSourceMaps`（默认开）。
- **两阶段导入**：`preview` 只读包内 manifest 并统计每个顶层项的文件数、字节数、目标机是否已存在，零写入；`install` 才落盘，且解包到 `<DSH_HOME>/portable-staging/<stamp>` 暂存区，全部校验通过后才逐项搬入目标。
- **merge / replace 两种模式**：merge 只增不减（同名文件覆盖、目标机独有文件保留）；replace 先把目标目录整体移到 `portable-backups/<stamp>/replaced/` 再落盘。
- **安装前自动备份**：`profiles/<p>/cordis.patch.yml`、`cordis.yml`、`package.json`、`pnpm-workspace.yaml`、`hooks/hooks.json`、`hooks/settings.json` 六处关键配置先备份到 `<DSH_HOME>/portable-backups/<stamp>`，保留最近 5 份。
- **路径重写**（`lib/rewrite.mjs`）：只改上述 6 个配置文件里的原机器主目录路径（`C:\\Users\\me\\.dsh`、`/home/me/.dsh`、JSON 转义形态三种写法），不碰插件包内部文件，避免破坏第三方包的完整性校验；`package.json` 的 `dependencies`/`dsh.profile.bundles` 按目标机现状合并，缺的 bundle 只告警不删。
- **profile 改名**：包内 profile 名与目标机不同时，解包后自动重命名目录并同步配置里的引用。
- **后台任务**（`lib/jobs.mjs`）：导出/预览/导入走 worker_threads，主线程只轮询进度；同一时刻只允许一个重任务，第二个请求返回 `JOB_BUSY`。
- **HTTP API**：`/dsh-portable/api` 下 16 个端点（status/profiles/jobs/export/artifacts/import/preview/backups/share/upload 等），鉴权复用宿主的 `connection.requestRejection`，回环地址兜底。
- **设置页面板**：DSH 设置 → 便携迁移，六个卡片区（导出、包列表、上传、导入、局域网分享、备份），中英双语。
- **模型工具**：`portable_export`、`portable_inspect`、`portable_import`（缺 `confirm` 时自动降级为 dry-run）、`portable_share`。
- **一次性局域网分享**：`/d/<token>` 单文件下载，支持 Range/HEAD，默认 1 次下载、60 分钟过期，过期或已用完返回 410。
- **无宿主引导安装**：`bootstrap/install.ps1`、`bootstrap/install.sh`、`bootstrap/bootstrap.mjs`，目标机没装 DSH 时也能解包。
- 测试 40 项（tar 11、archive 5、installer 5、jobs 2、routes 11、share 6），含 PAX 分块解析、单次下载计数、410 语义等回归用例。

### 修复

- **tar 解析器在 PAX 长路径后错位**：PAX 扩展头正文长度不是 512 的整数倍时，原先解析完不跳过 padding，导致其后所有条目头错位，报 `tar header checksum mismatch`。改为解析后走增量 pad 模式，`parsePax` 改成按长度前缀逐条解析（原按换行切分会拆坏含换行的值）。新增两条回归测试（对齐、23 字节分块）。
- **打包中文件变短**：tar 头已承诺长度，文件在读取期间变短会写出损坏的包；改为补零并记 warning。
- **流错误被吞**：导出失败时 `pipeline` 无人监听会抛未捕获的 `ERR_STREAM_PREMATURE_CLOSE`，掩盖真实错误；改为挂 `finished.catch` 并重写为带条目名的报错。
- **打开失败即中止**：单个文件打不开时 tar 头已经发出，继续写会损坏整包；改为先开句柄再写头，失败则跳过并记 warning。
- **分享下载计数不生效**：计数挂在 source 的 `end` 事件上时 `response.writableFinished` 恒为 false，改为 `response.on('finish')`；206 续传不消耗下载次数。
- **未知分享 token 语义**：已失效/已用完的 token 返回 410 而不是 404，客户端能区分"过期"和"不存在"。

### 安全加固

- **不按路径寻址**：HTTP API 与模型工具都只接受 `artifactId`（如 `exports:foo.dshpkg`），拒绝 `/`、`\\`、`..` 和控制字符，模型无法用它读写任意文件。
- **导入需二次确认**：`POST /import` 缺 `confirm:true` 直接返回 400 `CONFIRM_REQUIRED`；`portable_import` 工具缺 `confirm` 时只做 dry-run。
- **解包防护**：条目数上限 200000、单文件 2GB、总解压 8GB、压缩比上限 200（输出超 64MB 后才生效）、`flags:'wx'` 不覆盖、`safeJoin` 阻止 `..` 逃逸、符号链接拒绝绝对路径和 `..`，失败降级为 warning 而非中断。
- **凭据默认不进包**：`.credentials.yaml` 只有显式勾选才打包；打包纯本地操作，不上传任何数据。
- **上传限流**：`PUT /upload/<name>` 流式落盘，上限 8GiB，先写 `.part` 再 rename，名字经 `safePackageName` 校验。
- **分享默认收紧**：1 次下载 + 60 分钟过期，TTL 夹在 1 分钟到 24 小时之间；`retire` 集合记录已失效 token（上限 512，FIFO）以区分 410/404。
