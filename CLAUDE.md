# CLAUDE.md — filemanageClient

> 本文件供 Claude Code 及开发者快速了解本工程。**自动更新约定（需求2）**：
> 任何组件/lib 结构、Rust command、配置结构、交互行为的变更，**必须在同一次改动中**
> 同步更新本文件、`CHANGELOG.md`（含兼容矩阵）与三处版本号
> （package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json）。

## 工程定位

Tauri 2 + React 19 + TS 桌面客户端。两种数据来源统一在 `DataSource` 接口后：
- **本地模式**：Rust command 直接管理用户配置的本地目录（免登录，全功能）
- **服务端模式**：所有 HTTP 经 Rust `srv_call` 代理（token 注入 + 401 自动 refresh），
  大流量走专用命令（`srv_upload` 分片 / `srv_download` 流式）

## 目录结构

```
src/App.tsx            根组件：状态编排、对话框调度（Dialog 判别联合）、位置恢复
src/lib/
  datasource.ts        DataSource 接口（唯一数据访问契约）
  local.ts             本地实现（invoke fs_* 命令）
  server.ts            服务端实现（srv_call + srv_* 传输命令）
  api.ts               配置单例(loadConfig/saveConfig/active) + source() 工厂 + 分享/ACL/AI 辅助
  transfer.ts          任务注册表（入队/暂停/续传/重试 + "fm-transfer" 事件归并，
                       未入队 transferId 首个事件自动注册为展示任务）+ 订阅
  transtypes.ts        TransferTask/TransferStatus 共享契约（状态串 = Rust 事件）
  theme.ts             THEMES 注册 + applyTheme(data-theme)
  types.ts format.ts errors.ts(AuthError)
src/components/        Sidebar Topbar FileView FileGrid SearchView TrashView TransfersView
                       AIView PreviewModal ShareDialog AclDialog VersionsDialog TransferPanel
                       ContextMenu UploadToDialog Settings Modals icons
                       （TransfersView：任务注册表管理页，侧栏"传输"入口带未完成任务角标，
                       全部/上传/下载筛选；ContextMenu/UploadToDialog：本地文件右键上传到
                       一个/多个远程（0.6.0 需求7））
src/styles/            base.css（组件）+ themes.css（5 套主题变量）
src-tauri/src/         lib.rs(config/localdb/localfs/serverapi/ai/secret 的 command 注册 + 启动清理)
                       config.rs(AppConfig: localRoots/servers(caFile)/ai/active/ui(sidebarCollapsed)/
                                  transfer/trashRetentionDays；keyring_ok；update() 统一做
                                  令牌同步凭证库+config.json 脱敏)
                       secret.rs(系统凭证库 keyring：token 存取/探测/删除；不可用时回退明文并提示)
                       localdb.rs(本地元数据 sqlite：ai_descriptions/trash_items/file_versions/
                                  analysis_tasks；open_and_migrate 幂等迁移 user_version；
                                  旧 *.json 首次启动自动导入后改名 *.imported)
                       localfs.rs(防逃逸 fs_* + 本地版本库 + fs_import/export + fs_media_cache)
                       serverapi.rs(srv_login/logout/change_password/call/upload/download/media_cache/preview_data/thumb + transfer_cancel)
                       ai.rs(本地 AI)
```

## 开发命令

```bash
npm install
npm run tauri dev        # 开发运行（GUI）
npm run build            # tsc + vite（类型检查）
cd src-tauri && cargo check
```

## 关键约定（改动前必读）

1. **不直接 fetch**：所有网络请求走 Rust（serverapi.rs），前端只 invoke。
   新增服务端调用优先扩展 `srv_call` 泛化代理，只有二进制/流式场景才加专用命令。
2. **DataSource 契约**：UI 组件只依赖 `lib/datasource.ts` 接口；新能力先加接口，
   再分别实现 local.ts / server.ts（服务端缺失能力时用 caps 位屏蔽 UI）。
3. **路径安全**：本地操作全部经 Rust `resolve_in_root`（拒绝 `..`/绝对路径逃逸）；
   前端不得拼接绝对路径直接读写（导入/导出只经对话框选择的 `fs_import`/`fs_export`；
   0.4.0 已下线任意路径的 `fs_read/write_bytes_b64`，不得恢复）。
   令牌一律经 `secret.rs` 入系统凭证库，config.json 不落盘明文（回退场景除外）。
4. **游客只读（需求6）**：`source().anonymous === true` 时禁用一切写操作 UI（含下载按钮置灰）；
   401/AUTH_REQUIRED → App.tsx 统一处理 AuthError：**显式操作**（切换服务端/点登录/游客上传）
   必弹登录框；**后台自动加载**（refresh/refreshTrash）遇 401 每服务端最多自动弹一次，
   取消后不再骚扰（错误条+顶栏登录按钮承接；登录成功/登出重置该标记）。
   刷新与位置持久化 effect 依赖激活来源的**稳定字符串签名** `kind|serverId|rootId`，
   禁止以 `cfg?.active` 等对象引用作 effect 依赖（saveConfig 每次返回新对象会形成
   "保存→刷新"死循环并导致登录框反复弹出）。
5. **传输**：服务端上传/下载一律经 `transfer.enqueue` 入队执行（任务注册表：暂停→
   断点续传 / 失败重试 / 覆盖重试在 TransferPanel，0.6.0 需求4/5/6），UI 不直接
   await 传输命令；本地模式导入/导出即时执行并经 `reportLocal` 记进度。
   任务 id=transferId（`uid()`），进度经 `fm-transfer` 事件（未入队 id 自动注册为
   展示任务）；取消/暂停用 `transfer_cancel(pause)`；上传覆盖的 BaseHash 在任务
   执行时重新 stat 获取（乐观锁，需求3；新文件断言 `"-"`）。
6. **配置**：AppConfig 变更必须给默认值（config.rs serde default + api.ts normalize），
   兼容旧 config.json。
7. **主题**：颜色一律用 CSS 变量（themes.css），组件样式禁止硬编码色值；
   新主题 = themes.css 增加一个 `[data-theme=...]` 块 + theme.ts THEMES 注册。
8. **预览**：视频/音频/PDF 必须经媒体缓存 + `convertFileSrc`（asset 协议 scope
   只授权应用缓存目录）；图片/文本用 data URL。
9. **版本号三处同步**（需求19），发版时更新 CHANGELOG 兼容矩阵（需求20）。
10. 编译验证：`npm run build` + `cargo check` 通过即可（需求29，不写测试）；
    **不做 git 提交/分支/tag**（需求30）。
11. **本地元数据一律经 localdb.rs（localdb.sqlite3）**：AI 描述/回收站/版本索引不再
    写 `*.json`（`config.json` 仍为文件）；`AppState.db` 是 `Mutex<Connection>`，
    **禁止跨 `.await` 持锁**；表结构变更走 `PRAGMA user_version` 迁移链，保持幂等。
12. **登录态单一事实源（0.6.0 需求1/8）**：服务端 token/refreshToken 与已记住账户
    凭证（credentials 索引 + keyring 密码）是 **Rust 侧独占的权威状态**——只有
    `srv_login`/`srv_logout`/`srv_change_password`/`try_refresh`/`cred_forget` 可以变更，任何变更必须
    `app.emit("fm-config-changed")`，前端 App 监听该事件同步（loadConfig +
    invalidateSource + setCfg + roots）；`save_config` **忽略前端快照携带的令牌与
    credentials**（禁止恢复旧的 `*c = config` 全量替换——会把已轮换的令牌写回旧值，
    造成"一直刷新/登录框反复弹"）。记住密码按 服务端+账户 隔离存 keyring，
    config.json 永不落密码本体。

## 当前版本

0.1.0；配套 filemanageServer **0.1.x（推荐）** / 0.7.x / 0.6.x。0.1.0 批次（需求31，自助改密）：
账户页（Settings.tsx AccountTab）新增"修改我的密码"折叠表单（旧密码 + 新密码，前端校验
≥6 且不同于旧密码）；Rust 命令 `srv_change_password`（serverapi.rs + lib.rs 注册）POST
`/api/v1/auth/change-password`——**不经 `srv_call`**（避免 401 自动续期掩盖"旧密码错"），
成功后同步更新 keyring 里已记住的旧口令（`secret::set_password`）、清空该服务端
token/refresh（服务端已作废全部 refresh 会话）、`app.emit("fm-config-changed")`，
前端回未登录态提示用新密码重登。仅普通用户可用（服务端拒绝管理员含超管登录客户端，需求36）。
对服务端为加性依赖：配 0.7.x/0.6.x 服务端时改密端点 404/405（报"接口不存在"），其余功能不变。
0.6.1 批次（需求1）：修复"账户页登录/取消后返回账户页"（Dialog login 分支加
`from:"settings"` 来源标记，App.tsx 单点改动；无协议变化）。
Server 0.7.0 起用户获得家目录虚拟根 `_users:<用户名>`（含内嵌回收站，服务端侧隐藏），
客户端按既有 jail 虚拟根透明处理即可，无需改动。0.6.0 批次（需求1–14）：传输任务注册表+管理页
（上传/下载入队、暂停→断点续传、重试/覆盖重试、统一"传输"界面带方向筛选）、
记住密码快速登录（keyring 按服务端+账户）、restoreSessions 开关、快速切换改版
（本地+选中远程+"更多"下拉）、本地文件右键上传到多个远程、登录态事件同步
（fm-config-changed + save_config 不再回写令牌）、admin 只留在服务端管理台。
0.5.0；曾配套 filemanageServer 0.5.x（jail 模型）。0.4.0 批次：keyring 令牌存储、
CA 证书导入、https 强制确认、CSP、游客下载置灰、左侧可折叠导航栏（默认小箭头标签）、
本地回收站 30 天自动清理、双视图显式预览按钮；移除 fs_read/write_bytes_b64。
0.5.0 批次：设置"用户管理"页替换为"账户"页（登录态/身份/被分配目录/切换账户/退出，
并修复未选服务端时页签崩溃白屏）；分享随机密码提示六位字母+数字。
服务端 0.5.0 起管理 API 仅在服务端管理端口可达——**客户端不做任何用户管理服务**，
roots 返回的虚拟根 id（`main:zhangsan` 形式）对客户端透明、原样透传即可。详见 CHANGELOG。
