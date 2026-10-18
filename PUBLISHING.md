# 发布与上架流程（PUBLISHING）

本文件是 dsh-portable 的**对外发布门禁**：npm 发包、GitHub 仓库、插件市场收录三件事各自的完整步骤与检查项。
命令按 Windows PowerShell 写，Linux/macOS 把路径换成 POSIX 即可。

---

## 0. 发布前检查（每次发版都做）

```powershell
cd 'F:\AI\DeepSeek haness\workspace\dsh-portable'
npm test          # 必须全绿
npm run check     # 语法 + import 冒烟
npm run verify    # 版本一致、files 清单、测试、包内容预览
```

四文档版本必须一致：`package.json` 的 `version`、`CHANGELOG.md` 的最新标题、`README.md`/`README.zh-CN.md` 里出现的版本号、`HANDOFF.md` 末尾的版本行。`npm run verify` 会自动核对前两项。

**版本号规则**：新增功能 → minor；仅修复 → patch；破坏包格式或导入语义 → major。
包格式标识是 `dsh-portable/1`，格式没变就不要动它。

## 1. GitHub 仓库（首次）

```powershell
git init
git add -A
git commit -m "feat: 初始版本：DSH 主目录离线/在线导入导出"
gh repo create wjf1/dsh-portable --public --source . --remote origin --push --description "Offline and online export/import for DeepSeek Harness"
gh repo edit wjf1/dsh-portable --add-topic dsh-plugin --add-topic deepseek-harness --add-topic migration --add-topic backup
```

- **必须加 `dsh-plugin` topic** —— 市场收录要求。
- 仓库需**创建满 1 天**才能投稿（CI 自动检查）。
- 本机 `gh` 登录账号是 `wjf1`；`package.json` 里的 `repository`/`homepage`/`bugs` 必须与之一致。

## 2. npm 发包

**不要给 npm 配代理**（这条是本机实测结论，与早期文档相反）：`registry.npmjs.org` 直连正常，而本机代理 `http://127.0.0.1:7900` 会让 TLS 握手失败（git 侧同样报 `schannel: failed to receive handshake`）。保持 `npm config get proxy` = `null`，直接登录即可：

```powershell
npm login            # 交互式，浏览器/OTP 完成授权
npm whoami           # 应回 wjf1
```

> 当前状态（2026-10-18）：本机**没有任何 npm 凭据**——`~/.npmrc` 只有 `prefix=E:\OpenCode`，无 token、无 `NPM_TOKEN` 环境变量，`npm publish` 报 `ENEEDAUTH`。发布前必须先完成上面两步，或把 automation token 写进 `//registry.npmjs.org/:_authToken=...`。

```powershell
npm pack --dry-run        # 核对包里到底有哪些文件
npm publish               # publishConfig 已设 access=public + registry.npmjs.org
```

- 包名 `dsh-portable`（registry 查询为 404，即未占用）。若已被抢，改用 `@wjf1/dsh-portable` 并同步改 `cordis.patch.yml` 的 `name`。
- `files` 白名单决定入包内容：`index.js`、`lib`、`bootstrap`、`cordis.patch.yml`、四份文档、`LICENSE`。测试与 `scripts` 不进包。
- 不要发包内不该有的东西：`.env`、`_e2e`、`_tmp_*`、用户真实 `DSH_HOME` 的副本。

## 3. Tag 与 GitHub Release

```powershell
git tag -a v0.1.0 -m "v0.1.0: 首个版本：DSH 主目录打包与离线还原"
git push origin main --tags
```

Release 标题必须与 tag subject **逐字一致**：`v0.1.0: 首个版本：DSH 主目录打包与离线还原`。
正文按 `### 新增` / `### 修复` / `### 安全加固` 分类，与 `CHANGELOG.md` 对齐。CI（`.github/workflows/release.yml`）会在 tag 推送后自动跑测试并建 Release；若标题不合规，用 `gh release edit` 立刻改正。

## 4. 插件市场上架

市场（`dshmarket` 面板）读的是**策展清单**：`https://awesome-dsh-plugin.com/plugins.json`，由 GitHub 仓库 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 生成。**上架 = 向该仓库提一个 PR**，不是自己上传。

### 4.1 收录硬性要求

| 要求 | 本插件状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | ✅ `./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml`（`- insert: - id/name`） | ✅ |
| 仓库有真实可用代码，非占位 | ✅ 40 项测试 |
| 仓库创建满 1 天 | ⏳ 2026-10-18 建仓，次日起可投 |
| 仓库加 `dsh-plugin` topic | ✅ 已加（dsh-plugin / deepseek-harness / migration / backup） |
| 描述真实、无营销词 | ✅ 见 `market/data/plugins/wjf1__dsh-portable.yml` |

> 最常见的被拒原因是**只声明了 `dsh.client`**——那样无法用 `dsh plugin add` 安装。本插件两样都有。

### 4.2 PR 内容：一个文件

路径必须是 `data/plugins/<owner>__<repo>.yml`，内容即本仓库 `market/data/plugins/wjf1__dsh-portable.yml`：

```yaml
url: https://github.com/wjf1/dsh-portable
name: wjf1/dsh-portable
category: tools
description:
  en: 'Export a whole working DSH home — profile, installed plugins with their node_modules, skills, hooks and task boards — into one .dshpkg tar and import it on another machine without network or pnpm; also streams over HTTP or a one-shot LAN link.'
  zh: '把整套可用的 DSH 主目录——profile、带 node_modules 的已装插件、技能、hooks 与任务板——打包成单个 .dshpkg，在另一台机器上免联网、免 pnpm 还原；也支持 HTTP 上传与一次性局域网链接。'
```

操作：

```powershell
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
# 把 market/data/plugins/wjf1__dsh-portable.yml 复制到 data/plugins/
git checkout -b add-dsh-portable
git add data/plugins/wjf1__dsh-portable.yml
git commit -m "Add wjf1/dsh-portable"
git push -u origin add-dsh-portable
gh pr create --title "Add wjf1/dsh-portable" --body-file ..\dsh-portable\market\PR.md
```

- **只加一个文件**，不要改生成的 README、不要动别人的条目。
- 描述里出现 `: `（冒号加空格）必须加引号，否则 YAML 会当成嵌套键（上面的写法已加引号）。
- 分类选**最贴近**的：本插件与 `dsh-config-manager`（分类 `tools`）最接近，故取 `tools`；分类不准不会被打回，维护者会直接改。

### 4.3 评审会看什么（提前自查）

1. 代码是否名副其实——描述里提到的每个能力都要在代码里找得到。
2. 是否与已有条目重复——`dsh-config-manager` 做的是**配置级**备份（settings/plugins/MCP/skills），本插件做的是**整目录级**搬运（含插件 `node_modules`、任务板、离线 bootstrap、一次性局域网链接）。PR 正文要写清这个区别。
3. 源码有无可疑行为——本插件会读写 `DSH_HOME`、会开一个本地 HTTP 服务（仅回环 + 局域网一次性下载）。**凭据文件仅显式勾选才入包**，PR 正文要主动说明，这是清单里 `capabilityRedLines` 的判定点。

### 4.4 合并后验证

```powershell
gh pr view --web
(Invoke-RestMethod 'https://awesome-dsh-plugin.com/plugins.json').plugins | Where-Object { $_.name -eq 'dsh-portable' }
```

页面应出现在 `https://awesome-dsh-plugin.com/p/wjf1/dsh-portable/`，安装命令为：

```bash
dsh plugin --profile desktop add dsh-portable
```

## 5. 发布后回归

在干净的 `DSH_HOME` 上装一次，确认三件事：面板能打开、导出能出包、`bootstrap/install.sh preview` 能读到 manifest。

```powershell
$env:DSH_HOME = 'C:\tmp\fresh-dsh'
dsh plugin --profile desktop add dsh-portable
```

## 6. 撤回

- npm：`npm unpublish dsh-portable@0.1.0`（24 小时内可用；之后只能 `deprecate`）。
- 市场：向 awesome-dsh-plugin 提 PR 删除 `data/plugins/wjf1__dsh-portable.yml`。
- 已装用户：`dsh plugin --profile desktop remove dsh-portable`。
