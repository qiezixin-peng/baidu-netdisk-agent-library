# Agent 操作约定

本项目用于索引和检索用户有权访问的百度网盘分享资料。

- 唯一允许要求用户操作的环节是：百度官方页面上的扫码登录。除此之外，链接提交、提取码处理、目录与压缩包索引、检索、预览、筛选、下载及错误恢复全部由 Agent 完成。
- 接手任务先运行 `node src/cli.mjs doctor`，根据 `issues`、`readyForFastImport` 和 `readyForDownload` 决定下一步，不要让用户人工排查项目状态。
- Agent 开始任务时运行 `node src/cli.mjs auth` 静默检查会话。返回 `authenticated:true` 时直接继续；返回 `needsUserAction:"scan_baidu_qr"` 时才把百度官方登录页交给用户。用户确认扫码完成后，Agent 再运行一次 `auth` 并接管同一个 TaskSpace。
- 目录索引优先检查 `node src/cli.mjs fast-status`。开放平台应用已经配置但尚未授权时运行 `node src/cli.mjs fast-auth`；用户只扫描百度官方 OAuth 二维码，授权确认和 Token 换取由 Agent 完成。OAuth 与普通网盘页面复用同一 TaskSpace，一次登录后不重复要求扫码。
- 账号不是固定绑定。检索、预览、小型索引和 `plan` 继续使用当前账号。只有大型导入进入 `waiting_svip`，或 `download` / `download-run` 返回 `needsUserAction:"scan_svip_qr"` 时，才运行 `account-switch` 并交出二维码页面；用户确认扫码后运行 `account-bind`，它会强制用临时 SVIP 重签开放平台 Token。导入任务随后用 `job-resume <ID>` 恢复；下载必须使用首次返回的 `download-run <任务ID>`，不得要求用户重新选择。不得要求用户重新申请开发者、重建应用或粘贴凭据。
- 扫描器输出 0 条时，除非百度页面明确显示真实空目录，否则必须标记 `empty_scan_unverified`，不得写成 `complete`；后台 Worker 只能导入本轮实际生成的完整结果，不能复用旧 JSONL 冒充本轮成功。

- 默认只读。用户提交分享链接即授权为索引目的在隔离的 `Agent自动导入_*` 目录中临时转存，并在索引结束后删除这些 Agent 创建的临时副本；只有用户在下载清单中明确选择的条目才可下载。
- 不把 Cookie、BDUSS、STOKEN、短信验证码或二维码登录结果写入源码、日志或索引数据库。
- 登录只通过百度官方页面完成；若既有会话失效，Agent 才请求用户在百度官方页面扫码或使用手机号验证码。
- 扫描结果写入 `data/import/*.jsonl`，随后用 `node src/cli.mjs import <文件>` 导入。
- Agent 查询只使用 CLI 或 `/api/agent/*` JSON API，不把前端页面作为工作流入口。
- 搜索必须同时检查普通文件和 `archiveEntries`；压缩包内部使用 `archive <itemId> [包内路径]` 或 `/api/agent/archive` 递归浏览。
- 压缩包目录优先通过百度官方 `zipfile/list` 元数据接口索引；ZIP 使用 `zip.js` 读中央目录，RAR3/RAR5 使用 `@mary/rar` 跳过数据区，均不下载整包。
- 新分享链接优先通过 `node src/cli.mjs add-share <链接> <提取码>` 创建任务；也可调用 `/api/imports`。
- 导入任务优先把分享根目录临时转存到 `/apps/{appName}/Agent自动导入_{jobId}`，使用官方 `listall + recursion=1` 快速递归导出；失败时自动回退逐目录扫描，任务结束后删除 Agent 创建的隔离副本。
- 下载前用 `plan item:<ID> entry:<ID>` 或 `/api/agent/download-plan` 固化选择范围；不得把“预览”当作下载授权。用户明确要求下载后，优先运行 `download item:<ID> entry:<ID>`；失败任务用 `download-run <任务ID>` 续跑。
- 普通文件使用官方 dlink 流式下载，失败时由 BaiduPCS-Go 断点续传；ZIP 用 zip.js Range 定点提取；RAR 只在用户选中包内条目后下载到任务临时目录，再由 node-unrar-js 选择性解压。任务临时目录及临时 BaiduPCS-Go 登录配置必须在任务后删除。
- 可重建调试输出放在工作区 `临时文件`，不要写入项目根目录。

常用命令：

```powershell
node src/cli.mjs init
node src/cli.mjs doctor
node src/cli.mjs auth
node src/cli.mjs fast-status
node src/cli.mjs fast-auth
node src/cli.mjs account-status
node src/cli.mjs account-switch
node src/cli.mjs account-bind
node src/cli.mjs job-resume 1
node src/cli.mjs add-share "https://pan.baidu.com/s/..." "提取码"
node src/cli.mjs job 1
node src/cli.mjs wait 1 3600
node src/cli.mjs status
node src/cli.mjs search "歌曲名"
node src/cli.mjs plan item:123 entry:456
node src/cli.mjs download item:123 entry:456
node src/cli.mjs download-run 1
node src/cli.mjs browse 1 "/1 丁登音乐 歌曲物料"
node src/cli.mjs archive 9 "/"
node src/cli.mjs archive-queue "data/runtime/archive-queue.json"
node src/cli.mjs import "data/import/source-1.jsonl"
node src/cli.mjs import-dir "data/import" "archive-"
node scripts/process-import-jobs.mjs
```
