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
src/App.tsx            根组件：状态编排、对话框调度（Dialog 判别联合）、查看覆盖层
                       （viewing 状态，0.1.7）、位置恢复
src/lib/
  datasource.ts        DataSource 接口（唯一数据访问契约）
  local.ts             本地实现（invoke fs_* 命令）
  server.ts            服务端实现（srv_call + srv_* 传输命令；0.2.0 serverMkdirs 批量建目录+旧服务端退化逐个 mkdir）
  api.ts               配置单例(loadConfig/saveConfig/active) + source() 工厂 + 分享/ACL/AI 辅助
  transfer.ts          任务注册表（入队/暂停/续传/重试 + "fm-transfer" 事件归并，
                       未入队 transferId 首个事件自动注册为展示任务）+ 订阅；
                       0.2.0 目录上传组任务（enqueueGroup 子任务不进 order/并发池 3/
                       组级 pause-resume-cancel-retry/rowActions 统一选路）
  transtypes.ts        TransferTask/TransferStatus 共享契约（状态串 = Rust 事件）
  theme.ts             THEMES 注册 + applyTheme(data-theme)
  types.ts format.ts errors.ts(AuthError)
  preview.ts           viewableType 查看/预览统一类型判定 + 文本解码 + RAW_EXT + VIDEO_EXT
                       （0.2.1 各相机 RAW 扩展名并入 image 分支；与 Rust thumb.rs
                       is_raw_ext 同表——kind 不改，显示分流一律走 viewableType）
                       （0.3.0 VIDEO_EXT（H.264/H.265 容器/裸流）并入 video 分支；与 Rust
                       localfs kind_of / player.rs 三处同表；有意不含 ts——撞 TypeScript）
                       （App/FileView/FileGrid/SearchView/FileViewer/PreviewModal 共享）
src/components/        Sidebar Topbar FileView FileGrid SearchView TrashView TransfersView
                       AIView PreviewModal FileViewer ShareDialog AclDialog VersionsDialog
                       TransferPanel ContextMenu UploadToDialog Settings Modals icons
                       （0.1.4：Settings 为主区整页视图（View 含 settings，侧栏保持
                       可见；折叠按钮在左上角）；Modals 的遮罩经 createPortal 挂
                       body，嵌套对话框恒在上）
                       （0.1.5：Settings 第 7 页签"关于"=版本信息（客户端/Tauri/配套服务端），
                       页头右侧常驻版本徽标；版本取 @tauri-apps/api/app 运行时命令
                       getName/getVersion/getTauriVersion，非编译期常量，故与 build.sh -V
                       注入的产物版本一致；core:app:default 已授权，权限零改动）
                       （TransfersView：任务注册表管理页，侧栏"传输"入口带未完成任务角标，
                       全部/上传/下载筛选；ContextMenu/UploadToDialog：本地文件右键上传到
                       一个/多个远程（0.6.0 需求7））
                       （0.3.0：外观页签新增"关闭按钮（X）行为"select（托盘/退出，默认托盘）
                       与"视频播放（H.264/H.265）"radio+外部播放器命令输入（Enter/失焦提交）+
                       测试按钮，均 uiSet 即时持久化；FileViewer/PreviewModal 视频 onError 兜底
                       面板 + openMedia 外部播放入口，FileViewer 增 decoder prop）
src/styles/            base.css（组件）+ themes.css（5 套主题变量）
src-tauri/src/         lib.rs(config/localdb/localfs/serverapi/ai/secret/thumb/player 的 command 注册 +
                       启动清理；0.3.0：TrayIconBuilder 托盘（菜单=显示主窗口/退出，左键仅唤醒——
                       Linux appindicator 不派发点击事件，菜单为主路径）+ CloseRequested 按
                       ui.closeAction 拦截隐藏（TRAY_OK/QUITTING 原子标志，托盘失败绝不炸启动）+
                       tauri-plugin-single-instance 最先注册（重复启动唤起已有窗口）)
                       config.rs(AppConfig: localRoots/servers(caFile)/ai/active/ui(sidebarCollapsed/
                                  closeAction=tray|quit(默认tray)/videoDecoder=system|external(默认system)/
                                  videoPlayerCmd(0.3.0))/transfer/trashRetentionDays；keyring_ok；
                                  update() 统一做令牌同步凭证库+config.json 脱敏)
                       secret.rs(系统凭证库 keyring：token 存取/探测/删除；不可用时回退明文并提示)
                       localdb.rs(本地元数据 sqlite：ai_descriptions/trash_items/file_versions/
                                  analysis_tasks；open_and_migrate 幂等迁移 user_version；
                                  旧 *.json 首次启动自动导入后改名 *.imported)
                       localfs.rs(防逃逸 fs_* + 本地版本库 + kind_of(0.3.0 视频扩展表扩 hevc/h265/h264/
                                  m2ts/mpg…，不含 ts)+ fs_import/export + fs_walk(0.2.0 目录树枚举，需求41) +
                                  fs_media_cache(0.1.7 起带可选 ver 版本串入缓存键；0.2.1 RAW 存提取的内嵌预览 .jpg) +
                                  fs_thumb(0.2.1 网格缩略图：媒体缓存 ≤512px .thumb.jpg 路径))
                       serverapi.rs(srv_login/logout/change_password/call/upload/download/media_cache(同 ver，0.2.1 同 RAW 分支；内部 srv_media_ensure)/preview_data + srv_thumb(0.2.1 改版：加 ver、返回缩略图路径) + transfer_cancel)
                       thumb.rs(0.2.1 相机 RAW：is_raw_ext 品牌扩展表 + extract_preview 字节级最大内嵌 JPEG
                                  提取（SOI 扫描 + 段链校验至 EOI，熵数据/progressive 合法，垃圾候选拒绝）+
                                  ensure_thumb image 缩放 ≤512px JPEG 入媒体缓存)
                       player.rs(0.3.0 需求1 外部播放器：open_media(限媒体缓存目录内文件——命令不经
                                  capabilities 门控故 canonicalize+前缀纵深防御；videoPlayerCmd 空→
                                  opener 插件系统关联播放器，非空→argv 直起不经 shell、{file} 占位、
                                  Windows CREATE_NO_WINDOW、spawn 分离) + test_player_command(设置页
                                  测试：开缓存最新视频或 0 字节 fmc-selftest.mp4 探测，返回实际路径))
                       ai.rs(本地 AI)
```

## 开发命令

```bash
npm install
npm run tauri dev        # 开发运行（GUI）
npm run build            # tsc + vite（类型检查）
cd src-tauri && cargo check

./build.sh -a all -d release   # 多平台产物（Docker 编译环境，见 build-env/README.md）：
                               # ubuntu22.04(deb+rpm+AppImage)/24.04(deb)/26.04(deb)/
                               # windows10(NSIS exe，最低 Win10)；-d debug → release/debug/
                               # 产物命名 filemanageClient_<平台>_<版本号>.<扩展名>
                               #（Ubuntu 20.04 环境因 Tauri2 缺 webkit2gtk-4.1 不可行，已移除）
./build.sh -i [-a <平台>]      # 仅构建编译环境镜像（docker build，-a 限定对应环境、缺省四环境全建），
                               # 完成后退出，不编译工程
./build.sh -n [-a <平台>]      # 编译前拉取编译环境镜像（docker pull，镜像全名自带 harbor 前缀
                               # harbor.localserver.com:9080/filemanage，拉取名即运行名）；
                               # 裸 -n 拉完即退出，配 -a 继续编译（CI：-n -a all [-V v0.2.0]）
./build.sh -a all -V v0.2.0    # -V 显式指定产物版本号（覆盖 package.json，去 v 前缀；仅影响产物命名与
                               # tauri --config 注入的 bundle 版本元数据，不改三处版本源文件；
                               # tauri 要求严格 semver——非 semver 值（如 git describe 兜底 unknown）
                               # 容器内告警回落 package.json，不中断编译）
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
   **0.2.0 需求41 目录上传**：整树枚举走 `fs_walk`（符号链接/`.fmtrash` 跳过，
   上限内整体拒绝），远端骨架走 `POST /api/v1/mkdirs`（旧服务端自动退化逐个
   `mkdir`），文件走 `transfer.enqueueGroup` 组任务——子任务只注册不进 UI 快照、
   并发池限流、一条组行聚合进度，暂停/继续/取消/重试为组级（冲突子任务组重试
   按覆盖语义）；UI 不得绕过 `rowActions` 直接调单任务 API。
6. **配置**：AppConfig 变更必须给默认值（config.rs serde default + api.ts normalize），
   兼容旧 config.json。
7. **主题**：颜色一律用 CSS 变量（themes.css），组件样式禁止硬编码色值；
   新主题 = themes.css 增加一个 `[data-theme=...]` 块 + theme.ts THEMES 注册。
8. **预览/查看（0.1.7 契约；0.2.1 增缩略图全量 + RAW；0.3.0 增视频解码体系）**：图片/视频/音频/PDF 一律经媒体缓存 + `convertFileSrc`
   （asset 协议 scope 只授权应用缓存目录；无大小上限——大图片可看；缓存键必须并入
   `ver`＝entry.mtime 串，防覆盖后 exists 短路命中旧内容）；文本用 data URL（仍 ≤8MiB）。
   **相机 RAW（0.2.1）**：浏览器不可解码——`viewableType` 按 `RAW_EXT`（与 Rust
   `thumb.rs::is_raw_ext` 同表）归入 image，媒体缓存存的是 Rust 从文件提取的**最大
   内嵌 JPEG 预览**（`.jpg`，非原始字节），查看/预览/缩略图共享该条目；不得改为整文件
   入缓存再 `<img>` 直挂。网格缩略图一律 `thumbPath`（fs_thumb/srv_thumb → 媒体缓存
   ≤512px `.thumb.jpg` 路径 → convertFileSrc；null 回退图标），大图与 RAW 无需点眼睛
   即可见（眼睛/角标/右键预览入口保留）；服务端模式首过整文件入缓存属已接受代价
   （与预览共享），并发池 3 限流。
   预览＝PreviewModal 缩放弹窗（"缩略图"观感，入口＝眼睛/角标/右键"预览"）；
   查看＝FileViewer 主区覆盖层（入口＝双击/右键"查看"，双击图片/Esc/X 关闭，
   全屏＝窗口 `setFullscreen`＋CSS 覆盖层，**禁用 DOM requestFullscreen**——
   webkitgtk 支持参差违背双引擎一致性）。类型判定必须走 `lib/preview.ts`
   `viewableType`，不得与弹窗支持集分叉。层叠契约：`.modal-mask` 100 >
   `.viewer-fs` 90 > `.viewer` 80 > 页面内容（401 登录框恒在查看之上）。
   **视频解码（0.3.0 需求1）**：H.264/H.265 默认 `videoDecoder=system`——`<video>`
   即 WebView 原生系统解码器（Windows Media Foundation / Linux GStreamer），必须挂
   `onError` → 提示面板（缺 HEVC 组件指引）+ [用外部播放器打开]（`open_media` 开
   媒体缓存路径；`videoPlayerCmd` 空=系统关联播放器，`{file}` 占位符，argv 直起不经
   shell）；`external` 模式查看器自动外起一次（ref 去重）并给 [在本窗口播放] 覆盖，
   **PreviewModal 一律不自动外起只给按钮**；`VIDEO_EXT`（三处同表：preview.ts /
   localfs kind_of / player.rs）**不得纳入 `ts`**（TypeScript 冲突）。不内嵌 ffmpeg。
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
13. **托盘常驻与关窗行为（0.3.0 需求2）**：`ui.closeAction`（默认 **tray**）只影响主
    窗口 `CloseRequested`——tray 且 `TRAY_OK` 且非 `QUITTING` 时 `prevent_close()+hide()`
    （先退全屏）；**托盘构建失败必须退回退出行为**（绝不静默丢窗口），托盘菜单
    「退出」先置 `QUITTING` 再 `exit(0)`。恢复入口：托盘菜单「显示主窗口」（Linux
    appindicator 不派发点击事件，菜单是 Linux 主路径）/左键·双击唤窗（Windows）/
    重复启动经单实例插件唤起。**禁止**新增任何"进程后台仍持有可见模态"假设——
    隐藏态视频/音频继续播放属已接受边界。single-instance 钉 `~2.4.5`（2.5.x 需
    tauri ^2.12 + MSRV 1.90，勿随手升）。

## 当前版本

0.3.0（H.264/H.265 视频播放体系 + 系统托盘常驻；数据协议零变更）+ 0.2.1（网格缩略图全量显示 + 相机 RAW 查看/预览）+ 0.2.0（需求41 目录上传）；0.1.1/0.1.2 为构建体系批次、0.1.3–0.1.7 为修复与 UI 批次；配套 filemanageServer **0.2.x（推荐；当前 0.2.0）** / 0.1.x / 0.7.x / 0.6.x（0.3.0 全部为客户端本地行为，兼容关系承接 0.2.1）。
**0.3.0（2026-10-04 视频播放 + 托盘常驻；数据协议零变更）**：需求原句——支持 h264/h265 视频播放，调用系统解码器或者可配置视频解码器；新增托盘常住，设置里按叉可选退出/进托盘，默认进托盘。视频：`VIDEO_EXT` 并入 `viewableType` video 分支（与 Rust kind_of/player.rs 三处同表，不含 ts）；`FileViewer`/`PreviewModal` 视频挂 `onError` → 缺 HEVC 系统组件提示面板 + [用外部播放器打开]；`ui.videoDecoder=external` 时查看器自动外起一次（可 [在本窗口播放] 覆盖，弹窗不自动起）；新 `player.rs`（`open_media` 限媒体缓存目录、空命令走 opener 系统关联、自定义命令 argv 直起不经 shell、`{file}` 占位、Windows CREATE_NO_WINDOW；`test_player_command` 设置页探测）。托盘：tauri `tray-icon` 特性 + `TrayIconBuilder`（菜单显示/退出，Linux 恢复走菜单——appindicator 不派发点击事件）+ `CloseRequested` 按 `ui.closeAction`（默认 tray；托盘不可用自动退回退出，构建失败不炸启动，`QUITTING` 防再拦截）+ `tauri-plugin-single-instance ~2.4.5`（钉版防 tauri 核/MSRV 悬崖）唤起已有窗口；`bundle.linux.deb.depends` 增 `libayatana-appindicator3-1`。设置→外观两处新配置均 uiSet 即时保存；capabilities 零改动。已知边界：H.265 窗口内播放依赖系统 HEVC 组件（不内嵌 ffmpeg）；隐藏态媒体继续播；服务端模式 external 需整文件先入媒体缓存。
**0.2.1（2026-10-03 网格缩略图全量显示 + 相机 RAW；数据协议零变更）**：需求原句——按缩略图浏览时也要显示文件内容（图片、以及尼康 NEF 等各品牌 RAW），点不点眼睛都能看（眼睛预览保留）。根因：网格走 `thumbData` data URL（本地 ≤4MiB/srv_thumb ≤2MiB/筛选 ≤8MiB）且过滤 `kind==="image"`，大图与 RAW（kind=other）只剩图标。**新 Rust `thumb.rs`**：`extract_preview` 字节级提取 RAW 内**最大完整 JPEG 预览**（SOI→按段链校验至 EOI，SOS 熵数据只认填充字节/RST/progressive 间 DHT，坏结构候选拒绝——绝不半张图当预览）；`fs_media_cache`/`srv_media_cache` RAW 分支把提取结果存为 `<key_hash>.jpg`（服务端经可续传 scratch 转存后删源）→ 双击查看/眼睛预览自动支持 RAW（零新端点、Server 零改动，字节仍走既有 `/api/v1/preview`，匿名语义不变）；新 `fs_thumb`/改版 `srv_thumb`（加 ver、返回媒体缓存 `<key_hash>.thumb.jpg` ≤512px 路径，svg/heic 等缩放失败且 ≤8MiB 回传原路径）→ `DataSource.thumbData` 替换为 `thumbPath`。前端：`RAW_EXT` 并入 `viewableType` image 分支（kind 不改）、网格 effect 改 `viewableType` 判定去大小上限、并发池 3、`convertFileSrc` 加载；`PreviewModal` 分流统一 `viewableType`。新增依赖 `image` crate（default-features 关，仅常用光栅解码+jpeg 编码）。已知边界：服务端首过整文件入缓存（`$APPCACHE/media` 无淘汰为既有缺口，本批使用面扩大）；RAW 保真=相机内嵌预览（非全精度解码）；缩略图仍限前 60。**0.2.0（2026-10-03 目录上传，需求41；依赖 Server 0.2.0 加性端点 `POST /api/v1/mkdirs`，配旧服务端自动退化逐个 `mkdir`）**：本地模式右键目录 →"上传目录到远程…"——Rust `fs_walk` 递归枚举（符号链接/`.fmtrash` 跳过，深度 64/条目 20000 上限，超限整体拒绝绝不传半棵树）→ `serverMkdirs` 一次建好远端目录骨架（含空目录）→ 逐文件经并发池（3）入组队列；传输 UI **整目录聚合为一条组行**（总字节进度 + `done/total 个文件`，暂停/继续/取消/重试整组粒度；冲突文件组重试按覆盖语义重跑，服务端覆盖前先存版本，需求3）。`UploadToDialog` 新增 `isDir`；transfer.ts 新增 `enqueueGroup/settle/pump/组级 API/rowActions`（子任务只进注册表不进 order，UI 快照天然只见组行；`removeTask/clearFinished` 级联清理子任务）；`watchGroup` 整组终态才一次汇总通知+刷新。已知限制：组内子任务暂不可展开（`getGroupChildren` API 已留）、20000 条硬上限、非 UTF8 文件名沿用 `fs_list` lossy 口径。
**0.1.7（2026-10-03 查看/预览分离+大图片查看+查看器全屏，数据协议零变更）**：双击**可预览类型**
（`viewableType`：image/video/audio/pdf/文本扩展名）→ 新建 `FileViewer` 主区覆盖层就地显示
（`<main>` 加 `position:relative`，`.viewer` absolute 盖住列表与顶栏——**不顶替 FileView 插槽**，
其下筛选/选中/缩略图状态保留；切 view/path/activeSig 自动收起，依赖仍是稳定字符串）。
**大图片可看的根因**：图片取字节从 `previewData`（fs/srv 双侧 8MiB data URL 硬限）切到
`mediaCache`+`convertFileSrc`（预览弹窗同步切，两侧共享缓存）——服务端仍走既有
`/api/v1/preview` 流式下载（同端点同权限，**Server 零改动、匿名语义不变**）、本地 `fs_media_cache`
硬链接无上限；两命令新增可选 `ver` 参数（前端传 `String(entry.mtime)` 并入哈希键）防覆盖后
exists 短路命中旧内容，接口签名不变。入口分离：`openEntry`（双击/右键"查看"）vs
`previewEntry`（眼睛/角标/搜索页"预览"按钮/右键"预览"），`FileView/FileGrid/SearchView`
各加 `onPreview` prop。全屏＝`getCurrentWindow().setFullscreen`（capabilities 新增
`core:window:allow-set-fullscreen` 一行；失败 try/catch 退化 CSS 覆盖层 `.viewer-fs`；
`fsApplied` ref 确保只撤销查看器自己置的全屏，不抢 WM 状态）；双击图片关闭查看，
Esc 先退全屏再关查看。已知边界：文本 >8MiB 仍报过大；服务端图片查看产生瞬时 "media-"
传输展示行（视频预览先例）；`$APPCACHE/media` 无淘汰策略（既有缺口，后续项）。
**0.1.6（2026-10-03 修复 Windows 本地目录路径误报，数据协议零变更）**：`localfs.rs`
`resolve_in_root` 双保险清洗循环对 Windows 路径是错的——Windows 组件序列首两项是
`Prefix("C:")`+`RootDir("\")`，旧代码 `other => clean = other.as_os_str().into()`
**整体赋值**，`RootDir` 一步把已拼的盘符覆盖掉，产出 `\Users\…`，既不匹配配置根
`C:\Users\…` 也不匹配 canonicalize 的 `\\?\C:\…`（verbatim 前缀），Windows 上任何
本地目录连 `rel=""` 都被误判越界（Linux 首组件仅 `/` 故无此症）。现 `Prefix`/`RootDir`
改为 OsString 原样追加（不可用 `PathBuf::push`——`push` 视 `\` 为绝对路径同样清空
已推内容），`CurDir`/`Normal` 走 push（修正中段 `.` 同型覆盖丢路径），并新增仅 Windows
生效的 `canonical_base` 剥离 `\\?\`/`\\?\UNC\` 前缀供脏根比对。安全语义零放宽：`..`/NUL
仍逐段拒绝、词法包含双保险仍生效，仅纠正误杀。本地模式路径契约不变（相对路径一律正斜杠、
经 `resolve_in_root` 进根），无新增 Rust command、无配置结构变更。
**0.1.5（2026-10-02 设置页"关于"版本信息，数据协议零变更）**：设置界面新增第 7 个页签**"关于"**——展示应用名、客户端版本号、Tauri 框架版本与配套服务端兼容（静态文案，改兼容矩阵须同步该处），并在 `.page-head` 右侧常驻版本徽标（任何页签可见，可选中复制便于报障）。版本一律经 `@tauri-apps/api/app` 的 `getName/getVersion/getTauriVersion` **运行时**取得，**禁止改成 import package.json 或 vite define 常量**：`build.sh -V` 只经 `tauri --config` 注入 `version`、不改三处版本源文件，唯有运行时元数据能与实际产物版本一致。调用逐项 `catch` 回落（非 Tauri 运行时显示"未知"），effect 用 `cancelled` 标记防重挂回写；权限无需变更（`core:default` ⊇ `core:app:default` 含 allow-version/name/tauri-version）。新增样式只用主题变量，未引入 `backdrop-filter`/`color-mix`，故 Windows(WebView2) 与 Linux(webkitgtk) 观感一致。
**0.1.4（2026-10-02 UI 修复/改版，数据协议零变更）**：修复 Windows 下设置页内"添加服务端"子对话框被设置卡片遮挡看不见的问题（需求1）——根因是嵌套 `Modal` 的遮罩渲染在父对话框 DOM 内，父 `.modal-mask` 的 `backdrop-filter` 为 fixed 后代建立包含块/层叠上下文、再被 `.modal-body` 的 `overflow` 裁剪；`Modals.tsx` 改为 `createPortal` 把遮罩统一挂到 `document.body`（所有对话框——含分享/版本历史内嵌确认框——一律正确分层，后开必在上）。同时设置界面由浮动模态卡片改为**主区整页视图并保持左侧导航**（需求2）：`View` 联合新增 `settings`，`<main>` 内渲染 `<Settings>`（复用 `.page`、内容居中限宽），Topbar 照常可见；Dialog 联合删除 `settings` 分支，App 以 `openSettings(tab?)`+`settingsTab` 统一进入（侧栏"设置/用户"、AIView、无本地目录回落、登录 `from:"settings"` 回跳账户页签均走它），Esc 离开回文件页，位置恢复不记录设置视图。侧栏折叠按钮移至**左上角**：展开态在 brand 行首位（原右侧），折叠态小标签贴窗口左上角（原整列垂直居中）。页签内容与保存链路不变。
**0.1.3（2026-10-02 修复，数据协议零变更）**：服务端地址缺协议头归一——`baseUrl` 为裸
`host:port` 时统一补 `http://`（`config.rs` `ServerConf::norm_base/normalized_base`，
`AppState::load` 启动归一内存值、随下一次保存落盘；`serverapi.rs` 全部请求 URL 的唯一
拼接点 `base_of` 取归一值，`insecure_tls` 的 https 判断同口径；`Settings.tsx` 保存服务端
先补协议头、再走既有明文 HTTP 二次确认）。连接类错误统一带出 reqwest 真实成因
（`req_detail/req_err`）——此前裸 host:port 只报 `无法连接服务端: builder error`
（reqwest 把 URL 解析失败归为 Builder 类，Display 不含 source），与网络故障无法区分。
**0.1.1 服务端（需求40：内置文件存储驱动 + 管理台切换/导出/暂停）对本客户端零影响**：
`/api/v1` 数据协议零变更，客户端代码/版本号不改动，仅更新本兼容列表——暂停维护窗口内
业务端点返回 503、health `db` 字段可能为 `"file"`，均落入客户端既有错误/探测容错路径。0.1.0 批次（需求31，自助改密）：
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
