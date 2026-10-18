# CHANGELOG

本文件记录 dsh-portable 的所有重要变更，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
