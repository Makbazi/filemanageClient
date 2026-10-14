# Changelog — filemanageClient

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
**每次版本变更必须声明兼容的其他模块版本（需求20）。**

> 需求39（2026-09-21 维护者决策，本批用户清单第 9 条）：正式首发前从未发布，历史变更清单整体清空、从此
> 重新记录；此前明细可查本仓库 git 历史（分支 feature/dev_new_able）。

## 兼容矩阵

| filemanageClient | 配套 filemanageServer | 说明 |
|---|---|---|
| 0.3.7（当前） | **Server 0.2.7 推荐基线**（本批配套发布；对客户端为纯加性——`/api/v1` 数据协议零变更）；全 Server 0.2.x/0.1.x 兼容 | 用户 2026-10-14 清单 1/2/3/5/6 条（转码进度与取消修复 + 文件夹上传断点恢复 + H.265 四档播放 + 批量选择/操作 + 设置页数据源切换）。**数据协议零变更**：恢复对账所用 `GET /upload/session`、`POST /check` 均为既有端点（配 ≤0.2.0 无 /check 时自动跳过判同、照常恢复）；转码/渲染/批量/设置切换全为客户端本地行为。配 0.2.x 历代：上传恢复对账完整生效（0.2.1+ 有 /check 加速器；会话 completed 判据 0.1.x 起即可用）。三处版本源 0.3.6→0.3.7（package-lock/Cargo.lock 同步） |
| 0.3.6 | **需 Server 0.2.4（认证契约破坏批）**；0.2.3 可用但降级；≤0.2.2/0.1.x 见说明 | 用户 2026-10-12 清单 1/2/3 条 + 追加④⑤（H.265 自动转码 + 浏览零整文件 + 单凭证认证重构 + 图片缩放查看 + 版本号定版 0.3.6）。**破坏批**：登录只取 `{token}`（不再读 refreshToken/expiresIn）、全请求带 `X-Client-Id` 头、401→自动重登（记住密码）、退出登出、闲置 1h——认证语义以 Server 0.2.4 为准；配 0.2.3：clientId 被旧服务端忽略（不绑定、refresh 走旧端点仍可用——即 0.3.5 的认证行为，登录响应形状本就只读 token 面兼容）、1h 窗口是服务端策略与本客户端无关；配 ≤0.2.2：浏览零整文件后 415/404 一律图标（不再有本地缩放兜底——48MP 大图为 Server 0.2.4 出图面恢复）。⚠️ 0.3.5 的"415 整文件兜底"即本批需求2 的带宽根因，本版本移除。三处版本源 0.3.5→0.3.6（package-lock 同步） |
| 0.3.5 | **0.2.x（推荐；当时当前 Server 0.2.3）**；0.2.2–0.2.1/0.2.0/0.1.x 亦可用 | 本批用户清单 1–5 条（Windows/Linux 缩略图修复 + 面板逐条隐藏 + 重登自动刷新 + 首看"文件不存在"修复）。**数据协议零变更**：全部为客户端本地行为——415 回退旧管线/视口优先调度/single-flight 均不新增跨进程语义；配 0.2.1+ 高像素图由"永久图标"改"本地缩放兜底"（一次性静默整文件入缓存、此后命中秒回，浏览零下载主路径不变）；配 ≤0.2.0 行为同 0.3.4。三处版本源 0.3.4→0.3.5 |
| 0.3.4 | **0.2.x（推荐；当前 Server 0.2.3）**；0.2.2 及以下/0.1.x 亦可用 | 认证协议配套批（用户第三批清单第 3 条）：Server 0.2.3 去 JWT 后凭证变为认证图随机值（token/refreshToken 同串的兼容别名），**客户端代码零改动**（对凭证本就无格式假设），登录/刷新/分享/管理台全链路不变；升级服务端后存量会话失效重登一次由既有 AUTH_REQUIRED 路径承接。三处版本源 0.3.3→0.3.4；设置「关于」配套文案与注释措辞同步 |
| 0.3.3 | **0.2.x（当时推荐；当前 Server 0.2.2）**；0.2.1/0.2.0/0.1.x 亦可用 | 本批用户清单 1/2/3/4/5 条（查看零传输 + 缩略图对齐 + ffmpeg 可配 + 传输面板显隐）。**数据协议零变更**——全部能力为客户端本地行为（fm-transfer 静默化、srv_thumb 契约收紧、ffmpeg 转码、面板显隐）或既有端点的行为面（Server 0.2.2 的 /thumb 白名单补 BMP 为服务端加性能力）。配 0.2.2：网格 BMP 出图与本地一致；配 0.2.1：BMP 服务端 415 → 永久图标（≤8MiB 不再整文件兜底——需求"浏览不触发下载"的收紧面）；配 ≤0.2.0（无 /thumb）：缩略图回退旧管线整文件**静默**入媒体缓存+本地缩放（0.3.2 已声明的兼容面，0.3.3 起该通道不出任何传输行）。ffmpeg 档依赖用户自备 ffmpeg（未内嵌），未配置时系统解码失败面板回落"外部播放器"旧兜底。三处版本源 0.3.2→0.3.3 |
| 0.3.2 | **0.2.x（推荐；当前 Server 0.2.1）**；配 Server ≤0.2.0 逐条自动退化（下行"退化矩阵"） | 本批用户清单 1/2/3/4/5/6 条（上传中断兜底+缩略图体系）。**依赖 Server 0.2.1 两个新端点的功能均为可选加速面**：`GET /thumb`（网格浏览零下载——只回缩略图字节不再整文件入缓存）；`POST /check`（目录重传预检：相同跳过/同名不同内容弹窗询问）。404（旧服务端）时：缩略图自动走 0.2.1 旧管线（整文件入缓存后本地缩放，现受 10GB LRU 约束）、目录重传回到 0.2.0 冲突语义（全量重传+409 覆盖重试）。**与新增端点无关的断连修复对配任何版本服务端都生效**：分片重试、complete 移出 120s 超时通道+断连轮询（本批主根因修复）、坏会话 DELETE 重建、取消作废服务端会话、GET/DELETE /upload/session 接线（端点 0.1.x 起即有）。新增本地能力：上传账本（localdb user_version 2，重启续传）、磁盘缓存 ≤10GB LRU+孤儿清理+设置页用量/清空、缩略图内存 ≤2GB blob LRU+IntersectionObserver 视口调度（可见±2 屏，全量无 60 上限）；新 Rust 依赖 sha2（锁内 0.10.9 提为直接依赖，零新下载）；CSP/capabilities 零改动（blob: 已在 img-src，字节走 IPC ArrayBuffer 不 fetch asset） |
| 0.3.1 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x 亦可用 | **纯构建体系修复，功能与兼容关系与 0.3.0 完全一致、数据协议零变更、产物代码零变更**：win10 交叉编译镜像补装 `libayatana-appindicator3-dev`——tauri-cli 在 Linux 宿主开启 tray-icon 特性后无条件探测 appindicator（判宿主机不判 `--target`），0.3.0 的 NSIS 打包因此崩溃（Jenkins #48），本版本修复后 Windows 产物正常产出 |
| 0.3.0 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x 亦可用 | 承接 0.2.1 兼容关系**零变更、数据协议零变更**：H.264/H.265 播放 = WebView 原生**系统解码器**（Windows Media Foundation / Linux GStreamer）+ 可配置**外部播放器**兜底（字节仍取既有 `GET /api/v1/preview` 媒体缓存通道，Server 不感知）；托盘常驻/关窗行为/单实例/`open_media`·`test_player_command` 均为客户端本地 Rust 行为，不跨进程。Linux 托盘运行期依赖 appindicator（deb depends `libayatana-appindicator3-1`）。⚠️ 该 tag 的 windows10 产物因编译环境探测崩溃未产出，由 0.3.1 修复 |
| 0.2.1 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x 亦可用 | 承接 0.2.0 兼容关系**零变更、数据协议零变更**：网格缩略图全量显示与相机 RAW（NEF/CR2/ARW/RAF…）查看/预览均为客户端本地 Rust 行为——字节仍取自既有 `GET /api/v1/preview` 媒体缓存通道（同端点同权限、匿名语义不变，需求6 无新增面）；新增 `fs_thumb`、`srv_thumb` 改版（改返回媒体缓存缩略图路径、加 ver）属本地 Rust 命令契约，不跨进程。目录上传仍依赖 Server ≥0.2.0 |
| 0.2.0 | **0.2.x（推荐；当前 Server 0.2.0）**；0.1.x 亦可用 | 需求41 目录上传：本地模式右键目录 → Rust `fs_walk` 递归枚举（跳符号链接与 `.fmtrash`，深度 64/条目 20000 硬上限，超限整体拒绝绝不传半棵树）→ `POST /api/v1/mkdirs` 一次建好远端目录骨架（含空目录；配 Server <0.2.0 自动退化为逐个 `mkdir`，幂等递归语义一致、仅往返更多）→ 逐文件入队上传（并发池 3 限流），传输 UI 整目录聚合为一条组行（总字节进度 + 文件计数，暂停/继续/取消/重试整组粒度；冲突文件经组"重试"按覆盖语义重跑——服务端覆盖前先存版本，需求3）；其余功能承接 0.1.7 零变更 |
| 0.1.1–0.1.7 | 0.1.x（当时推荐；当前 Server 0.1.1） | 兼容关系承接 0.1.6 不变（数据协议零变更：查看/预览分离与大图内联查看为纯客户端 UI/本地上屏缓存行为，图片取字节由 data URL 改走**既有** `/api/v1/preview` 端点的媒体缓存通道，服务端无感；`fs_media_cache`/`srv_media_cache` 新增可选 `ver` 参数属本地 Rust 命令契约，不跨进程）。0.1.6 仅修复 Windows 本地目录路径校验误报（纯客户端本地行为），数据协议零变更。0.1.5 新增设置页"关于"页签与页头版本号显示，纯 UI 行为、数据协议零变更（"配套服务端"一栏为兼容矩阵静态文案，不产生新的接口依赖）。新增账户页自助改密（需 Server ≥0.1.0 的 `/auth/change-password`；配旧服务端时该按钮报 404/405，其余功能不变）。（家目录虚拟根与 jail 语义服务端基线起即有，客户端透明处理。）**Server 0.1.1（文件存储驱动、管理台切换/导出/暂停）为服务端存储与管理面增项，数据协议零变更，本客户端无感兼容（仅更新本兼容列表，代码不动）**。Client 0.1.1–0.1.6 为构建体系与客户端本地修复/改版（baseUrl 协议头归一、连接错误透出、对话框层级修复、设置全屏页、关于页版本信息、Windows 本地目录校验修复），0.1.7 为查看/预览分离 + 大图查看 + 查看器全屏，均纯 UI/本地行为，数据协议零变更，对本矩阵无影响 |

## 未发布版本
### 转码进度与取消 + 上传断点恢复 + H.265 四档播放 + 批量选择 + 设置页切换数据源（2026-10-14，0.3.7；配套 Server 0.2.7，**数据协议零变更**）
- **需求原句**（用户 2026-10-14 清单）：①配置ffmpeg打开h265视频显示"在转码"但看不到进度、无法取消；转码未完成关闭，再次打开点击转码提示"ffmpeg不可用"（实际ffmpeg正常）；②上传文件夹（与h265同目录）异常中断无法恢复；③h265播放考虑四种使用方式——系统解码器/自定义ffmpeg转码/外部播放器/自定义ffmpeg解码+原生渲染；⑤客户端文件支持批量选择、批量操作；⑥设置页下拉切换本地/服务端一/服务端二，切换不退出设置界面；⑦客户端版本 v0.3.7。
- **需求①（转码治理，player.rs 重写核心路径）**：根因三件套——`metadata(len>0)` 即复用半成品（`+faststart` 的 moov 只在正常退出时写，中断产物永不可播却永被当成品→重开秒回坏文件，解码失败冒充"不可用"）；tokio `kill_on_drop=false` 默认使孤儿 ffmpeg 跨会话续写产物（Windows 句柄占用令 `-y` 覆写失败→转码失败→"不可用"假象）；无进度/取消面。修复：产物 `.part` 暂存 + 成功原子 rename（存在=完整，碎片进 cachemgr 24h 孤儿回收）；`kill_on_drop(true)` + 作业注册表（key→取消标志+Notify，`ffmpeg_cancel` 命令 kill+清碎片）+ 每 key single-flight（对齐 MEDIA_FLIGHT 纪律，修双开互踩）；`-progress pipe:1` 解析 `out_time_ms` 经 `fm-ffmpeg` 事件出百分比（时长同源 `probe_video_info` 一次窥探编码/时长/音轨）。查看器转圈面板显示进度条+`%`+耗时/总时长+**[取消转码]**；关闭查看器/换文件/正常退出全部取消在飞转码（`RunEvent::ExitRequested`→`ffmpeg_cancel_all`）；"转码已取消"走中性提示不再冒充"不可用"；缓存条目被 LRU 淘汰时自动重取媒体缓存重试一次。**system/ffmpeg 两档与失败面板兜底全部受益**。
- **需求③（四档播放，新增 render 档）**：`ui.videoDecoder` 四值 `system | ffmpeg | render | external`（默认 system 不变）。**render=ffmpeg 解码 + 原生渲染**：`ffmpeg_frame` 按需解单帧（`-ss` 定位→mjpeg 管道→前端 canvas 上屏，**不落盘整文件**，0.25s 时间桶小缓存）+ `ffmpeg_audio_track` 一次性抽音轨为 `<key>.audio.m4a`（`.part` 暂存同纪律）经 `<audio>` 驱动时钟对时；无音轨/提取失败自动退化内部时钟静音播放；播放/暂停/拖拽进度条/时间显示（新组件 FfmRenderView）。明示能力边界：逐帧帧率随 CPU（约 2–4 fps）、不含字幕轨——定位"立刻要看、不等整段转码"场景。设置页四档 radio + 说明同步。
- **需求②（文件夹上传断点恢复大修）**：根因=恢复重传不对账——中断时服务端其实已合并完成（响应/账本没落）的条目被盲目重传撞 409，且服务端 `CreateOrResume` 按路径命中旧会话**原样带回过期 BaseHash** → 永久冲突死循环（等 7 天僵尸清理）。修复三层：①`resumeJournalGroup` 对账前置——条目会话 `GET /upload/session` 判 `completed` 直接落账 done（免重传）；其余批量 `POST /check` 判 `same` 落账 done（旧服务端无端点静默跳过）；本地文件变过（账本 mtime 判据）→ 作废服务端会话防旧分片混拼；failed/不可续会话 → 覆盖语义入队。②Rust `upload_inner` 冲突即 DELETE 会话（重试必然新建、带当次 baseHash，死循环根治）；`srv_upload` 冲突后本地 SHA-256 与远端 content_hash 比对——相同直接判成功落账（崩溃恢复主场景零重试闭环）。③账本证据补齐：`fs_walk` 携带 mtime，`lg_set_children` 落真实 mtime+sha（0.3.2 恒 0/空的缺陷）；修复 0.3.2 遗留 **fs_file_hashes 相对路径组合错误**（按遍历目录相对解析全数 miss，pass2 判同长期空转）——改为根相对路径。UI 侧：恢复的组经 `fm-group-resumed` 事件补挂终态监听（完成汇总通知+列表刷新，旧实现恢复组静默）；侧栏"传输"角标并入账本待恢复组数（重启后右下角面板空、旧实现只有进传输页才发现）。
- **需求⑤（批量选择/批量操作）**：列表视图新增复选框列（表头三态全选/清空）、网格卡片左上角勾选框；**Shift+单击=连续范围选**、Ctrl/Cmd+单击=加选（既有）、**Ctrl/Cmd+A=全选筛选结果**；工具栏"已选 N 项 [全选][取消选择]"状态条。批量操作复用既有链路（下载/复制/移动/删除作用于全部选中项；重命名保持单选语义）。
- **需求⑥（设置页切换数据源不退出）**：设置页签行之上新增常驻"当前数据源"下拉（本地·各目录 / 服务端N·各名称（已登录/游客）），选择即切换：App `pickServer/pickLocalRoot` 增加 `stay` 形参——切换不再强制 `setView("files")`，用户停留在设置页继续配置；未登录服务端以游客切换（登录走"服务端"页签按钮/登录框，登录后回设置页既有 from:settings 承接）。顶部快速切换行为不变。
- 本地零协议面：新 Rust 命令 `ffmpeg_cancel`/`video_media_info`/`ffmpeg_frame`/`ffmpeg_audio_track`/`fs_mtimes`/`lg_item_state` 均为进程内契约（约定：不跨工程）；CSP/capabilities 零改动（canvas createImageBitmap 上屏、字节走既有 IPC ArrayBuffer 通道）；tokio 特性无新增（sync 0.3.5 已启）。
- 验证：`npm run build` ✓、`cargo check` ✓（0.3.7 三处版本源 + package-lock/Cargo.lock 同步）；ffmpeg 管线参数本机实测（`-progress pipe:1` 逐块 out_time_ms、`.part`+`-f mp4` 暂存改名、`-ss` 定位单帧 mjpeg、无音轨 `-map 0:a:0` 非零退出判据）。
- 兼容：**Server 0.2.7 推荐基线，全 0.2.x/0.1.x 兼容**——本批全部能力对协议零依赖（恢复对账用既有端点，配 ≤0.2.0 跳过判同仍可用）；0.3.6 认证语义不变。
### 单凭证认证 + H.265 自动转码 + 浏览零整文件（2026-10-12，0.3.6；配套 Server 0.2.4，**认证契约破坏批**）
- **需求原句**（用户 2026-10-12 清单）：①H.265 的视频依旧无法播放；②打开服务端大量图片目录网络带宽很高——只有双击查看或下载时数据才真正过来，仅预览只要一个很小 KB 的缩略图；③登录认证只返回一个 token 的哈希，role/access 之类都不要，服务端用这一个 map 找真实 user；token 只要一直活跃且客户端唯一标识不变就一直可用，客户端退出或一小时无活动需重新登录获取新 token；服务端滑动续期客户端无感、凭证只在重新验证时变化；退出重开有已保存密码直接自动登录；多客户端同账号用客户端唯一标识区分、不互相竞争；④图片类型文件可以放大缩小查看；⑤本次变更后服务端版本号 v0.2.4、客户端版本号 v0.3.6。
- **需求③（认证收敛，Rust 层为主，TS 零协议代码）**：
  - **单凭证**：`srv_login` 只读 `token`（Server 0.2.4 用户端口响应只 `{token}`）；`ServerConf.refreshToken`/`secret.rs` refresh 条目删除（`set_tokens` 单值化并顺带清理旧 refresh 键；`types.ts` 同步）；401 处理链由"轮换 refresh"改**自动重登**（`try_autologin`：配置用户名 + keyring 记住的密码 → 登录取新凭证 → 重试原请求）——覆盖"重启客户端自动登录、1h 闲置过期静默续命失败后自愈、改密后新密码自动重登"；未记住密码/无凭证库 → 既有 AUTH_REQUIRED 登录框（LoginModal 文案 3 周→1 小时）。
  - **客户端唯一标识**：`AppConfig.client_id`（首次启动 `Uuid::new_v4` 生成并持久化 config.json，`save_config` 视同 token 的 Rust 权威字段、绝不允许前端快照清空）；登录体带 `clientId`（服务端绑定）；`client_cached` 经 `default_headers` 给**一切请求**注入 `X-Client-Id`（srv_call/authed_get/上传分片/下载/预览/缩略图全覆盖）——绑定会话被其他标识冒用直接 401 重登。多客户端同账号各持己凭证互不挤占（登录从不吊销他人）。
  - **客户端无身份查询（0.3.6，用户补充规则「客户端不需要知道自己是什么角色，也不需要查」）**：
  账户页（Settings→AccountTab）移除 `GET /auth/me` 调用——显示账户名取本地配置 `srv.username`
  （登录时 Rust 权威落存）；角色文案（管理员/普通用户）删除。服务端 /auth/me 同步收敛为仅回
  `{username}`（对仍调用它的旧客户端/移动端无害：role 缺省、解析带默认值不崩）。客户端可查询的
  仅服务端基本信息（health/版本发现）与业务数据（roots 目录清单等），不含任何「我是谁/什么角色」面。
- **退出即作废**：`RunEvent::ExitRequested` 钩子 `logout_all_for_exit`——对带凭证的服务端尽力 POST `/auth/logout {token}`（Bearer+头，单请求 1.2s 超时、失败忽略）；异常退出由服务端 1h 闲置过期兜底。`srv_logout`（用户主动登出）改 `{token}`+Bearer。
- **需求①（H.265）**：根因=旧实现**只看容器后缀不看编码**（`WEBVIEW_DIRECT_EXT` 短路放行 HEVC-in-MP4；system 档全靠撞解码错误）。修复（仅客户端）：新 `player::video_codec_probe`/`probe_video_codec`——`ffmpeg -i` 解容器头（毫秒级）取首条 `Video:` 编码名，正向结果进程内缓存；`ffmpeg_playable` 容器短路前先探编码，HEVC 命中不再原路返回、直接转码（修 H.265-in-MP4）；FileViewer system 档：媒体缓存就绪→探测→HEVC 且 ffmpeg 可用则**自动转码窗口内播放**（复用转圈 UI），转码失败（含 ffmpeg 未配置）直落既有 ffmErr 引导面板，不再先撞一次必然失败的 `<video>` 解码；判不了（无 ffmpeg）/非 HEVC→原行为。设置页视频三档说明文案同步。
- **需求②（浏览零整文件）**：`srv_thumb` **移除 0.3.5 的 415/404 整文件静默兜底**（`ServerThumb` 删 Legacy/Unsupported 变体；415/404/413/403 一律永久无图=图标）——网格浏览每图只拉服务端 ≤512px JPEG（几十 KB），原图字节仅在双击查看（mediaCache）/下载时到来；`server.ts` thumbPath 契约注释改写；FileView `SLOW_BYTES` 慢通道随兜底废除（/thumb 恒为小响应，并发统一 3）。大图出图面由 **Server 0.2.4** 的 YCbCr 平面 50MP/9000px 闸门恢复（webp/heic 等无解码器形态=图标，明示边界）。
- **需求④（图片缩放查看，仅客户端）**：FileViewer 图片分段加缩放——滚轮以**光标为锚**缩放（原生 `wheel` 监听 `passive:false`，0.2x–16x）、放大后指针拖拽平移（`setPointerCapture`，`touch-action:none`）、头部工具条 [－][比例%][＋][适应]；切文件/重载自动复位；"双击图片关闭查看/Esc 关闭"既定契约不变（双击挂在缩放容器上，行为同前）；`base.css` 新增 `.viewer-zoombox/.zlabel-zoom`。眼睛预览（PreviewModal）维持"缩略图观感"不缩放（查看/预览分工不变）。
- 本地零协议面：托盘常驻/传输账本/缓存体系等历代能力不动；tokio 特性无新增；CSP/capabilities 零改动。
- 验证：`npm run build` ✓、`cargo check` ✓（v0.3.6 三处版本源+package-lock 同步）；运行时人工冒烟见根/Server CHANGELOG（自动重登、错标识 401、退出登出、HEVC 自动转码、`$APPCACHE/media` 浏览不再出现全文件）。
- 兼容：**需 Server 0.2.4**（见兼容矩阵行内说明）；配 0.2.3/≤0.2.2 的降级面已明示。移动端 filemanagemobile 本批不改（服务端对未绑定会话不查头、refresh 消失走"过期重登"，兼容降级可用）。

### 缩略图与稳定性修复批次（2026-10-11，0.3.5；配 Server 0.2.3，数据协议零变更）
- **需求原句**（用户 2026-10-11 清单）：①修复客户端在 windows 平台下查看服务端图像时缩略图预览显示问题；②修复客户端在 linux 平台下缩略图显示问题；③右下角可显示隐藏的传输列表——传输中任务后跟暂停/继续按钮，传输完成后按按钮该条不再于右下角显示、传输界面保留；④修复服务端重启客户端重新登录需要按一下刷新按钮才能显示文件的问题；⑤修复查看一个文件概率出现第一次查看时提示文件不存在、再次查看又正常的问题。
- **需求①②（缩略图，根因三条）**：
  - **415≠无图**（Windows 截图主症状：同文件夹混机型，高像素机身段全落图标）：服务端 `GET /thumb` 有像素闸门（`thumbMaxPixels=12MP`/边长 6000px/格式白名单，thumbdec.go——守服务端 ≤200MB 解码内存峰值），高 MP 相机 JPEG 与 NEF 大内嵌预览被 415，0.3.3 契约把 415 判"永久无图"；而客户端 Rust `image` crate 解码能力强于 Go 标准库。修复：`srv_thumb` 新增 `ServerThumb::Unsupported`——415 落入旧管线本地缩放（静默整文件入媒体缓存一次，此后 exists 命中秒回，仍受磁盘 LRU 管辖）；413（>64MiB 整文件拉取过重）/403（权限）维持永久无图。服务端零改动。
  - **调度饿死**：FileView 队列纯 FIFO 无视口优先、总池仅 3——滚动新进入的格子排在全部预取项之后，大文件整文件兜底占满槽位使后段 3 轮退避耗尽。修复：两遍扫描优先取仍在视口(±2屏)内的格子（"滚到哪先出哪"）；`size>16MiB` 慢通道并发 ≤1 隔离饿死源；瞬时耗尽不再永久化（`failedRef`+单元格再次进入视口重武装重入队，每 key ≤3 批防死循环）；`queuedRef` O(1) 去重。
  - **同键并发踩缓存**（Linux 症状：坏图永久落缓存/间歇失败）：`srv_thumb` 产物 tmp 名固定 `<hash>.thumb.jpg.tmp`——目录切换复位后旧 future 与新建并发同键，Linux rename 静默互踩产生坏 `.thumb.jpg` 永久缓存，Windows rename 目标已存在报错成假瞬时失败。修复：tmp 名加 uuid 尾段（仍匹配 cachemgr `.thumb.jpg.tmp` 24h 孤儿回收）+ rename 前后 exists 复用成品。
- **需求③（面板逐条隐藏）**：`TransferTask.panelHidden` 纯展示标记 + `dismissFromPanel(id)`；终态行（完成/已取消/失败）新增"从面板隐藏"按钮——仅移出右下角面板，TransfersView 传输管理页记录保留（两视图共享注册表，但隐藏只影响面板过滤）；任务再次运行（继续/重试）`run()` 自动清除标记回到面板；暂停/继续按钮 0.3.3 已有不动；面板头部计数与 FAB 角标随可见条数。
- **需求④（重登不出列表）**：根因=服务端重启旧凭证失效→401 清空 entries→登录成功路径保持同 rootId 且 path 未变，列表 effect 依赖零翻动，只能手点刷新。修复：`loginEpoch` 计数并入列表 effect 依赖，`fm-config-changed` 广播（Rust 认证态变更唯一事实源事件）时 +1——稳定原始值不参与约定 4 的对象引用环路。
- **需求⑤（首看"文件不存在"）**：根因=`srv_media_ensure` `dest.exists()` check-then-act 竞态——同键双路并发（StrictMode 双 effect、FileViewer+PreviewModal 同开、≤0.2.0 旧管线缩略图与查看并发）共用同一 `<dest>.part`/RAW `.raw-src`：先完成者 rename/删 scratch，后进者 append/rename/read 撞 ENOENT（第二次 exists 短路即好，与用户描述吻合）。修复：`MEDIA_FLIGHT` per-key single-flight（std Mutex 只护表、无 await 持锁；tokio::sync::Mutex 护下载；锁内二次 check 短路复用成品；表项在"仅剩 map+自己"计数时摘除、摘除瞬间有等待者则放回）。Cargo.toml tokio features 增 `"sync"`。
- 三处版本源 0.3.4→0.3.5；CSP/capabilities/`/api/v1` 零改动；localdb schema 零变更。

### 认证协议配套：服务端去 JWT（2026-10-10，0.3.4；配 Server 0.2.3，客户端代码零改动）
- **需求原句**（用户 2026-10 第三批清单）：①两工程版本号相关文档/注释不超过当前版本；
  ②客户端↔服务端认证不使用 JWT，凭证为随机哈希，真实身份存服务端（认证 map：进程内
  ≤20 万默认、redis ≤500 万、LRU、持久化、过期清理与有效期刷新、三层同步与重启恢复）；
  ③定版 Client 0.3.4 / Server 0.2.3。
- **客户端影响=零代码改动**（设计验证）：Rust 侧对凭证从未有格式假设——`srv_login` 只取
  `token`/`refreshToken` 字符串、`bearer_auth` 原样透传、keyring（secret.rs）存取、
  `try_refresh`/logout/change-password/分享 st 全为字符串级操作；前端仅用 token **存在性**
  判游客（api.ts/datasource anonymous），显示用户名取自登录输入的 `ServerConf.username`、
  账户页 `{id,username,role}` 来自 `/auth/me`——全部与凭证内部结构无关。服务端 0.2.3 保持
  响应字段形状（`refreshToken`=同一随机凭证的兼容别名），故 0.1.x–0.3.3 历代客户端均无感。
- **升级一次性行为**：配 Server 0.2.3 后存量令牌（旧 JWT/旧 refresh 串）一律 401 →
  既有 AUTH_REQUIRED→登录框路径承接，重登一次即恢复；分享访客重输口令一次。
- **本批文件改动**：三处版本源 0.3.3→0.3.4 + package-lock 内嵌版本同步；README 陈旧
  「当前版本 0.2.0」修正为 0.3.4；serverapi.rs/secret.rs/config.rs/lib.rs 认证相关注释
  按不透明凭证改写（token/refreshToken 同串、401→轮换重试）；Settings.tsx 关于页配套
  服务端文案 `0.2.x（推荐，当前 0.2.3）· 0.1.x 可用`（改动矩阵须同步此处的约定不变）；
  全工程历史批次版本引用去版本号化（需求1）。
- **兼容**：0.3.4 配 Server 0.2.3（推荐）；配 0.2.2 及以下/0.1.x 无感（协议字段形状未变、
  凭证对客户端始终不透明）；旧客户端配 0.2.3 服务端见上「升级一次性行为」。
- 验证：`npm run build` ✓；`cd src-tauri && cargo check` ✓（v0.3.4，零警告）。

### 修复+新增：查看零传输 + 缩略图对齐 + ffmpeg 可配转码 + 传输面板显隐（2026-10-06，0.3.3；配 Server 0.2.2，对旧服务端零退化成本）
- **需求原句**（用户 2026-10 第二批清单）：①查看服务端视频触发了下载——查看服务端文件不得触发
  传输，上传下载只许手动触发；②服务端按缩略图预览也要滚动到哪里哪里显示，向上向下缓存与本地
  目录机制保持一致；③可在设置界面配置 ffmpeg 用于视频解码播放，默认系统解码但允许用户配置；
  ④右下角上传/下载弹窗要可关闭、按按钮可再弹出（显隐）；⑤版本 Client 0.3.3 / Server 0.2.2。
- **查看零传输（serverapi.rs 主修，需求①）**：根因——查看/预览的媒体缓存取字节
  （`srv_media_ensure`→`download_inner`，transfer_id=`media-<hash>`）发 fm-transfer 事件，
  前端 `applyEvent` 把未入队 id **自动注册为可见下载行**（服务端视频一打开右下角就挂出
  "下载"，缩略图旧管线回退同理）。修复：`download_inner` 增 `silent` 参数——查看/预览/缩略图
  通道传 `silent=true`，**不发任何事件**（手动上传/下载恒传 false，暂停/进度/完成语义不变）；
  字节仍走既有 `GET /api/v1/preview`（权限/匿名语义零变化，查看允许临时落盘进缓存的既定边界
  保留）。此后传输面板/传输页只出现用户手动发起的上传下载。
- **缩略图契约收紧（需求②，出图面与服务端 0.2.2 对齐）**：`srv_thumb` 返回改
  `Result<Option<String>, String>`——**Ok(None)=永久无图**（413/415/403：服务端明确出不了图，
  直接落图标，不再按瞬时错误空转重试 3 轮、不再整文件下载兜底）；Err=瞬时（网络/429 重试耗尽/
  401/5xx，FileView 队列退避 ≤3 轮不变）。`size_hint` 参数移除（回退闸门随整文件兜底一起废除）。
  旧管线（`ensure_thumb` 失败且 ≤8MiB 回原路径交浏览器自绘，与本地 fs_thumb 同形）仅保留给
  Server ≤0.2.0 的 404 退化面。`fs_thumb` 同步对齐：解码不了且 >8MiB 由 Err 改 Ok(None)。
  视口调度本就双模共用（IntersectionObserver 可见±2 屏 + 内存 blob LRU + 磁盘 LRU），
  配 Server 0.2.2（/thumb 白名单补 BMP）后**服务端网格出图能力=本地目录机制**：
  滚到哪出到哪、jpg/png/gif/bmp/RAW 直出，webp 等 ≤8MiB 静默缓存交本地解码（超限图标）。
  游客依旧直接图标（/thumb 与 /preview 同守卫，匿名不可达——与既有语义一致）。
- **ffmpeg 转码播放（需求③，player.rs+config.rs，不内嵌 ffmpeg）**：`ui.videoDecoder`
  三档化 `system`（默认，行为零变化）| `ffmpeg` | `external`；新 `ui.ffmpegPath`
  （serde default None=PATH 探测 "ffmpeg"）。新命令：`ffmpeg_probe`（`-version` 首行，
  设置页可用性探测）与 `ffmpeg_playable(path, force)`（限媒体缓存目录内文件——复用
  `guarded_cache_path` 纵深防御；容器 WebView 可直放（mp4/m4v/mov/webm/m4a/mp3/ogg/ogv）且
  非 force 时原路返回；否则 `tokio::process` 起 `ffmpeg -y -i in -map_metadata -1 -c:v libx264
  -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -movflags +faststart out`
  转码 `<hash>.ffmpeg.mp4` 落媒体缓存（存在即复用+touch；失败删半成品、报错带 stderr 尾 400 字
  按字符截断；Windows creation_flags 防闪窗），产物经 `note_media_write` 计入磁盘 LRU）。
  FileViewer：ffmpeg 档取完媒体缓存即转码上屏（容器友好则零转码直接复用系统解码）；
  system 档解码失败面板新增**[用 ffmpeg 转码播放]**（force=true——容器友好但编码不支持也重转）；
  ffmpeg 不可用时面板报"去设置配置路径"+保留外部播放器兜底。PreviewModal 失败面板同样给转码
  入口（弹窗不自动转码，防惊吓）。设置→外观：三档 radio + "ffmpeg 路径"输入（Enter/失焦提交）
  + [探测 ffmpeg] 按钮。`fm-transfer` 事件零新增（转码是本机 CPU 行为，不进传输面板）。
  Cargo.toml tokio 增 `process` 特性。**0.3.0"不内嵌 ffmpeg"边界改为"用户自备可选配置"**。
- **传输面板显隐（需求④，TransferPanel.tsx）**：面板头部加 [隐藏]（IconX）→ 收起为右下角
  悬浮圆钮（.transfer-fab，46px，IconTransfer + 任务数角标，与面板同层 z=150——模态/Toast
  层叠契约不变）；再点圆钮展开。显隐为纯展示态（队列照常执行/暂停/续传不受影响），
  会话内记忆、任务清零时整体消失（既有行为）。
- 版本号三处 0.3.2→0.3.3；设置→关于"配套服务端"文案更新 0.2.2。
- **验证**：`npm run build` ✓；`cd src-tauri && cargo check` ✓（零警告）。运行时人工验证：
  服务端视频查看不出传输行、BMP 网格出图（配 0.2.2）、ffmpeg 转码播放、面板显隐。


### 修复+新增：上传中断兜底 + 缩略图全显与双层缓存 + 浏览零下载（2026-10-06，0.3.2；配 Server 0.2.1 新端点，对旧服务端逐条退化）
- **需求原句**（用户 2026-10 清单，含服务端事故日志 PUT /upload/chunk 卡 2m33s 后 connection reset）：
  ①上传目录时连接断开要修；②中断后再次上传同一目录需相同文件校验、制定兜底机制（未完成的怎么恢复、
  不能用的碎片怎么处理）；③缩略图按可见±2屏缓存、内存≤2GB、磁盘≤10GB、查看/打开目录不得触发下载；
  ④缓存清理更新机制；⑤目录图片再多也要全量显示；⑥汇总上述；⑦版本号 0.3.2。
  决策（维护者确认）：相同自动跳过/不同弹窗询问；查看允许临时落盘纳入上限淘汰；磁盘缓存跨退出保留。
- **断连根因与修复（serverapi.rs，本批主修）**：①`client_for` 的 **120s 总超时罩住
  `POST /upload/complete`**——大文件服务端合并超 2 分钟被客户端掐、服务端其实替换成功、重试撞
  409 冲突风暴：complete 改独立提交（stream client + 15min 上限），任何"没拿到响应"的失败
  **不重发**（合并期会话恒 uploading，重发=双合并竞态），改 `GET /upload/session?id=` 每 5s 轮询
  ≤15min 判 completed（404=会话已过期报"重新上传"）；②chunk PUT 零重试+无读超时：put_chunk 网络类
  失败（传输层/408/429/5xx）≤3 次退避 1/2/4s 重试（服务端按 index 幂等覆盖安全），4xx 语义错误直返；
  ③每请求新建 reqwest Client 无连接复用：改按 (地址|TLS|用途) 缓存复用 + tcp_keepalive(30s)/nodelay
  （半开悬挂秒级暴露）；④会话命中旧参数死锁：create 后校验 chunkCount==ceil(size/chunkSize)，
  不符 `DELETE /upload/session` 重建（配旧服务端也生效）；⑤**取消（非暂停）尽力 DELETE 会话**，
  服务端 staging 碎片即时回收（旧行为任其挂到 7 天僵尸清理）；⑥错误分类弃中文串嗅探：Rust 给
  `FM_PAUSE:/FM_CANCEL:/FM_CONFLICT:/FM_NET:` 前缀（事件展示剥离），transfer.ts 按前缀路由（保留
  下载旧中文串兜底）。
- **目录重传：校验+续传+账本兜底（App.tsx/transfer.ts/localdb.rs）**：
  **预检管线**（配 Server ≥0.2.1；旧服务端 404 整体跳过预检走 0.2.0 原流程）：fs_walk →
  `POST /check` pass1（不带 hash，missing 直传/differ 进询问/same 跳过/unknown 进 pass2）→
  unknown 集 `fs_file_hashes`（新命令，sha2 流式 SHA-256，与服务端同算法）→ pass2 →
  {skipSame 不入队；missing baseHash="-"；unknown（无哈希证据的大小相符存量）baseHash="" 覆盖
  语义上传（服务端覆盖前仍存版本，需求3）；differ 弹窗}→ **新对话框 `uploadDiff`**（Modals.tsx：
  逐行覆盖/跳过+全部覆盖/全部跳过+取消=中止该服务端本目录上传）→ serverMkdirs → enqueueGroup
  （组行注"跳过 N 个"）。**上传账本**（localdb `PRAGMA user_version` 1→2）：`upload_groups`
  （gid=组任务 id/服务端/根/本地目录/前缀/status/done_files）+ `upload_items`（rel/name/本地与远端
  路径/size/sha/session_id/state）——组创建由 TS 写（lg_new_group/lg_set_children），会话 id 与条目
  终态由 Rust upload_inner 回写（Mutex 短事务不跨 await）；取消→canceled、暂停→pending（可续）、
  失败→failed、完成→done；组终态由 settle 同步（error/paused 保持 active=可续语义）。
  **重启续传**：TransfersView 顶部"未完成的上传组"（lg_list_pending，已在内存任务表的 gid 不重复
  显示）→[继续]=按 items 重建子任务入组（done 跳过；failed 用覆盖语义；服务端活动会话命中自动
  断点续传，0.2.1 服务端坏会话自建新会话）→[放弃]=逐 session DELETE 清 staging。账本终态组 7 天
  启动清扫（journal_prune）。
- **缩略图全显（FileView/FileGrid/thumbcache）**：删 `slice(0,60)` 硬上限——**可见±2 屏**
  IntersectionObserver（root=.page，rootMargin "200% 0px 200% 0px"）驱动的无上限优先级队列，
  并发 3；键 `来源标识/path@mtime`（多根多服务端防撞、覆盖自动重取）；失败退避 2s/8s/30s ≤3 轮
  才落图标（`thumbPath` 契约改：null=永久无图不重试，**抛错=瞬时可重试**）；目录切换全量复位
  （修旧 path 键粘图/粘失败）。**内存 ≤2GB**：新 `lib/thumbcache.ts` Map<blobUrl> LRU，字节经新
  命令 `media_read_bytes`（`tauri::ipc::Response` 原始字节零 base64 膨胀；canonicalize+媒体目录
  前缀纵深，同 player.rs）建 Blob——**不用 fetch(convertFileSrc)**：CSP connect-src 不含 asset 协议
  且双平台 URL 形态不一；img-src 已含 blob: → **CSP 零改动**。预算 cfg.cache.maxMemMb 经
  loadConfig/saveConfig 同步。
- **磁盘 ≤10GB LRU + 清理更新（新 Rust 模块 cachemgr.rs）**：touch-on-serve（仅本进程自有拷贝：
  .thumb.jpg/RAW 提取 .jpg/服务端下载条目；**本地模式 hard_link 条目绝不 touch**——与源文件同
  inode，淘汰 unlink 只断链接不伤源数据）；原子字节计数（启动全量扫描校准）+ 写入点超限即淘汰 +
  300s 周期巡检；按 mtime 升序淘汰至 90% 上限；`*.part`/`*.raw-src`/`*.thumb.jpg.tmp` 孤儿
  mtime>24h 随巡检回收；**跨程序退出保留**（维护者确认）。设置→传输：磁盘/内存上限可配
  （CacheConf{maxDiskMb=10240, maxMemMb=2048}，serde default+api.ts normalize）+ 用量显示 +
  **清空缓存**（cache_stats/cache_clear 命令，清空联动清内存 blob）。
- **浏览零下载（srv_thumb 改造，核心需求6）**：优先 `GET /api/v1/thumb`（Server 0.2.1）→ 只回
  ≤512px JPEG 落缓存 `<key_hash>.thumb.jpg`——**网格浏览不再整文件入媒体缓存**；退化链：404（旧
  服务端）→ 整条 0.2.1 旧管线（整文件入缓存后本地缩放——接受面已受 10GB LRU 约束）；413/415/429
  且 size_hint≤8MiB（webp/heic/svg 等服务端不可解码/繁忙的小文件）→ 旧管线回浏览器自绘；>8MiB →
  图标（前端队列稍后自动重试）。429 客户端退避 2s/4s 共 3 试。双击查看/眼睛预览通道不变
  （srv_media_cache 整文件，维护者确认边界：查看允许临时落盘、纳入上限自动淘汰）。本地模式
  fs_thumb 不变（本地文件不存在"下载"语义）。
- **已知边界/后续**：游客浏览 public 目录仍无缩略图（/thumb 与 /preview 同守卫、匿名 401——语义
  承接 0.2.1 未变，需求6）；预检跳过的"相同"仅限 size+SHA-256 双证；账本不覆盖单文件上传（仅
  目录组）；本地模式 hard_link 条目 LRU 按创建序非访问序；Server 0.2.1 的 /thumb 与旧管线对
  同一文件可能给出不同画质（服务端盒式缩放 vs 本地 image 库 Lanczos——目测级差异，接受）。
- **依赖/权限**：Cargo.toml 新增 `sha2 = "0.10"`（锁内 0.10.9 传递依赖提为直接依赖，零新下载，
  纯 Rust 四平台交叉无系统库）；TS 零新包；tauri.conf.json CSP/capabilities **零改动**（已核验
  img-src 含 blob:、IPC 走既有 ipc:）。新增 Rust 命令：`fs_file_hashes`/`media_read_bytes`/
  `cache_stats`/`cache_clear`/`lg_new_group`/`lg_set_children`/`lg_list_pending`/
  `lg_group_items`/`lg_group_status`——均本地命令契约，不跨进程。
- **版本**：三处版本源 0.3.1 → **0.3.2**（需求19）。数据协议：对 Server ≥0.2.1 新增两个可选端点
  调用（加性）、对既有端点零改动；配 Server ≤0.2.0 逐条退化为 0.3.1/0.2.0 行为。推荐配套
  **Server 0.2.1**。

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
- 数据协议零变更（视频字节仍走既有 `/api/v1/preview` 媒体缓存通道，同权限、匿名语义不变），与 Server 0.2.x/0.1.x 兼容关系完全承接 0.2.1。

### 新增：网格缩略图全量显示 + 相机 RAW 查看/预览（2026-10-03，0.2.1；数据协议零变更）
- **需求原句**：文件在按缩略图浏览时也要显示文件内容（图片也要显示出来），同时对 RAW 格式的图片（各相机品牌，如尼康 NEF）也要显示出来——不只是点眼睛才能看到缩略图，点不点眼睛都能看（点眼睛的预览功能保留）。
- **根因**：网格缩略图走 `thumbData` data URL 通道——本地 ≤4MiB、服务端 `srv_thumb` ≤2MiB、前端筛选 ≤8MiB，且目标过滤是 `kind==="image"`；大图与 RAW（服务端/本地 kind 均为 `other`）一律只剩类型图标，内容唯有眼睛（mediaCache 无上限通道）可见。
- **RAW 通道（新 Rust 模块 `src-tauri/src/thumb.rs`）**：浏览器无法解码相机 RAW，但各家 RAW 内部都嵌有相机自产的 JPEG 预览。`extract_preview` 纯字节扫描提取**最大且结构完整**的内嵌 JPEG：SOI（FFD8FF）起、按段链前进至 EOI（FFD9）收束；SOS 后进入熵数据模式（FF00 填充/RSTn/progressive 扫描间 DHT 合法，段链断裂即判候选非法跳过）——绝不把半张图或垃圾当预览。覆盖 TIFF 容器（Nikon nef/nrw、Canon cr2/crw、Sony arw/srf/sr2、Panasonic rw2/raw、Olympus orf、Pentax pef、Leica rwl、DNG、Hasselblad 3fr、Samsung srw、Epson erf、Phase One fff、Minolta mrw、Kodak dcs/kdc）与非 TIFF（Fuji raf、Canon cr3、Sigma x3f）——只要内含 JPEG；确无内嵌 JPEG 的极少数文件报错→图标回退。已用 baseline/progressive/多预览并存/垃圾干扰四类合成样本做字节级验证（提取结果与原 JPEG 逐字节一致、无完整预览时正确报 none）。
- **媒体缓存语义（`fs_media_cache`/`srv_media_cache`）**：RAW 分支入缓存的不再是原始字节，而是提取的预览存为 `<key_hash>.jpg`（键结构承接 0.1.7 含 ver）；服务端先落可续传 scratch（`<key_hash>.raw-src`）下载原始字节、提取后删除不双占空间，提取失败留 scratch 供重试。由此**双击查看/眼睛预览自动支持 RAW**（两者本就走 mediaCache，零新端点、零服务端改动）。
- **缩略图生成**：新 `fs_thumb`、改版 `srv_thumb`（加 `ver`，返回**媒体缓存缩略图路径**而非 data URL）：确保缓存条目后生成/复用 `<key_hash>.thumb.jpg`（≤512px JPEG q80），前端 `convertFileSrc` 加载；缩放解码失败（svg/ico/heic 等 `image` 不支持的）且 ≤8MiB 时回传缓存原路径交由浏览器直接渲染，否则报错→图标。`DataSource.thumbData`（data URL）契约替换为 `thumbPath`（本机路径；null=回退图标）。非图像不拉缓存（thumb 命令仅对 `viewableType==="image"` 的条目调用）。
- **前端分流**：`lib/preview.ts` 新增 `RAW_EXT`（与 Rust `is_raw_ext` 同表）并入 `viewableType` 的 image 分支——**kind 不改**（服务端 kind 不含 RAW、本地 `kind_of` 保持与服务端口径一致，分组/筛选行为不变），显示/预览/查看/缩略图一律走 `viewableType` 分流；`FileView` 网格 effect 改为 `viewableType==="image"`、去掉大小上限、**并发池 3**（服务端大图/RAW 首过会整文件入媒体缓存——与眼睛预览共享，看过一次即秒出）；`PreviewModal` 图像分支同步改 `viewableType` 判定（RAW 显示于预览弹窗）。眼睛按钮/角标/右键"预览"、双击"查看"全部入口保留不变。
- **新增依赖**：`image` crate（default-features 关闭，仅 jpeg/png/gif/bmp/webp 解码 + jpeg 编码）用于缩略图缩放；纯 Rust，交叉编译四平台无额外系统库。
- **已知边界/后续项**：服务端模式网格首过把大图像/RAW **整文件**拉入媒体缓存（带宽/磁盘；`$APPCACHE/media` 仍无淘汰策略——既有缺口，本批使用面扩大，淘汰建议单列后续）；RAW 显示保真度受限于相机内嵌预览（通常全尺寸 sRGB JPEG，非全精度 RAW 解码，本功能定位即"看到内容"）；网格缩略图仍限前 60 个；内嵌预览本身很小的格式（如 x3f）观感受限。
- 数据协议零变更（字节仍走既有 `/api/v1/preview`，同权限、匿名语义不变），与 Server 0.2.x/0.1.x 兼容关系完全承接 0.2.0。

### 新增：预览/查看分离 + 大图片查看 + 查看器全屏（2026-10-03，0.1.7；数据协议零变更）
- **需求原句**：大图片也要能查看；区分"预览"与"查看"——预览是缩略图（缩放式小图），查看是双击后右边显示文件的区域直接显示照片，并有全屏按钮、双击照片关闭查看。
- **查看（新 `components/FileViewer.tsx`）**：双击**可预览类型**（图片/视频/音频/PDF/文本；分类 `lib/preview.ts` `viewableType` 与预览弹窗支持集严格一致）→ `<main>` 内覆盖层 `.viewer`（absolute inset:0 z80，盖住文件列表与顶栏，其下筛选/选中/缩略图状态**不丢**；切视图/目录/来源自动收起）。页头：文件名（可选中复制）/大小 + 下载（游客置灰）/全屏/关闭。**双击图片即关闭查看**；Esc 逐级：先退全屏、再关查看；查看中被 401 弹登录框等弹窗永远在上（z 序 100>90>80，需求4/6 语义不受影响）。archive/other 等不可预览类型双击仍是旧弹窗（提示+下载）。
- **大图通道**：图片取字节从 `previewData` 切到 `mediaCache` + `convertFileSrc`——`fs_preview`/`srv_preview_data` 双侧 8 MiB data URL 硬限自此与图片无关（>8MiB 不再报"文件过大"）。本地 `fs_media_cache` 硬链接/复制无上限；服务端 `srv_media_cache` 本就是把 `GET /api/v1/preview` 流式下载到缓存目录——**同端点同权限**（与今天图片预览一致），服务端零改动、匿名公开目录浏览语义不变（需求6 无新增面）；CSP `img-src` 已含 `http://asset.localhost`、asset scope 已授 `$APPCACHE/**`，零配置改动。预览弹窗（PreviewModal）图片分支同步切到此通道并与查看器共享缓存（预览过再查看秒开），弹窗显示尺寸不变（max-height 62vh = "缩略图"观感）。
- **缓存键版本串**：图片入缓存后 `dest.exists()` 短路会在覆盖写后命中旧内容（data URL 时代每次重读、无此问题，属新引入风险）。`fs_media_cache`/`srv_media_cache` 新增可选参数 `ver`（前端传 `String(entry.mtime)` 并入哈希键），旧键条目自然失效重拉。`Option` 参数保持命令向后兼容，接口 `mediaCache(entry)` 签名不变。
- **入口分离**：`openEntry`（双击/右键"查看"）→ 查看覆盖层；新增 `previewEntry`（列表行眼睛、网格角标眼睛、SearchView"预览"按钮、右键"预览"）→ 弹窗。`FileView/FileGrid/SearchView` 各加 `onPreview` prop；右键菜单对可预览类型给"查看"+"预览"两项，目录/其余不变；行/卡片 tooltip 措辞随 `viewableType` 分流（"双击查看" vs "双击预览"）。
- **全屏取舍**：`getCurrentWindow().setFullscreen()`（系统级），**不用** DOM `requestFullscreen`——webkitgtk 支持参差，违背本项目 WebView2/webkitgtk 一致性基调（承接 0.1.5 关注点）。`capabilities/default.json` 增一行 `core:window:allow-set-fullscreen`（读侧 allow-is-fullscreen 已含于 core:default）。`try/catch` 失败退化为应用内覆盖层 `.viewer-fs`（fixed inset:0 z90），功能不崩；退出只撤销**本查看器自己置过**的全屏（`fsApplied` ref），不抢窗口管理器自设状态、重复点按自愈。
- **已知边界/后续项**：文本 >8MiB 查看仍报"文件过大"（previewData 上限保留）；服务端图片查看/预览会生成一条瞬时 "media-" 传输展示行（视频预览既有先例，接受）；`$APPCACHE/media` 仍无淘汰策略（既有缺口，图片入缓存后增长更快，列为后续项，本批不扩 scope）。
- 数据协议零变更（图片走既有 `/api/v1/preview`；`ver` 为本地 Rust 命令可选参数），配套 Server 0.1.x（推荐，当时当前 0.1.1）起可用、不变。

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
- **关于页内容**：客户端版本 / Tauri 框架版本 / **配套服务端**（当时的兼容矩阵静态文案，
  改动矩阵须同步 Settings.tsx 该处；现行文案见 0.3.4 条目）/ 版本取值说明。
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
- **兼容**：配套 Server 0.2.x（推荐，当前 0.2.0）；配 Server 0.1.x 目录上传退化为逐个 mkdir、其余功能与 0.1.7 一致；配 Server ≥0.1.0 的其余协议不变。三处版本源文件 0.1.7 → 0.2.0（需求19）。

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
