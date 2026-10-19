# dsh-portable

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的离线 / 在线导入导出插件：把一台机器上正在工作的 DSH 主目录打包成单个 `.dshpkg`，在另一台机器上还原 —— 不需要联网、不需要 `pnpm install`、不需要手工改路径。**

[English](README.md) · [CHANGELOG](CHANGELOG.md) · [发布流程](PUBLISHING.md) · [接力文档](HANDOFF.md)

---

## 为什么要有它

把 DSH 环境搬到另一台机器，麻烦有三层：

1. **一个能用的 profile 不止一个文件。** 它是 `profiles/<name>/` 加上**带 `node_modules` 的插件**、技能、hooks、任务板、存储、`AGENTS.md`、已下载运行时、会话日志。
2. **插件是靠 pnpm 联网装的。** 内网机、被锁的办公电脑、代理坏掉的机器根本跑不了 `dsh plugin add`。
3. **配置里写死了绝对路径**（`C:\\Users\\me\\.dsh`、`/home/me/.dsh`）和 profile 名。直接复制目录树，换台机器启动就是一堆坏掉的插件路径。

dsh-portable 三件事一起解决：把白名单内的根打成单个自描述归档；任何时刻都不走出白名单；导入时只重写真正含本机路径的那六个配置文件。

## 包里装什么

| 根 | 路径 | 默认 |
| --- | --- | --- |
| profile | `profiles/<name>`（配置**和**插件的 `node_modules`） | 总是 |
| skills | `skills` | 总是 |
| skills-disabled | `skills-disabled` | 总是 |
| hooks | `hooks` | 总是 |
| storages | `storages` | 总是 |
| 任务板 | task-board / todo-board 存储 | 总是 |
| 内置浏览器宿主 | dsh-builtin-browser-host | 总是 |
| 智能体指令 | `AGENTS.md` | 总是 |
| 会话日志 | sessions | 可选（`includeSessions`） |
| 运行时 | 已下载的运行时 | 可选（`includeRuntimes`） |
| 凭据 | `.credentials.yaml` | **可选，默认关闭** |
| source map | 包内 `*.map` | 默认包含（`includeSourceMaps`） |
| 备份文件 | 配置旁 `*.bak-*` | 默认不含（`includeBackups`） |

表外的路径永远不会被采集 —— 代码里不存在"把整个主目录递归复制一遍"的步骤。

## 安装

```bash
dsh plugin --profile desktop add dsh-portable
```

插件必须登记在 profile 自己的 `package.json` 里 —— `dependencies` **和** `dsh.profile.bundles` 两处都要。把包目录手工拷进 `profiles/<profile>/node_modules` 看起来能跑，但该 profile 下次执行 `npm install` 时，npm 会把没声明的包当 extraneous 删掉；那之后面板照常渲染卡片，但每个请求都回 `404`。`dsh plugin add`（或在 profile 里 `npm install dsh-portable`）会把这两处一起写好。

然后打开 **DSH 设置 → 便携迁移**。设置页区块注册在 `settings.section`、顺序 70，中英文随宿主语言自动切换。

不按按钮就什么都不会写进 DSH 主目录。

## 面板怎么用

六个卡片区：

1. **导出** —— 勾选可选根、给文件起名、点导出。打包跑在 worker 线程里；进度条实时显示条目数，20 MB / 14 000 条目的包约 3 秒。
2. **包列表** —— `<DSH_HOME>/dsh-portable/exports` 下的所有 `.dshpkg`，显示大小、条目数、manifest 摘要，按钮为 导入 / 分享 / 删除（删除需二次确认）。
3. **上传** —— 选一个 `.dshpkg`，流式落盘（先写 `.part` 再改名），2 GB 的包也不会进内存。
4. **导入** —— 选 merge 或 replace，**先预览**（零写入），再点导入（显式确认）。结果会列出落地项、被重写的文件、备份位置与 warning。
5. **局域网分享** —— 把包发布成一次性下载链接（`http://<内网IP>:<端口>/d/<token>`）。默认 **1 次下载、60 分钟**，支持 Range/HEAD，过期或下完返回 410。无中继、无云端、无账号。
6. **备份** —— 导入前自动生成的备份（`<DSH_HOME>/portable-backups/<stamp>`），保留最近 5 份。

## 界面截图

截自 DSH 设置面板；图中的主目录用户名与局域网分享链接均为示例值。

![导出卡片与包列表](assets/panel-export.png)

![上传、导入、局域网分享与备份](assets/panel-import-share.png)

## HTTP API

前缀：`/dsh-portable/api`。除下载路由与上传流式路由外，响应都是 JSON。鉴权复用宿主的 `connection.requestRejection`（cookie + 可信来源），该服务不存在时降级为仅回环地址可访问。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 宿主信息、包数量、当前任务、分享服务状态 |
| GET | `/profiles` | 本机 DSH 主目录里的 profile |
| GET | `/jobs` | 最近的任务（导出 / 预览 / 导入） |
| GET | `/jobs/detail?id=` | 单个任务的实时进度 |
| POST | `/jobs/cancel` | 取消任务 |
| POST | `/export` | 开始导出 |
| GET | `/artifacts` | 可导入的包列表 |
| GET | `/artifacts/meta?id=` | 单个包的 manifest |
| POST | `/artifacts/delete` | 删除包（UI 里二次确认） |
| PUT | `/upload/<name>` | 上传包，流式落盘 |
| POST | `/import/preview` | 两阶段安装第一阶段（零写入） |
| POST | `/import` | 两阶段安装第二阶段（必须 `confirm:true`） |
| GET | `/backups` | 自动备份列表 |
| POST | `/share` | 生成一次性局域网下载链接 |
| GET | `/share` | 列出有效链接 |
| POST | `/share/remove` | 撤销链接 |

**所有涉及"哪个包"的参数都只接受 `artifactId`（如 `exports:machine-20261018.dshpkg`），绝不接受文件路径。** `/`、`\\`、`..` 与控制字符一律拒绝，所以模型或网页都没法借这个插件读写任意文件。

## 模型工具

注册到宿主的 tools 服务（服务不存在时静默跳过）：

| 工具 | 行为 |
| --- | --- |
| `portable_export` | 打包当前 profile，返回 id、大小、条目数、各根统计 |
| `portable_inspect` | 只读 manifest，不导入 |
| `portable_import` | **不带 `confirm:true` 就是 dry-run**；带上才真正两阶段安装 |
| `portable_share` | 生成一次性局域网链接（1 次下载、60 分钟） |

## 无宿主引导安装（目标机没装 DSH）

```bash
# Windows
powershell -ExecutionPolicy Bypass -File bootstrap\install.ps1 preview .\machine.dshpkg
powershell -ExecutionPolicy Bypass -File bootstrap\install.ps1 install .\machine.dshpkg --yes

# macOS / Linux
sh bootstrap/install.sh preview ./machine.dshpkg
sh bootstrap/install.sh install ./machine.dshpkg --yes
```

参数：`--home <目录>`（默认 `$DSH_HOME` 或 `~/.dsh`）、`--profile <名>`、`--mode merge|replace`、`--keep <n>`、`--yes`。退出码：`0` 成功、`1` 失败、`2` 用法错误；非 TTY 且没有 `--yes` 时拒绝写入。

## 包格式

`.dshpkg` 就是 gzip 压缩的 tar，manifest 是**第一条目**：

```text
.dsh-portable/manifest.json
profiles/desktop/...
skills/...
hooks/hooks.json
...
```

```json
{
  "format": "dsh-portable/1",
  "createdAt": "2026-10-18T02:11:03.000Z",
  "tool": { "name": "dsh-portable", "version": "0.1.0" },
  "source": {
    "hostname": "WORKSTATION",
    "platform": "win32",
    "arch": "x64",
    "node": "v22.23.2",
    "dshHome": "C:\\Users\\me\\.dsh",
    "profile": "desktop"
  },
  "options": { "includeNodeModules": true, "includeSessions": false },
  "stats": { "entries": 13774, "files": 13482, "dirs": 292, "links": 0, "bytes": 20664511 },
  "roots": [{ "id": "skillsDisabled", "logical": "skills-disabled", "files": 13193, "bytes": 44615569 }]
}
```

因为就是普通 tar，`tar -xzf machine.dshpkg` 在任何机器上都能直接看包里的内容 —— 哪怕那台机器从没听说过 DSH。长路径走 PAX 扩展头，读取端是增量解析，PAX 正文跨 chunk 也能正确处理。

## 导入流水线

```text
预览:  读 manifest ──► 每个顶层项的文件数/字节数/目标机是否存在 ──► 报告（零写入）
安装:  解包到 <home>/portable-staging/<stamp>
       ──► 目标 profile 名不同则重命名目录
       ──► 重写 6 个配置文件里的本机路径
       ──► 这 6 个文件备份到 <home>/portable-backups/<stamp>
       ──► 逐顶层项落地（merge：只增不减；replace：先移走再落）
       ──► 清理旧备份 ──► 删除暂存区
```

路径重写刻意收窄：只碰 `profiles/<p>/cordis.patch.yml`、`cordis.yml`、`package.json`、`pnpm-workspace.yaml`、`hooks/hooks.json`、`hooks/settings.json`。**插件包内部不重写**，第三方完整性校验与 source map 不受影响。

## 安全模型

- **白名单采集。** 代码里不存在递归遍历整个主目录的逻辑。
- **只认 artifactId，不认路径。** 见上。
- **导入必须确认。** 缺 `confirm:true` 的路由返回 `400 CONFIRM_REQUIRED`；模型工具默认 dry-run。
- **解包防护。** 200 000 条目上限、单文件 2 GB、总解压 8 GB、压缩比 200（输出超 64 MB 后才生效）、`wx` 不覆盖、`safeJoin` 挡 `..`、符号链接为绝对路径或越界时拒绝。
- **写之前先备份。** 六个配置文件先复制到备份目录；replace 模式把整个目录移进 `portable-backups/<stamp>/replaced/`，不是删除。
- **凭据默认不进包。** `.credentials.yaml` 只有显式勾选才打包，面板上的勾选框直接标注风险。导出是纯本地操作，不上传任何数据。
- **分享链接范围极小。** 一次下载、60 分钟、单文件、token 门禁，之后 410。没有目录列举，没有中继。

## 开发

```bash
npm test          # 43 项：tar、archive、installer、jobs、routes、share、inspect
npm run check     # 语法检查 + import 冒烟
npm run sync      # 把本包拷进某个 profile 的 node_modules 做真机联调
npm run verify    # 发布门禁：版本一致、文件清单、测试
```

**没有构建步骤**：`index.js`（宿主端）、`lib/client.js`（浏览器端 bundle，纯 `React.createElement`）、`lib/*.mjs` 都是直接发布的源码。这是刻意约束 —— 插件必须能在包版本未知的宿主上加载，所以客户端半边只依赖 `react` 和 `--dsw-alias-*` CSS 变量。

## 兼容性

- DSH `>= 0.1.7-rc.2`
- Node `^22.15.0 || >= 24.0.0`
- Windows / macOS / Linux（Windows 长路径走 `\\?\` 前缀）

## 已知限制

- 会话日志默认不进包，因为里面有对话内容。
- 包是 tar，不加密也不签名；含凭据时请放在加密介质上。
- 导入只能按顶层根整体 merge 或 replace，v0.1.x 没有单文件选择器。
- 指向 DSH 主目录之外的符号链接会被打进包，但在 Windows 上没有开发者模式时无法重建 —— 这种情况记 warning，不中断导入。

## 许可

MIT，见 [LICENSE](LICENSE)。
