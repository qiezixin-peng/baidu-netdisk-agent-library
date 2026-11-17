# 百度网盘物料库

一个供 Agent 直接调用的本地资料后端。用户只需在对话中提供百度网盘分享链接和提取码；Agent 负责递归导入普通目录与 ZIP/RAR 内部目录、统一检索、预览、选择并把目标文件下载到本地。前端页面不是正式工作流入口。

> 本仓库只包含程序源码和脱敏配置模板。真实百度分享链接、提取码、OAuth AppKey/Secret、Token、Cookie、本地索引数据库、下载内容及第三方二进制均不会提交到 GitHub。

## 适用场景与边界

- 面向 Agent 自动操作，不以人工前端为主要入口。
- 普通账号可完成链接导入、目录与压缩包索引、搜索、预览和选择；大型分享超过普通账号转存限制时，任务会暂停等待临时 SVIP。
- SVIP 不固定绑定，只在大型快速转存或正式下载时按任务扫码。换入新账号只需授权既有百度开放平台应用，不需要重新申请开发者。
- ZIP 可通过 HTTP Range 定点读取目录和所选条目；RAR 因固实压缩限制，选择包内文件后可能需要先下载整个 RAR 到任务临时目录。
- 百度接口、风控、在线解压支持和会员规则可能变化；项目会保留错误状态并等待恢复，不把空扫描误报为完成。

## 安装与私有配置

要求 Windows、Node.js 22+、已安装并登录可供 Agent 使用的 `ego-browser`，以及用户自己创建的百度网盘开放平台应用。

```powershell
npm install
Copy-Item config\sources.example.json config\sources.json
Copy-Item config\baidu-open.example.json config\baidu-open.local.json
```

编辑以上两个本地文件。它们已被 `.gitignore` 排除。普通文件下载的 BaiduPCS-Go 兜底程序需自行放到：

```text
tools/BaiduPCS-Go/BaiduPCS-Go-v4.0.2-windows-x64/BaiduPCS-Go.exe
```

当前自动化脚本针对本机 Windows 工作区 `D:\三喜\Agent工具\百度网盘物料库` 配置；复制到其他路径部署时，需要同步调整 `scripts/*.mjs` 中的工作区绝对路径。

## Agent 最短工作流

```powershell
node src/cli.mjs doctor
node src/cli.mjs auth
node src/cli.mjs add-share "https://pan.baidu.com/s/...?pwd=xxxx" "xxxx"
node src/cli.mjs wait <任务ID> 3600
node src/cli.mjs search "目标关键词"
node src/cli.mjs inspect item:<普通文件ID> entry:<ZIP包内条目ID>
node src/cli.mjs download item:<普通文件ID> entry:<包内条目ID>
```

`add-share` 会返回 JSON 格式的 `jobId` 并自动启动后台 Worker。Agent 也可用 `job <任务ID>` 非阻塞查询进度。`search` 会同时返回普通文件、压缩包内部条目以及 `coverage`；只有 `coverage.exhaustive=true` 时，Agent 才能把“没有命中”解释为完整资料库中确实不存在。

`doctor` 是 Agent 的统一启动自检：一次返回当前账号会员等级、开放平台授权、普通来源异常、压缩包覆盖率以及待恢复任务。

## “浏览”和“内容检查”的区别

- `search`、`browse`、`archive` 和 `/api/agent/preview/:id` 返回的是元数据：名称、路径、大小、类型以及压缩包目录。
- `inspect item:<ID>` 会把一个普通文件临时读取到 `D:\三喜\临时文件`，供 Agent 真正读取文本、查看图片、分析文档或试听音频；不写入正式下载目录。
- `inspect entry:<ID>` 对 ZIP 使用 HTTP Range，只读取中央目录和所选条目的压缩字节，不下载整个 ZIP。
- RAR 包内内容检查会明确返回 `rar_preview_requires_full_archive`，因为 RAR（尤其固实压缩）通常无法可靠地只取单个成员；只有用户确认正式下载后才允许下载整个 RAR。
- 单个临时预览默认限制为 256 MiB。Agent 检查完成后运行 `preview-clean <任务ID>` 删除临时内容。
- 浏览器中断后的预览任务用 `preview-run <任务ID>` 原地恢复，不重新创建选择。

任何“看见文件内容”都必须从远端读取相应字节；本项目所说的“不下载压缩包”是指 ZIP 不下载整个包，只按需读取目标条目，而不是完全不传输数据。

项目唯一需要用户操作的地方是百度官方扫码登录。`auth` 会先静默检查既有会话；会话有效时不打扰用户，会话失效时才打开百度官方登录页并将浏览器控制权交给用户。扫码完成后，Agent 接管同一浏览器会话并完成其余所有步骤。

账号不固定：检索、预览和小型索引继续使用当前普通账号。大型分享若超过普通账号快速转存限制，导入任务会进入 `waiting_svip`，而不是直接开始长时间慢扫；正式下载也会检查会员等级。这两种情况才由 Agent 运行 `account-switch` 打开二维码，扫码后运行 `account-bind`，自动把网页会话和开放平台 Token 一并切换到临时 SVIP。开发者应用无需重建或重新认证。

## 当前能力

- 支持在本地私有配置中维护多个分享来源；仓库不附带真实分享链接或提取码。
- Agent 可提交纯链接，也可直接提交包含“链接 / 提取码”的整段百度分享文字。
- 已完整导入的重复链接默认直接复用，不会误触发全库重扫；Agent 可显式传入 `rescan: true` 重扫。
- 文件名、路径、来源、文件类型搜索。
- 文件夹、音频、压缩包和文档分类。
- 点击结果可回到百度网盘对应目录。
- Agent 可通过 CLI 或 `/api/agent/*` 查询普通目录和压缩包内部目录。
- Agent 可把普通文件和包内文件固化为持久下载任务，并自动执行或断点续跑。
- 搜索和压缩包浏览默认隐藏 `__MACOSX`、`._*` 等系统垃圾文件，可按需显示。
- CLI 和 `/api/agent/*` 返回稳定 JSON，供 Agent 编排。
- 建立索引时不下载歌曲或完整压缩包；只有用户明确要求的目标才会下载。
- 登录页只有“扫码登录”和“手机号验证码登录”；认证在百度官方页面完成。

## 可选诊断服务

日常 Agent 操作无需打开网页。需要诊断 HTTP API 时才启动：

```powershell
cd D:\三喜\Agent工具\百度网盘物料库
node src/cli.mjs init
node src/cli.mjs serve
```

服务地址为 <http://127.0.0.1:3210>。

## Agent 查询

```powershell
node src/cli.mjs status
node src/cli.mjs search "月缺"
node src/cli.mjs browse 1 "/1 丁登音乐 歌曲物料/1000月缺"
node src/cli.mjs archive 123 "/"
node src/cli.mjs inspect item:12219
node src/cli.mjs inspect entry:4988
node src/cli.mjs preview-clean 1
node src/cli.mjs plan item:12219 entry:4988
node src/cli.mjs download item:12219 entry:4988
node src/cli.mjs download-run 1
```

HTTP API：

```text
GET /api/status
GET /api/agent/search?q=月缺&type=audio&limit=100
GET /api/agent/browse?source=1&path=/1%20丁登音乐%20歌曲物料
GET /api/agent/archive?item=123&path=/
GET /api/agent/preview/123
GET /api/agent/import-jobs
POST /api/agent/download-plan
GET /api/agent/download-jobs
GET /api/agent/download-jobs/:jobId
PATCH /api/agent/download-jobs/:jobId
GET /api/open/:itemId
```

`add-share` 或导入 API 会把任务加入本地队列，并自动启动 `scripts/process-import-jobs.mjs`。该 Worker 复用已登录的 ego-browser 百度会话：先递归扫描普通目录，再索引 ZIP/RAR，最后把结果导入 SQLite。只有百度会话失效时，Agent 才需要请求用户在百度官方页面重新登录。

自动导入采用渐进式高速索引：普通目录以最多 24 路自适应并发读取；ZIP/RAR 每批最多转存 24 个、最多 12 路并行读取 Range 目录。普通目录和每个已完成压缩包都会立即进入 Agent 搜索库。接口失败时扫描器自动降低并发并退避重试。

## 建立索引

扫描脚本 `scripts/ego-export.mjs` 由 Agent 通过 ego-browser 执行。它使用已经登录的百度官方浏览器会话读取目录元数据，输出 `data/import/source-N.jsonl`。输出不包含 Cookie、BDUSS、STOKEN 或短信验证码。

导入扫描结果：

```powershell
node src/cli.mjs import data/import/source-1.jsonl
```

扫描支持限制目录数量，方便分段验证和避免触发百度风控。完整扫描应低速执行并关注接口错误。

### 压缩包内部索引

先生成待扫描队列，再让 Agent 在已登录百度的浏览器会话中运行归档索引器，最后导入结果：

```powershell
node src/cli.mjs archive-queue data/runtime/archive-queue.json
# Agent 运行 scripts/ego-index-archives.mjs
node src/cli.mjs import data/import/archive-123.jsonl
```

主方案调用百度网页自身的 `/api/zipfile/list`，只读取文件名、包内路径、类型和大小，支持百度能够在线浏览的 ZIP/RAR/7z；不会下载或解压整包。若百度接口对某个 ZIP 不可用，但 Agent 拿到支持 HTTP Range 的临时直链，可用 `scripts/index-remote-zip.mjs` 只读取 ZIP 中央目录作为兜底。

百度网页的在线解压额度不足时，使用 `scripts/ego-index-zip-via-transfer.mjs`。它会在当前账号中建立隔离的 `/Agent压缩包索引临时_20261113`，分批服务器端转存，取得官方 dlink 后：

- ZIP 仅通过 HTTP Range 读取中央目录；
- RAR3/RAR5 仅通过 HTTP Range 读取块头并跳过压缩数据；
- 每批索引完成后删除 Agent 创建的临时副本；
- Cookie、BDUSS、STOKEN 和 dlink 只存在于进程内存，不写入项目数据库或日志。

批量导入全部归档结果：

```powershell
node src/cli.mjs import-dir data/import archive-
```

搜索返回两个集合：`items` 是网盘普通文件，`archiveEntries` 是命中的压缩包内部文件，并带有 `archive_name`、`archive_path` 和 `item_id`，Agent 可继续调用归档浏览接口。

## Agent 选择性下载

- 普通文件：通过百度官方 dlink 流式下载；失败时自动调用 BaiduPCS-Go 断点续传。
- `plan` 不要求 SVIP；真正运行 `download` 时才检查 SVIP 并按需打开换号二维码。
- `download` 会先持久保存选择，再检查 SVIP；换号后用返回的 `download-run <任务ID>` 继续，不需要重新选择。`download-run` 本身也会复查会员等级。
- ZIP 包内文件：zip.js 使用 HTTP Range 只读取中央目录和所选条目的压缩数据，不下载整个 ZIP。
- RAR 包内文件：RAR 的固实压缩结构通常无法可靠远程跳取，因此仅在用户选中包内条目后下载该 RAR 到任务临时目录，再用 node-unrar-js 只解压所选路径。
- 正式输出默认位于 `D:\三喜\下载的物料\任务-<ID>`；中间文件、Cookie配置和未完成 RAR 位于 `D:\三喜\临时文件`，任务结束后清理。
- 下载任务及每个条目的状态、输出路径和错误信息均保存在 SQLite，可用 `download-jobs` 和 `download-run` 查询或续跑。

## 登录边界

本地登录页不会仿制百度登录接口，也不会要求用户粘贴 Cookie。点击登录方式后，会打开百度官方 Passport 页面：

- 扫码登录：使用百度网盘 App 扫码。
- 手机号验证码登录：验证码只输入到百度官方页面。

登录会话由浏览器保存，本项目数据库只保存文件元数据。

## 采用的开源组件

- `gildas-lormeau/zip.js`（BSD-3-Clause）：ZIP 的 HTTP Range 目录读取兜底。
- `@mary/rar`（0BSD）：RAR3/RAR5 的远程 Range 头部遍历，只读取目录所需字节。
- `qjfoidnh/BaiduPCS-Go`（Apache-2.0，v4.0.2）：普通文件下载的并行/断点续传兜底。
- `YuJianrong/node-unrar.js`（MIT 包装层及上游 UnRAR 许可，v2.0.2）：选中 RAR 包内条目后的选择性解压。
- OpenList（AGPL-3.0）：后续需要常驻部署和更多格式预览时可接入；当前不强制转存七个分享。
## 极速递归索引

项目优先使用百度开放平台官方 `listall + recursion=1`：Agent 将分享根目录临时转存到
`/apps/{appName}/Agent自动导入_{jobId}`，按服务端游标批量取得完整文件树，导入后自动删除临时副本。
开放接口未配置、授权过期或遇到权限限制时，会自动回退到原有逐目录扫描，不会让导入任务失败。

应用信息只放在被 Git 忽略的 `config/baidu-open.local.json`，格式参见
`config/baidu-open.example.json`；Token 只写入被忽略的 `data/runtime/baidu-open-token.json`，不会输出到日志或数据库。

```powershell
node src/cli.mjs fast-status
node src/cli.mjs fast-auth
node src/cli.mjs account-status
node src/cli.mjs account-switch
node src/cli.mjs account-bind
node src/cli.mjs job-resume <任务ID>
```

`fast-auth` 使用百度官方 OAuth 二维码。用户只需扫码；授权确认、Token 换取、30 天到期后的刷新均由 Agent 完成。
