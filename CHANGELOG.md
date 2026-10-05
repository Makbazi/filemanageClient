# Changelog — filemanageClient

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
**每次版本变更必须声明兼容的其他模块版本（需求20）。**

> 需求39（2026-09-21 维护者决策，本批用户清单第 9 条）：正式首发前从未发布，历史变更清单整体清空、从此
> 重新记录；此前明细可查本仓库 git 历史（分支 feature/dev_new_able）。

## 兼容矩阵

| filemanageClient | 配套 filemanageServer | 说明 |
|---|---|---|
| 0.3.1（当前） | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x/0.7.x/0.6.x/0.5.x 亦可用 | **纯构建体系修复，功能与兼容关系与 0.3.0 完全一致、数据协议零变更、产物代码零变更**：win10 交叉编译镜像补装 `libayatana-appindicator3-dev`——tauri-cli 在 Linux 宿主开启 tray-icon 特性后无条件探测 appindicator（判宿主机不判 `--target`），0.3.0 的 NSIS 打包因此崩溃（Jenkins #48），本版本修复后 Windows 产物正常产出 |
| 0.3.0 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x/0.7.x/0.6.x/0.5.x 亦可用 | 承接 0.2.1 兼容关系**零变更、数据协议零变更**：H.264/H.265 播放 = WebView 原生**系统解码器**（Windows Media Foundation / Linux GStreamer）+ 可配置**外部播放器**兜底（字节仍取既有 `GET /api/v1/preview` 媒体缓存通道，Server 不感知）；托盘常驻/关窗行为/单实例/`open_media`·`test_player_command` 均为客户端本地 Rust 行为，不跨进程。Linux 托盘运行期依赖 appindicator（deb depends `libayatana-appindicator3-1`）。⚠️ 该 tag 的 windows10 产物因编译环境探测崩溃未产出，由 0.3.1 修复 |
| 0.2.1 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x/0.7.x/0.6.x/0.5.x 亦可用 | 承接 0.2.0 兼容关系**零变更、数据协议零变更**：网格缩略图全量显示与相机 RAW（NEF/CR2/ARW/RAF…）查看/预览均为客户端本地 Rust 行为——字节仍取自既有 `GET /api/v1/preview` 媒体缓存通道（同端点同权限、匿名语义不变，需求6 无新增面）；新增 `fs_thumb`、`srv_thumb` 改版（改返回媒体缓存缩略图路径、加 ver）属本地 Rust 命令契约，不跨进程。目录上传仍依赖 Server ≥0.2.0 |
| 0.2.0 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x/0.7.x/0.6.x/0.5.x 亦可用 | 需求41 目录上传：本地模式右键目录 → Rust `fs_walk` 递归枚举（跳符号链接与 `.fmtrash`，深度 64/条目 20000 硬上限，超限整体拒绝绝不传半棵树）→ `POST /api/v1/mkdirs` 一次建好远端目录骨架（含空目录；配 Server <0.2.0 自动退化为逐个 `mkdir`，幂等递归语义一致、仅往返更多）→ 逐文件入队上传（并发池 3 限流），传输 UI 整目录聚合为一条组行（总字节进度 + 文件计数，暂停/继续/取消/重试整组粒度；冲突文件经组"重试"按覆盖语义重跑——服务端覆盖前先存版本，需求3）；其余功能承接 0.1.7 零变更 |
| 0.1.1–0.1.7 | 0.1.x（当时推荐；当前 Server 0.1.1）；0.7.x/0.6.x/0.5.x 亦可用 | 兼容关系承接 0.1.6 不变（数据协议零变更：查看/预览分离与大图内联查看为纯客户端 UI/本地上屏缓存行为，图片取字节由 data URL 改走**既有** `/api/v1/preview` 端点的媒体缓存通道，服务端无感；`fs_media_cache`/`srv_media_cache` 新增可选 `ver` 参数属本地 Rust 命令契约，不跨进程）。0.1.6 仅修复 Windows 本地目录路径校验误报（纯客户端本地行为），数据协议零变更。0.1.5 新增设置页"关于"页签与页头版本号显示，纯 UI 行为、数据协议零变更（"配套服务端"一栏为兼容矩阵静态文案，不产生新的接口依赖）。新增账户页自助改密（需 Server ≥0.1.0 的 `/auth/change-password`；配旧服务端时该按钮报 404/405，其余功能不变）。0.7.x/0.6.x 服务端下家目录虚拟根、jail 语义与登录态处理同 0.6.1。**Server 0.1.1（文件存储驱动、管理台切换/导出/暂停）为服务端存储与管理面增项，数据协议零变更，本客户端无感兼容（仅更新本兼容列表，代码不动）**。Client 0.1.1–0.1.6 为构建体系与客户端本地修复/改版（baseUrl 协议头归一、连接错误透出、对话框层级修复、设置全屏页、关于页版本信息、Windows 本地目录校验修复），0.1.7 为查看/预览分离 + 大图查看 + 查看器全屏，均纯 UI/本地行为，数据协议零变更，对本矩阵无影响 |
| ≤0.6.1 | 0.5.x–0.7.x | 见 git 历史（已按需求39清空） |

## 未发布版本

### 构建体系：win10 交叉镜像补装 appindicator 开发包（2026-10-05，0.3.1；数据协议零变更/产物代码零变更）
- **症状**（Jenkins filemanageClient_pipeline #48，tag v0.3.0）：三个 Linux 环境产物齐出；
  windows10 环境 `x86_64-pc-windows-gnu` exe 编译成功后，NSIS 打包阶段崩溃——
  `tauri-cli/src/interface/rust.rs:1722 panicked: Can't detect any appindicator library`。
- **根因**：0.3.0 启用 `tauri` 的 `tray-icon` 特性后，tauri-cli 2.11.4（上游 dev 分支实测
  亦未修）在 Linux 宿主打包时，只要 manifest 开启该特性就**无条件**用 pkg-config 探测
  appindicator——该代码块门控是宿主机的 `#[cfg(target_os="linux")]`，与 `--target`/
  `--bundles` 无关；两个 .pc 皆缺即 panic。探测结果只写进 deb Depends/AppImage 附带
  文件，对 NSIS 产物无影响，但探测本身不可跳过（`TAURI_LINUX_AYATANA_APPINDICATOR`
  两个取值分支同样要求 pkg-config 成功）。三个 Linux 镜像因编译链接真依赖已装
  `libayatana-appindicator3-dev` 故通过；win10 交叉镜像此前不装（Windows 目标不链 GTK），
  被宿主机侧探测连带炸出。
- **修复**：`build-env/Dockerfile.ubuntu22.04-win10` 在 rust 层之后新增独立层安装
  `libayatana-appindicator3-dev`（前序 apt/node/rust 缓存层不失效；仅供 CLI 探测，
  不参与 Windows 链接）。详见 build-env/README.md「win10 镜像为何也装了 appindicator」。
- **生效前提（维护者人工步骤）**：镜像须重建并推送 harbor——`./build.sh -i -a windows10`
  → `docker push harbor.localserver.com:9080/filemanage/filemanage-client-build:ubuntu22.04-win10`；
  CI `-n` 按 tag 拉取，推送前流水线仍复现旧症。
- **版本**：经维护者决策本修复记为 **0.3.1**（需求19，三处版本清单 + Cargo.lock
  0.3.0 → 0.3.1）；应用代码零变更、数据协议零变更，兼容矩阵完全承接 0.3.0。
  0.3.0 tag 的 windows10 产物因此缺陷未能产出（流水线 #48），发版以 0.3.1 重打 tag。
- **本地实测通过**：重建后的 win10 镜像 `./build.sh -a windows10` 越过原 panic 点完成
  NSIS 打包，出 `release/filemanageClient_windows10_0.3.1.exe`（PE 检查正常）。

### 新增：H.264/H.265 视频播放 + 系统托盘常驻（2026-10-04，0.3.0；数据协议零变更）
- **需求原句**：需求1——支持 h264、h265 视频播放，调用系统解码器或者可配置视频解码器；需求2——新增托盘常住，可在设置里设置按叉后是退出程序还是在托盘，默认在托盘。
- **根因/现状**：① WebView 内 `<video>` 本身即经系统解码器栈（Windows WebView2→Media Foundation，Linux webkitgtk→GStreamer），但 `viewableType` 只认 `kind==="video"`，服务端未标 video 的 HEVC 常见容器/裸流（.hevc/.h265/.m2ts/.mpg/.ts…）进不了查看通道；② `FileViewer`/`PreviewModal` 的 `<video>` 无 `onError`——系统缺 HEVC 组件时表现为空白死播放器、毫无指引，也无任何"外部播放器"通路；③ 无托盘、无关窗拦截、无单实例。
- **视频分类（双端同表）**：新 `VIDEO_EXT`（`lib/preview.ts`，与 Rust `localfs.rs` `kind_of` 新视频扩展臂、`player.rs` 探测表三处同集合）并入 `viewableType` video 分支——**kind 不改**（RAW 先例，显示分流一律走 viewableType）；**有意不含 `ts`**（与 TypeScript 源文件冲突，`.ts` 仍按文本查看）。
- **解码策略（默认 system）**：`FileViewer`/`PreviewModal` 视频挂 `onError` → 系统解码失败时替换为提示面板（"可能缺少 HEVC/H.265 系统解码组件——Windows 装『HEVC 视频扩展』、Linux 装 gstreamer HEVC 插件"）+ [用外部播放器打开]（+查看器 [重试] 重挂 `<video>`）。设置 `ui.videoDecoder="external"` 时查看器缓存路径就绪后**自动外起一次**（ref 去重，含 StrictMode），面板提供 [重新打开]/[在本窗口播放] 覆盖；预览弹窗一律不自动外起（小窗防惊吓，只给按钮）。
- **新 Rust 模块 `src-tauri/src/player.rs`**：`open_media`（仅允许打开 `$APPCACHE/media` 内的已落盘缓存文件——本命令不经 capabilities 门控，canonicalize+前缀校验做纵深防御；命令留空走 `tauri_plugin_opener::open_path` 系统关联播放器，非空 `spawn_player_cmd`：仅按双引号分词、argv 直起**不经 shell**、`{file}` 占位符替换否则路径追加末位、spawn 后分离、Windows 加 CREATE_NO_WINDOW）；`test_player_command`（设置页"测试外部播放器"：打开媒体缓存中最新视频条目，无则写 0 字节 `fmc-selftest.mp4` 探测，返回实际路径供 UI 回显）。`UiConf` 新增 `closeAction`（tray|quit，**默认 tray**）/`videoDecoder`（system|external，默认 system）/`videoPlayerCmd`（Option，默认 None）三字段（serde default 兼容旧 config.json）。
- **托盘常驻（`lib.rs`）**：tauri `tray-icon` 特性启用 `TrayIconBuilder`（复用默认窗口图标；菜单=显示主窗口/退出；左键单击·双击仅唤醒隐藏窗口不做隐藏——**tauri 源码注明 Linux appindicator 不派发点击事件，Linux 恢复主路径=菜单项**）；`on_window_event CloseRequested` 按 `ui.closeAction==tray` 且托盘可用且非主动退出（`QUITTING` 原子标志）→ `prevent_close()`+先退全屏再 `hide()`；托盘构建失败仅记 `TRAY_OK=false`——**绝不使启动失败**，X 自动退回"退出"，不会把用户关进无窗口黑盒。托盘菜单"退出"置 `QUITTING` 后 `exit(0)`。
- **单实例**：`tauri-plugin-single-instance` 桌面端最先注册，重复启动回调 `show/unminimize/set_focus` 唤起已有窗口。钉 **`~2.4.5`**：2.5.x 要求 tauri ^2.12（当前锁 2.11.5）且 MSRV 1.90，build-env 镜像 stable 不可控；2.4.5 所需 zbus 已在依赖图/缓存。
- **打包/配置**：`tauri.conf.json` 新增 `bundle.linux.deb.depends ["libayatana-appindicator3-1"]`、`rpm.depends ["ayatana-appindicator"]`（Linux 托盘运行期 dlopen ayatana；rpm 包名按 Fedora/RHEL 口径，目标发行版待验）；`capabilities/default.json` 零改动（托盘/关窗拦截/自定义命令均为 Rust 侧，不走 IPC ACL）。设置→外观：新增"关闭按钮（X）行为"select 与"视频播放（H.264/H.265）"radio + 外部播放器命令输入（Enter/失焦即时保存）+ 测试按钮，全部经 `uiSet` 即时持久化。
- **新增依赖**：tauri feature `tray-icon`（tray-icon/muda/libappindicator 已在 Cargo.lock 与本地缓存，离线可编）；`tauri-plugin-single-instance ~2.4.5`（Linux 走 tokio+zbus，已在图）。无新 JS 依赖。
- **已知边界/后续项**：H.265 系统解码依赖 OS 组件（Windows 无『HEVC 视频扩展』/Linux 无 gstreamer HEVC 插件时窗口内播不了——本批以提示面板+外部播放器兜底为交付语义，不内嵌 ffmpeg 转码）；MKV/AVI 容器在 webkitgtk 支持参差，同样走兜底；服务端模式 external 需整文件先落媒体缓存（与 0.1.7 查看通道同代价，`$APPCACHE/media` 无淘汰为既有缺口）；窗口隐藏到托盘时已开视频/音频继续播放；外部命令启动器为本地单用户桌面威胁模型（与 fs_* 同位，不经 shell、拒绝空命令）；GNOME 需 AppIndicator shell 扩展。
- 数据协议零变更（视频字节仍走既有 `/api/v1/preview` 媒体缓存通道，同权限、匿名语义不变），与 Server 0.2.x/0.1.x/0.7.x/0.6.x/0.5.x 兼容关系完全承接 0.2.1。

### 新增：网格缩略图全量显示 + 相机 RAW 查看/预览（2026-10-03，0.2.1；数据协议零变更）
- **需求原句**：文件在按缩略图浏览时也要显示文件内容（图片也要显示出来），同时对 RAW 格式的图片（各相机品牌，如尼康 NEF）也要显示出来——不只是点眼睛才能看到缩略图，点不点眼睛都能看（点眼睛的预览功能保留）。
- **根因**：网格缩略图走 `thumbData` data URL 通道——本地 ≤4MiB、服务端 `srv_thumb` ≤2MiB、前端筛选 ≤8MiB，且目标过滤是 `kind==="image"`；大图与 RAW（服务端/本地 kind 均为 `other`）一律只剩类型图标，内容唯有眼睛（mediaCache 无上限通道）可见。
- **RAW 通道（新 Rust 模块 `src-tauri/src/thumb.rs`）**：浏览器无法解码相机 RAW，但各家 RAW 内部都嵌有相机自产的 JPEG 预览。`extract_preview` 纯字节扫描提取**最大且结构完整**的内嵌 JPEG：SOI（FFD8FF）起、按段链前进至 EOI（FFD9）收束；SOS 后进入熵数据模式（FF00 填充/RSTn/progressive 扫描间 DHT 合法，段链断裂即判候选非法跳过）——绝不把半张图或垃圾当预览。覆盖 TIFF 容器（Nikon nef/nrw、Canon cr2/crw、Sony arw/srf/sr2、Panasonic rw2/raw、Olympus orf、Pentax pef、Leica rwl、DNG、Hasselblad 3fr、Samsung srw、Epson erf、Phase One fff、Minolta mrw、Kodak dcs/kdc）与非 TIFF（Fuji raf、Canon cr3、Sigma x3f）——只要内含 JPEG；确无内嵌 JPEG 的极少数文件报错→图标回退。已用 baseline/progressive/多预览并存/垃圾干扰四类合成样本做字节级验证（提取结果与原 JPEG 逐字节一致、无完整预览时正确报 none）。
- **媒体缓存语义（`fs_media_cache`/`srv_media_cache`）**：RAW 分支入缓存的不再是原始字节，而是提取的预览存为 `<key_hash>.jpg`（键结构承接 0.1.7 含 ver）；服务端先落可续传 scratch（`<key_hash>.raw-src`）下载原始字节、提取后删除不双占空间，提取失败留 scratch 供重试。由此**双击查看/眼睛预览自动支持 RAW**（两者本就走 mediaCache，零新端点、零服务端改动）。
- **缩略图生成**：新 `fs_thumb`、改版 `srv_thumb`（加 `ver`，返回**媒体缓存缩略图路径**而非 data URL）：确保缓存条目后生成/复用 `<key_hash>.thumb.jpg`（≤512px JPEG q80），前端 `convertFileSrc` 加载；缩放解码失败（svg/ico/heic 等 `image` 不支持的）且 ≤8MiB 时回传缓存原路径交由浏览器直接渲染，否则报错→图标。`DataSource.thumbData`（data URL）契约替换为 `thumbPath`（本机路径；null=回退图标）。非图像不拉缓存（thumb 命令仅对 `viewableType==="image"` 的条目调用）。
- **前端分流**：`lib/preview.ts` 新增 `RAW_EXT`（与 Rust `is_raw_ext` 同表）并入 `viewableType` 的 image 分支——**kind 不改**（服务端 kind 不含 RAW、本地 `kind_of` 保持与服务端口径一致，分组/筛选行为不变），显示/预览/查看/缩略图一律走 `viewableType` 分流；`FileView` 网格 effect 改为 `viewableType==="image"`、去掉大小上限、**并发池 3**（服务端大图/RAW 首过会整文件入媒体缓存——与眼睛预览共享，看过一次即秒出）；`PreviewModal` 图像分支同步改 `viewableType` 判定（RAW 显示于预览弹窗）。眼睛按钮/角标/右键"预览"、双击"查看"全部入口保留不变。
- **新增依赖**：`image` crate（default-features 关闭，仅 jpeg/png/gif/bmp/webp 解码 + jpeg 编码）用于缩略图缩放；纯 Rust，交叉编译四平台无额外系统库。
- **已知边界/后续项**：服务端模式网格首过把大图像/RAW **整文件**拉入媒体缓存（带宽/磁盘；`$APPCACHE/media` 仍无淘汰策略——既有缺口，本批使用面扩大，淘汰建议单列后续）；RAW 显示保真度受限于相机内嵌预览（通常全尺寸 sRGB JPEG，非全精度 RAW 解码，本功能定位即"看到内容"）；网格缩略图仍限前 60 个；内嵌预览本身很小的格式（如 x3f）观感受限。
- 数据协议零变更（字节仍走既有 `/api/v1/preview`，同权限、匿名语义不变），与 Server 0.2.x/0.1.x/0.7.x/0.6.x/0.5.x 兼容关系完全承接 0.2.0。

### 新增：预览/查看分离 + 大图片查看 + 查看器全屏（2026-10-03，0.1.7；数据协议零变更）
- **需求原句**：大图片也要能查看；区分"预览"与"查看"——预览是缩略图（缩放式小图），查看是双击后右边显示文件的区域直接显示照片，并有全屏按钮、双击照片关闭查看。
- **查看（新 `components/FileViewer.tsx`）**：双击**可预览类型**（图片/视频/音频/PDF/文本；分类 `lib/preview.ts` `viewableType` 与预览弹窗支持集严格一致）→ `<main>` 内覆盖层 `.viewer`（absolute inset:0 z80，盖住文件列表与顶栏，其下筛选/选中/缩略图状态**不丢**；切视图/目录/来源自动收起）。页头：文件名（可选中复制）/大小 + 下载（游客置灰）/全屏/关闭。**双击图片即关闭查看**；Esc 逐级：先退全屏、再关查看；查看中被 401 弹登录框等弹窗永远在上（z 序 100>90>80，需求4/6 语义不受影响）。archive/other 等不可预览类型双击仍是旧弹窗（提示+下载）。
- **大图通道**：图片取字节从 `previewData` 切到 `mediaCache` + `convertFileSrc`——`fs_preview`/`srv_preview_data` 双侧 8 MiB data URL 硬限自此与图片无关（>8MiB 不再报"文件过大"）。本地 `fs_media_cache` 硬链接/复制无上限；服务端 `srv_media_cache` 本就是把 `GET /api/v1/preview` 流式下载到缓存目录——**同端点同权限**（与今天图片预览一致），服务端零改动、匿名公开目录浏览语义不变（需求6 无新增面）；CSP `img-src` 已含 `http://asset.localhost`、asset scope 已授 `$APPCACHE/**`，零配置改动。预览弹窗（PreviewModal）图片分支同步切到此通道并与查看器共享缓存（预览过再查看秒开），弹窗显示尺寸不变（max-height 62vh = "缩略图"观感）。
- **缓存键版本串**：图片入缓存后 `dest.exists()` 短路会在覆盖写后命中旧内容（data URL 时代每次重读、无此问题，属新引入风险）。`fs_media_cache`/`srv_media_cache` 新增可选参数 `ver`（前端传 `String(entry.mtime)` 并入哈希键），旧键条目自然失效重拉。`Option` 参数保持命令向后兼容，接口 `mediaCache(entry)` 签名不变。
- **入口分离**：`openEntry`（双击/右键"查看"）→ 查看覆盖层；新增 `previewEntry`（列表行眼睛、网格角标眼睛、SearchView"预览"按钮、右键"预览"）→ 弹窗。`FileView/FileGrid/SearchView` 各加 `onPreview` prop；右键菜单对可预览类型给"查看"+"预览"两项，目录/其余不变；行/卡片 tooltip 措辞随 `viewableType` 分流（"双击查看" vs "双击预览"）。
- **全屏取舍**：`getCurrentWindow().setFullscreen()`（系统级），**不用** DOM `requestFullscreen`——webkitgtk 支持参差，违背本项目 WebView2/webkitgtk 一致性基调（承接 0.1.5 关注点）。`capabilities/default.json` 增一行 `core:window:allow-set-fullscreen`（读侧 allow-is-fullscreen 已含于 core:default）。`try/catch` 失败退化为应用内覆盖层 `.viewer-fs`（fixed inset:0 z90），功能不崩；退出只撤销**本查看器自己置过**的全屏（`fsApplied` ref），不抢窗口管理器自设状态、重复点按自愈。
- **已知边界/后续项**：文本 >8MiB 查看仍报"文件过大"（previewData 上限保留）；服务端图片查看/预览会生成一条瞬时 "media-" 传输展示行（视频预览既有先例，接受）；`$APPCACHE/media` 仍无淘汰策略（既有缺口，图片入缓存后增长更快，列为后续项，本批不扩 scope）。
- 数据协议零变更（图片走既有 `/api/v1/preview`；`ver` 为本地 Rust 命令可选参数），配套 Server 0.1.x（推荐，当前 0.1.1）/0.7.x/0.6.x 不变。

### 修复：Windows 添加本地目录后一切操作报"路径不允许越出所管理的目录"（2026-10-03，0.1.6；数据协议零变更）
- **现象**：Windows 上添加本地目录后首次列目录即报错，该目录下所有 `fs_*`/AI 分析
  调用全部失败；Linux 本地模式完全正常。
- **根因（`localfs.rs` `resolve_in_root` 双保险清洗循环）**：循环对"非 ParentDir/
  Normal"分支写作 `clean = other.as_os_str().into()`（**整体赋值**）。Windows 下
  `C:\Users\…` 的组件序列是 `[Prefix("C:"), RootDir("\\"), Normal(…)]`，`RootDir`
  分支把先前拼好的盘符整个覆盖成 `\`，清洗结果为 `\Users\…`（丢盘符）——既不等于
  配置根（`C:\Users\…`），也匹配不上 canonicalize 结果（Windows 返回 `\\?\` verbatim
  前缀路径），于是连 `rel=""` 的根目录本身都被判为越界。Linux 首组件只有
  `RootDir`（`/`），覆盖后仍正确，故仅在 Windows 复现。
- **修复**：`Prefix`/`RootDir` 两组件改为对 OsString **原样追加**（不能用
  `PathBuf::push`——`push` 会把 `\` 当绝对路径清空已推内容，与原赋值犯同一类错）；
  `CurDir`/`Normal` 走 `push`（原实现遇中段 `.` 同样会整体覆盖丢路径，一并修正）；
  `ParentDir` 维持 pop。比较侧新增 `canonical_base`（仅 Windows 生效）：剥离
  canonicalize 的 `\\?\` / `\\?\UNC\` verbatim 前缀，使"根路径本身含 `..`"这类
  脏根的双保险比对能对上普通盘符写法。
- **安全语义不变**：`..` 与 NUL 仍逐段拒绝，词法包含性双保险仍生效（本次是把
  Windows 上的误杀修正为可正常判定，未放宽任何校验）。
- 纯客户端本地行为，`/api/v1` 数据协议零变更，与服务端兼容关系不变。

### 新增：设置页"关于"页签与版本号显示（2026-10-02，0.1.5；数据协议零变更）
- **需求**：设置界面显示版本号。新增**第 7 个页签"关于"**（`Settings.tsx` 的 `Tab` 联合与
  `tabs` 数组各加 `about` 项），页头 `.page-head` 右侧同时常驻一枚版本徽标——任何页签下
  都能看到当前版本，报障时可直接选中复制（`.ver`/`.about-ver` 开 `user-select: text`，
  与 `body` 全局禁选不冲突）。
- **版本来源（关键取舍）**：走 `@tauri-apps/api/app` 的 `getName` / `getVersion` /
  `getTauriVersion` **运行时**通道，不在前端引入编译期常量（package.json import /
  vite define 一律不用）——`./build.sh -V v0.2.0` 是经 `tauri --config` 注入 `version`
  字段、**不改三处版本源文件**的（见 `build-env/container-build.sh` 注入段），只有运行时
  元数据能让"页面显示"与"产物命名/包内元数据"始终一致；纯开发态两者也同为 package.json 值。
  权限侧零改动：`capabilities/default.json` 的 `core:default` ⊇ `core:app:default`，
  已含 `allow-version`/`allow-name`/`allow-tauri-version`（`gen/schemas` 实测）。
- **回落**：三个调用逐项 `catch` 兜底（非 Tauri 运行时如纯浏览器预览下 invoke 必失败），
  应用名回落 `"FileManage"`、版本显示 `"未知"`，不影响设置页其余功能；effect 带
  `cancelled` 标记，防页签重挂后旧 Promise 回写。
- **关于页内容**：客户端版本 / Tauri 框架版本 / **配套服务端**（`0.1.x（推荐，当前 0.1.1）
  · 0.7.x / 0.6.x / 0.5.x 可用`，静态文案，改动兼容矩阵时须同步此处）/ 版本取值说明。
- **跨引擎一致性（承接 bugfix/uidiff 关注点）**：新增样式 `.settings-ver(.ver)`、
  `.about-hero/.about-name/.about-ver/.about-val` 只用主题变量与既有 `.list-row` 结构，
  **未引入 `backdrop-filter` / `color-mix`**，故 Windows(WebView2) 与 Linux(webkitgtk)
  下这块新 UI 不会因引擎支持度差异而观感不一致。

### 修复+改版：Windows 下"添加服务端"对话框被设置卡片遮挡；设置改为全屏页面（2026-10-02，0.1.4；数据协议零变更）
- **现象/成因（需求1）**：Windows 客户端打开"设置"→点"添加服务端…"后表单卡片不可见、
  无法添加服务端——"添加/编辑服务端"是嵌在设置对话框 DOM 内的子对话框，其 fixed 遮罩
  受父 `.modal-mask` 的 `backdrop-filter`（为 fixed 后代建立包含块与层叠上下文）影响，
  再叠加父 `.modal-body` 的 `overflow-y:auto` 裁剪，WebView2 下子对话框被压在设置卡片
  之下（webkitgtk 表现宽容，Linux 侧未复现）。
- **根治**：`Modals.tsx` 的 `Modal` 改为 `createPortal(遮罩, document.body)`——React 树
  位置不变（state/回调不受影响），仅 DOM 挂点变为 body 直接子级：所有嵌套对话框
  （设置内服务端表单与 http 确认、ShareDialog 编辑/删除确认、VersionsDialog 回滚确认）
  一律脱离父包含块/裁剪约束，挂载顺序=显示顺序，后开的恒在上。
- **需求2（改版）**：设置界面不再浮动卡片，改为**主区整页视图**且**保持左侧导航
  （含展开/折叠）**：`View` 联合新增 `settings`，`<main>` 内渲染 `<Settings>`
  （复用 `.page` 视图容器、内容 `.settings-inner` 居中限宽 760px，Topbar 标题
  "设置"）；Dialog 判别联合删除 `settings` 分支，App 以 `openSettings(tab?)` +
  `settingsTab` 统一入口进入（侧栏"设置/用户"、AIView"打开设置"、Topbar 无本地
  目录时的回落、登录框 `from:"settings"` 回跳账户页签全部走它，切换页签经 key
  重挂生效）；Esc 离开设置回文件页（页内子对话框打开时让位给子对话框，修复旧版
  两层 Modal 同挂 window 监听、一次 Esc 连闭两层的问题）。六个页签内容与保存
  链路零改动。位置恢复（需求21）：设置视图不写入 `lastLocation`，启动仍恢复到
  进入设置前的业务视图位置（Rust 侧 `ui.view` 取值域不变，无配置迁移）。
- **折叠按钮移至左上角（需求2 追加）**：展开态"收起导航栏"按钮从 brand 行右端
  （margin-left:auto）移到**左上角首位**；折叠态左缘标签由整列拉伸+垂直居中改为
  **贴窗口左上角**小标签（18×52、右侧圆角）——展开/折叠两个入口同角，位置可预期，
  设置视图下也能随时折叠/展开导航。

### 构建体系（2026-09-27，无版本号变更/无协议影响）
- 新增 `build-env/` 多平台 Docker 编译环境（命名规范 `Dockerfile.<平台标签>` /
  镜像 `filemanage-client-build:<平台标签>`）：ubuntu22.04（deb+rpm+AppImage）、
  ubuntu24.04（deb）、ubuntu26.04（deb）、ubuntu22.04-win10（Windows NSIS 交叉，
  x86_64-pc-windows-gnu + makensis，最低 Windows 10——WebView2 Evergreen 天然门槛，
  以命名+文档落实）。
- 新增 `./build.sh -a <ubuntu22.04|ubuntu24.04|ubuntu26.04|windows10|rpm|appimage|all>
  -d <debug|release>`（默认 release）：产物命名
  `filemanageClient_<平台>_<版本号>.<扩展名>` → `release/`（debug →
  `release/debug/`）；容器内 rsync 隔离工作区（宿主工作树零污染、增量编译缓存卷）。
- **Ubuntu 20.04 环境未交付**：Tauri 2 硬依赖 `libwebkit2gtk-4.1-dev`，20.04 官方源
  无此包（libsoup3/glibc 基线亦不满足，实测），官方最低支持 22.04——记录于
  `build-env/README.md`。

### 构建体系（2026-09-29，无版本号变更/无协议影响）
- `build.sh` 新增 `-i` / `-n` / `-V` 参数（对齐 filemanageServer/build.sh 同名参数）：
  - `-i [-a <平台>]`：仅构建编译环境镜像（docker build）后退出，不编译工程；`-a`
    限定对应环境镜像，缺省四环境全建。
  - `-n [-a <平台>]`：编译前从镜像仓库拉取编译环境镜像（docker pull，镜像全名自带
    harbor 前缀 `harbor.localserver.com:9080/filemanage`，与 filemanageServer 编译
    镜像同仓库惯例，拉取名即运行名、无本地重打步骤）；裸 `-n` 拉完即退出，配 `-a`
    继续编译（CI 常用 `./build.sh -n -a all`，有 tag 时再带 `-V v<版本>`）。
  - `-V <版本号>`：显式指定产物版本号（去 v 前缀，覆盖 package.json）——经
    `BUILD_VERSION` 环境变量传入容器，仅影响产物命名与经 `tauri --config` 注入的
    bundle 版本元数据，**不改动** package.json/Cargo.toml/tauri.conf.json 三处源文件。
    tauri 的 version 字段要求严格 semver：非 semver 值告警并回落 package.json，不中断
    编译（Jenkins build #1 实测：无 tag 时 `git describe` 兜底出的 `unknown` 被注入，
    四平台全挂 `must be a semver string`——Client 版本源是 package.json，CI 无
    tag/显式参数时应**留空 `-V`**，流水线不得以 git describe 兜底值充当版本号）。
- `container-build.sh` 支持 `BUILD_VERSION` 环境变量（空=沿用 package.json，原行为；
  非 semver 值告警回落），版本覆盖与既有 deb 依赖覆盖合并为单次 `--config` 深合并注入。
- **GitHub 工具链下载加速透传**（Jenkins build #2/#3 实测卡在 AppImage 的 AppRun
  GitHub 下载直至超时）：宿主设置 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR`（gh-proxy 类，
  改写后 URL=基址+完整原 URL）/ `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR_TEMPLATE`
  （`<owner>/<repo>/<version>/<asset>` 模板式，优先）/ `HTTP(S)_PROXY`（无 mirror 时
  bundler 走系统代理）任一，`build.sh` 自动按需透传进容器（tauri-cli 官方 env，
  实测 @tauri-apps/cli 2.11.4 的 releases 类工具下载生效；raw.githubusercontent 的
  插件脚本仅认代理）。下载件缓存于共享卷 `fmc-cache`，配好镜像后任一环境成功一次
  即四环境及后续构建全复用。

### 修复：服务端地址缺协议头导致连接报 "builder error"（2026-10-02，0.1.3；数据协议零变更）
- **现象/成因**：服务地址填 `192.168.1.82:8484`（省略 `http://`）时客户端报
  `无法连接服务端: builder error`，而同一地址 telnet/浏览器访问正常——reqwest 对缺
  scheme 的字符串 `Url::parse` 失败归类为 Builder 错误，其 Display 只有字面
  "builder error"（真实成因藏在 `source()`），请求在本机即失败、从未发出。
- **三路归一**：`config.rs` 新增 `ServerConf::norm_base/normalized_base`（去首尾空白，
  缺省 scheme 按 `http://` 补全）；`AppState::load` 启动即归一内存配置——Rust 请求
  路径与前端消费方（分享链接拼接等）共用同一权威值，下一次 save_config 自然落盘修正；
  `serverapi.rs` 的 `base_of`（全部请求 URL 的唯一拼接点）改用归一值，`apply_tls` 的
  `insecure_tls` https 判断同口径；`Settings.tsx` 保存服务端先补协议头、再照常走
  既有"明文 HTTP 二次确认"（非本机地址仍需显式确认，不静默绕过安全检查），表单标签
  说明同步。
- **错误透出**：`serverapi.rs` 新增 `req_detail/req_err`，六处"无法连接服务端"文案
  带上 reqwest source（如 `builder error: relative URL without a base`），不再误导
  为网络故障；`client_for/stream_client_for` 构造失败报"HTTP 客户端构造失败: …"带成因。

## [0.2.0] - 2026-10-03（需求41：本地目录整树上传到远程）

- **需求原句**：客户端和服务端新增支持目录上传，右键本地目录上传至远程服务端，本次功能开发版本号变更为 0.2.0。
- **右键菜单**：本地模式目录项不再置灰——`App.tsx` 菜单项对目录显示"上传目录到远程…"，复用 `UploadToDialog`（新增 `isDir` prop：标题/按钮/提示文案区分，提示明确"整树复制到所选服务端的根目录下（<目录名>/…，含空目录；符号链接不上传）"）。
- **`fs_walk`（Rust 新命令，localfs.rs + lib.rs 注册）**：显式栈迭代枚举整棵树（不递归、无爆栈风险），`relPath` 相对被遍历目录且全程正斜杠（Windows 安全）；**符号链接（文件与目录）一律跳过**（防逃逸根/成环）、`.fmtrash` 段跳过（服务端保留名）；深度 64 / 条目 20000 硬上限，超限 `truncated=true` 前端整体拒绝（绝不上传半棵树）；中途读目录失败=整个遍历报错（确定性失败）。入口经 `resolve_in_root`（需求6 路径底线）。
- **远端骨架**：`server.ts` 新增 `serverMkdirs`——`POST /api/v1/mkdirs`（Server 0.2.0 加性端点）按 500 条/批一次建好目录树（含空目录）；服务端 <0.2.0 报"端点不存在"（`isMissingEndpoint`：`not found`/`HTTP 404/405`）时**自动退化为逐个 `POST /mkdir`**（幂等 `MkdirAll` 递归，语义一致、仅往返更多）；其他错误（权限/jail/暂停）整服务端跳过并提示，其余目标照常。
- **组任务聚合（transfer.ts）**：`TransferTask` 新增 `group/isGroup/files/filesTotal`；`enqueueGroup` 子任务只进注册表**不进 order**（UI 快照天然只含组行），并发池默认 3（现有 `enqueue` 无并发上限，整树裸入队会同时开几百路）；组行聚合总字节进度 + `done/total 个文件` + 终态汇总消息；`patch` 对子任务的变化自动上卷 `settle`。组级 `pauseGroup/resumeGroup/cancelGroup/retryGroup`（继续=同 transferId 断点续传；重试只重跑 error 子任务，其中冲突失败者置 `overwrite=true` 走覆盖重试——服务端覆盖前先存版本，需求3/6 语义）；`rowActions(t)` 给两个传输视图统一选路；`removeTask/clearFinished` 级联清理子任务、`activeCount` 角标按组行计。
- **完成联动**：`watchGroup` 整组到终态才一次汇总通知（`目录上传完成：photos（37/37 个文件）`）+ 刷新文件列表；空目录（无文件）只建骨架并提示。
- **已知限制**：子任务暂不在 UI 展开（`getGroupChildren` API 已留）；组内冲突文件的重试为整组粒度（只重跑失败项）；非 UTF8 文件名沿用 `fs_list` 的 `to_string_lossy` 口径；上限（深度 64/条目 20000）为硬拒绝，后续如需分批可再议。
- **兼容**：配套 Server 0.2.x（推荐，当前 0.2.0）；配 Server 0.1.x/0.7.x/0.6.x 目录上传退化为逐个 mkdir、其余功能与 0.1.7 一致；配 Server ≥0.1.0 的其余协议不变。三处版本源文件 0.1.7 → 0.2.0（需求19）。

## [0.1.0] - 2026-09-22（首个基线版，需求31；双库全功能回归通过后定版）

### 新增
- **自助修改密码（需求31，账户页）**：`Settings.tsx` 账户页新增"修改我的密码"折叠表单
  （旧密码 + 新密码，前端校验 ≥6 位且不同于旧密码）；Rust 命令
  `srv_change_password`（`serverapi.rs`，`lib.rs` 注册）POST
  `/api/v1/auth/change-password`——不经 `srv_call`（避免 401 自动续期掩盖"旧密码错"），
  成功后：若该服务端+账户已"记住密码"则用 `secret::set_password` 把凭证库里的旧口令
  更新为新口令，清空本地 token/refresh（服务端已作废全部会话），广播
  `fm-config-changed` 触发前端回未登录态并提示用新密码重登。

### 版本
- `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 三处 → 0.1.0。

### 兼容
- 对服务端加性依赖，无客户端↔Rust 协议破坏；管理员账户仍不可在客户端登录
  （含 0.1.0 文件超管，由服务端拒绝）。
