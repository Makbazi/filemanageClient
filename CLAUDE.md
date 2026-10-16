# CLAUDE.md — filemanageClient

> 本文件供 Claude Code 及开发者快速了解本工程。**自动更新约定（需求2）**：
> 任何组件/lib 结构、Rust command、配置结构、交互行为的变更，**必须在同一次改动中**
> 同步更新本文件、`CHANGELOG.md`（含兼容矩阵）与三处版本号
> （package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json）。

## 工程定位

Tauri 2 + React 19 + TS 桌面客户端。两种数据来源统一在 `DataSource` 接口后：
- **本地模式**：Rust command 直接管理用户配置的本地目录（免登录，全功能）
- **服务端模式**：所有 HTTP 经 Rust `srv_call` 代理（单凭证注入 + `X-Client-Id` 头 +
  401 自动重登（0.3.6 认证收敛），
  大流量走专用命令（`srv_upload` 分片 / `srv_download` 流式）

## 目录结构

```
src/App.tsx            根组件：状态编排、对话框调度（Dialog 判别联合）、查看覆盖层
                       （viewing 状态，0.1.7）、位置恢复；0.3.5 loginEpoch 计数并入
                       列表 effect 依赖、fm-config-changed 时 +1（修复服务端重启后
                       重新登录须手点刷新才出文件——登录路径保持同 rootId/path 时
                       effect 依赖零翻动的死角；稳定原始值，不违反约定 4）；
                       0.3.7：需求6 pickServer/pickLocalRoot 增 stay 形参（设置页 onSwitchSource
                       切数据源保持 view=settings）+ fm-group-resumed 监听（恢复的账本组补挂
                       watchGroup 终态通知）；需求2 planDirUpload 修 fs_file_hashes 根相对路径
                       组合（dirRel/rel——旧实现全 miss 空转）+ children 随带 mtimeMs/sha 入账本
                       证据；需求5 无 App 改动（批量操作作用于既有 selEntries 链路）
src/lib/
  datasource.ts        DataSource 接口（唯一数据访问契约）
  local.ts             本地实现（invoke fs_* 命令）
  server.ts            服务端实现（srv_call + srv_* 传输命令；0.2.0 serverMkdirs 批量建目录+旧服务端退化逐个 mkdir；0.3.2 serverCheck 目录重传预检（500/批，旧服务端 isMissingEndpoint 退化）；thumbPath 契约：null=永久无图、抛错=瞬时重试；0.3.3 收紧：413/415/403=永久 null（不整文件兜底不空转重试）、size_hint 移除、404 旧管线仅 Server ≤0.2.0 且静默；0.3.5 修订：415 不再判 null（服务端像素闸门≠无图）→Rust 落旧管线本地缩放，null 仅剩 413/403/真无图；**0.3.6 定版（浏览零整文件）：415/404/413/403 一律永久 null=图标，任何情况不再整文件兜底——全量字节只在双击查看/下载到来**）
  api.ts               配置单例(loadConfig/saveConfig/active) + source() 工厂 + 分享/ACL/AI 辅助
                       + 视频辅助（ffmpegProbe/ffmpegPlayable/videoCodecProbe；0.3.7 增
                       ffmpegCancel/videoMediaInfo/ffmpegFrameBytes(canvas 帧字节 ArrayBuffer)/
                       ffmpegAudioTrack；0.3.8 增 ffmpegFramesBatch(批量连续解码帧数组——Rust
                       ffmpeg_frames 长度前缀串接切分)/videoMediaInfo 回带 fps、
                       mediaUrl(媒体缓存出图 URL=fmc:// 自定义协议，Windows 形态
                       http://fmc.localhost，UA 分流——取代 convertFileSrc 四处调用点，
                       配合可重定位缓存目录)、cacheDirInfo/cacheSetDir(缓存目录管理)）
  transfer.ts          任务注册表（入队/暂停/续传/重试 + "fm-transfer" 事件归并，
                       未入队 transferId 首个事件自动注册为展示任务）+ 订阅；
                       0.2.0 目录上传组任务（enqueueGroup 子任务不进 order/并发池 3/
                       组级 pause-resume-cancel-retry/rowActions 统一选路）；
                       0.3.2 FM_* 前缀错误路由、组终态落上传账本（syncGroupDb 去抖）、
                       resumeJournalGroup/abandonJournalGroup/listJournalPending 重启续传 API；
                       0.3.5 dismissFromPanel(id)——仅右下角面板隐藏终态行（panelHidden 展示标记，
                       注册表与 TransfersView 不动；run() 回到运行态自动清除）；
                       **0.3.7 需求2 resumeJournalGroup 恢复对账大修**：重入队前①条目会话
                       GET /upload/session 判 completed→落账 done（免重传，旧盲目重传撞 409
                       永久死循环=本批根因）②批量 POST /check 判 same→落账 done（旧服务端静默
                       跳过）③账本 mtime 与当前不符=本地变过→DELETE 旧会话防分片混拼、覆盖语义
                       全新重传④failed/不可续会话→覆盖语义；恢复入队后广播 fm-group-resumed
                       事件（App 补挂 watchGroup 终态监听）
  transtypes.ts        TransferTask/TransferStatus 共享契约（状态串 = Rust 事件；
                       0.3.2 +skipped 组行跳过计数、+journalRel 账本 rel 坐标；
                       0.3.5 +panelHidden 右下角面板逐条隐藏标记（纯展示，不删任务））
  thumbcache.ts        0.3.2 缩略图内存 LRU（≤cfg.cache.maxMemMb=2GB 默认）：键=来源标识+
                       path@mtime，media_read_bytes IPC 字节→Blob→objectURL，超限按访问序
                       revoke；预算由 api.loadConfig/saveConfig 同步 setThumbBudgetMb
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
                       （(0.3.6：查看器图片缩放查看——滚轮以光标为锚 0.2x–16x、放大后拖拽平移、
                       头部 [−][比例][+][适应]、换文件复位；双击关闭契约不变) 
                       （0.3.6：FileViewer 图片放大缩小查看——滚轮以光标为锚 0.2x–16x（原生 wheel
                       passive:false）、放大后拖拽平移（setPointerCapture）、头部工具条
                       [−][比例%][+][适应]、切文件复位；双击图片关闭/Esc 契约不变，眼睛预览不缩放）
                       （0.3.6：账户页不再调用 GET /auth/me——客户端只持 token、不查询自身
                       身份/角色，显示账户名取本地配置 srv.username；服务端 /auth/me 同步收敛
                       仅回 {username}）
                       （0.1.5：Settings 第 7 页签"关于"=版本信息（客户端/Tauri/配套服务端），
                       页头右侧常驻版本徽标；版本取 @tauri-apps/api/app 运行时命令
                       getName/getVersion/getTauriVersion，非编译期常量，故与 build.sh -V
                       注入的产物版本一致；core:app:default 已授权，权限零改动）
                       （TransfersView：任务注册表管理页，侧栏"传输"入口带未完成任务角标，
                       全部/上传/下载筛选；ContextMenu/UploadToDialog：本地文件右键上传到
                       一个/多个远程（需求7））
                       （0.3.0：外观页签新增"关闭按钮（X）行为"select（托盘/退出，默认托盘）
                       与"视频播放（H.264/H.265）"radio+外部播放器命令输入（Enter/失焦提交）+
                       测试按钮，均 uiSet 即时持久化；FileViewer/PreviewModal 视频 onError 兜底
                       面板 + openMedia 外部播放入口，FileViewer 增 decoder prop）
                       （0.3.2：FileView/FileGrid 缩略图 IntersectionObserver 视口调度——
                       可见±2 屏全量出图（废除前 60 上限）、path@mtime+来源键、失败退避重试、
                       thumbcache blob 上屏；0.3.5 调度改造：两遍扫描视口优先（滚到哪先出哪）+
                       >16MiB 慢通道并发 ≤1（**0.3.6 随整文件兜底移除——/thumb 恒为几十 KB，并发统一 3**）+ 瞬时 3 轮耗尽
                       不判永久、单元格再入视口重武装重入队（每 key ≤3 批）+ queuedRef O(1)）；Modals 新 UploadDiffDialog（目录重传同名不同内容
                       逐行覆盖/跳过+全选按钮）；App.uploadDirToServers 预检管线（/check 两遍
                       +fs_file_hashes+弹窗询问+账本 lg_* 登记，旧服务端自动退化）；
                       TransfersView 顶部"未完成的上传组 [继续][放弃]"（lg_list_pending，
                       已在内存任务表的 gid 不重复显示）；Settings→传输：媒体/缩略图缓存
                       上限可配+用量显示+清空）
                       （0.3.3：FileViewer/PreviewModal 视频 ffmpeg 转码通路——decoder 三档
                       system|ffmpeg|external；ffmpeg 档媒体缓存就绪即 ffmpegPlayable 转码上屏（容器
                       友好零转码直复用系统解码）；system 档解码失败面板增 [用 ffmpeg 转码播放]（force）,
                       ffmpeg 不可用面板报"配置路径"提示+外部播放器兜底保留；弹窗一律不自动外起/不自动
                       转码只给按钮；**0.3.6（修 H.265 无法播放）**：system 档媒体缓存就绪后先 `videoCodecProbe`（ffmpeg -i 探真实编码，毫秒级）——HEVC 且 ffmpeg 可用→跳过系统解码直自动转码上屏（转圈复用 ffmBusy），转码失败（含 ffmpeg 未配置）→直落 ffmErr 引导面板；判不了/非 HEVC→原行为；
                       Settings→外观 视频三档 radio + ffmpeg 路径输入（Enter/失焦 uiSet）+
                       [探测 ffmpeg]；TransferPanel 显隐开关——头部 [隐藏]↔右下角 .transfer-fab 悬浮圆钮
                       （IconTransfer+任务数角标，同层 z=150），纯展示态不影响队列；
                       0.3.5 面板终态行（完成/已取消/失败）逐条"从面板隐藏"按钮=
                       panelHidden 标记（仅移出右下角，TransfersView 保留；再运行自动回面板））
                       （0.3.7 需求5：FileView 复选框列（表头三态全选/清空）+ Shift+单击范围选 +
                       Ctrl/Cmd+A 全选筛选结果 + "已选 N 项[全选][取消选择]"状态条；FileGrid 卡片
                       左上角勾选框；批量下载/复制/移动/删除复用既有 selEntries 链路，重命名保持单选。
                       需求6：Settings 页签之上常驻"当前数据源"下拉（本地·各目录/服务端N·各名称
                       （已登录/游客）），选择即经 App onSwitchSource(stay=true) 切换、停留本页不跳
                       文件列表）
                       （0.3.7 需求1/3：FileViewer 转码面板带进度条+百分比+耗时/总时长+取消按钮，
                       "转码已取消"走中性 ffmNote 不再冒充失败；新增 FfmRenderView 组件——render 档
                       解码 canvas 播放（播放/暂停/拖拽进度条/时间显示，音轨经 audio 对时或
                       无音轨内部时钟，外部播放器兜底入口）；**0.3.8 需求2：FfmRenderView 重写为
                       批量连续解码渲染引擎**——api.ffmpegFramesBatch 帧队列（reqRef 单飞+want
                       覆盖、队尾 <0.9s 自动续批 ~1.5s 帧、末尾静默停批 seek 复位）、rAF 节拍
                       （audio.currentTime 优先/静音内部时钟）、只画最新帧（drawSeq 作废旧帧解码
                       结果、不积压）、漂移 >2.5s 以音轨时钟 restartAt；**0.3.8 需求5：出图通道
                       convertFileSrc→api.mediaUrl（fmc://）四处：FileViewer 视频/转码产物、
                       PreviewModal 媒体/转码产物、FfmRenderView 音轨**；**0.3.8 需求4：FileView
                       工具栏 [批量操作]/[退出批量] 开关——默认单击=单选替换；批量态才显示表头
                       三态复选框/行复选框/网格勾选框/Shift 范围选/Ctrl+A/"已选 N 项"状态条，
                       退出批量或换目录自动清空（FileGrid 增 bulk prop）；**0.3.8 需求1：
                       serverapi create_session 对 "exceeds maxUploadBytes" 错误（≤0.2.7 服务端
                       >2GiB 必现 413）改写中文可操作指引**）
src/styles/            base.css（组件）+ themes.css（5 套主题变量）
src-tauri/src/         lib.rs(config/localdb/localfs/serverapi/ai/secret/thumb/player/cachemgr 的 command 注册 +
                       启动清理；0.3.0：TrayIconBuilder 托盘（菜单=显示主窗口/退出，左键仅唤醒——
                       Linux appindicator 不派发点击事件，菜单为主路径）+ CloseRequested 按
                       ui.closeAction 拦截隐藏（TRAY_OK/QUITTING 原子标志，托盘失败绝不炸启动）+
                       tauri-plugin-single-instance 最先注册（重复启动唤起已有窗口）；
                       0.3.2：setup 中 journal_prune（账本终态超 7 天回收）+ cachemgr::init_counter/
                       启动一次 enforce/300s 巡检任务；新注册 fs_file_hashes、media_read_bytes、
                       cache_stats、cache_clear、lg_new_group/lg_set_children/lg_list_pending/
                       lg_group_items/lg_group_status；0.3.3 注册 ffmpeg_probe/ffmpeg_playable；0.3.6 注册 video_codec_probe，run 改 build()+回调挂 `RunEvent::ExitRequested`→`logout_all_for_exit`（正常退出前尽力登出全部服务端凭证）；
                       0.3.7 注册 ffmpeg_cancel/video_media_info/ffmpeg_frame/ffmpeg_audio_track/fs_mtimes/lg_item_state，ExitRequested 钩子先 `player::ffmpeg_cancel_all` 杀全部在飞转码再登出（不留孤儿 ffmpeg 跨会话续写产物）；
                       **0.3.8 注册 ffmpeg_frames（渲染档批量连续解码）与 cache_dir_info/cache_set_dir（缓存目录管理）；Builder 挂 `register_uri_scheme_protocol("fmc")` 自定义媒体协议（fmc_protocol：query `p=` 百分号解码→canonicalize→必须位于**当前媒体缓存目录**内否则 404、单段 Range→206/416、按扩展名 Content-Type、全字节同步响应——视频媒体元素恒带 Range 分段；同文件内 percent_decode/fmc_ctype/parse_range 辅助；setup 时 create_dir_all(media_cache_dir()) 已随 AppState::load 兜底）)
                       config.rs(AppConfig: localRoots/servers(caFile)/ai/active/clientId(0.3.6：客户端唯一标识——首启 Uuid::new_v4 生成并持久化，save_config 中同 token 般 Rust 权威、绝不被前端快照清空；进程内 OnceLock 供 HTTP 层读取)/ui(sidebarCollapsed/
                                  closeAction=tray|quit(默认tray)/videoDecoder=system|ffmpeg|render|external(默认system;0.3.3 增 ffmpeg 档;0.3.7 需求3 增 render 档=ffmpeg 逐帧解码+canvas 原生渲染)/
                                  videoPlayerCmd(0.3.0)/ffmpegPath(0.3.3，空=PATH 探测 ffmpeg))/transfer/trashRetentionDays；keyring_ok；
                                  update() 统一做令牌同步凭证库+config.json 脱敏；0.3.6：ServerConf.refreshToken 字段删除（单凭证契约；旧 config.json 该键加载即忽略）；
                                  0.3.2 cache{maxDiskMb=10240(10GB),maxMemMb=2048(2GB)} serde default；
                                  0.3.8 cache.dir（媒体/缩略图缓存目录重定位，空=默认 <appcache>/media；
                                  media_cache_dir() 唯一事实源、media_cache_dir_default() 供"恢复默认"）
                       secret.rs(系统凭证库 keyring：token 存取/探测/删除；不可用时回退明文并提示；0.3.6 单凭证化——get/set_tokens 只存 token，写删时顺带清理旧 refresh 条目)
                       localdb.rs(本地元数据 sqlite：ai_descriptions/trash_items/file_versions/
                                  analysis_tasks；open_and_migrate 幂等迁移 user_version；
                                  旧 *.json 首次启动自动导入后改名 *.imported；
                                  0.3.2 user_version 1→2 上传账本 upload_groups/upload_items——
                                  组（gid=组任务 id/服务端/根/本地目录/前缀/status/done_files）与
                                  条目（rel/本地远端路径/size/sha/session_id/state）；Rust
                                  upload_inner 回写会话与终态（Mutex 短事务禁跨 await），
                                  journal_prune 启动回收终态超 7 天组；
                                  0.3.7 lg_item_state 命令——TS 恢复对账直接落条目终态（done 时
                                  组行 done_files 同步重算））
                       localfs.rs(防逃逸 fs_* + 本地版本库 + kind_of(0.3.0 视频扩展表扩 hevc/h265/h264/
                                  m2ts/mpg…，不含 ts)+ fs_import/export + fs_walk(0.2.0 目录树枚举，需求41；
                                  0.3.7 WalkEntry+mtime_ms 作账本证据)+ fs_mtimes(0.3.7 批量本地 mtime，
                                  恢复"本地是否变过"判据)+ sha256_abs(0.3.7 冲突对账本地哈希辅助，路径来自
                                  本机账本非用户输入面) +
                                  fs_media_cache(0.1.7 起带可选 ver 版本串入缓存键；0.2.1 RAW 存提取的内嵌预览 .jpg；
                                  0.3.2 hard_link 命中不 touch（保源文件 mtime）、新条目登记 cachemgr) +
                                  fs_thumb(0.2.1 网格缩略图：媒体缓存 ≤512px .thumb.jpg 路径；0.3.3 契约对齐 srv_thumb：解不了且 >8MiB 由 Err 改 Ok(None) 永久图标) +
                                  fs_file_hashes(0.3.2 sha2 流式 SHA-256 批量哈希，目录重传预检 pass2 用，
                                  逐条容错 null=读失败))
                       serverapi.rs(srv_login/logout/change_password/call/upload/download/media_cache(同 ver，0.2.1 同 RAW 分支；内部 srv_media_ensure——0.3.5 MEDIA_FLIGHT per-key single-flight：dest.exists() check-then-act 双并发共用 .part/.raw-src 撞 ENOENT="首看概率文件不存在"根因，锁内二次 check 复用成品；Cargo.toml tokio 增 "sync")/preview_data + srv_thumb(0.2.1 改版：加 ver、返回缩略图路径；0.3.2 优先服务端 GET /thumb——浏览零下载，0.3.3 契约收紧 Result<Option>：413/415/403=Ok(None) 永久无图、size_hint 移除、404 旧管线仅 ≤0.2.0 且静默；**0.3.5 修订：415=服务端像素闸门(12MP/6000px thumbdec.go)≠无图→Unsupported 落旧管线本地缩放兜底（高MP JPEG/CMYK/RAW 内嵌预览客户端可解——Windows 截图后段全图标主根因），413/403 仍永久；产物 tmp 加 uuid 尾段防同键并发互踩（Linux 坏图永久缓存/Windows rename 已存在报错）+ rename 前后 exists 复用**） + download_inner 增 silent 参数——查看/预览/缩略图通道 silent=true 不发任何 fm-transfer 事件（需求：查看绝不出现传输行；手动上传下载恒 false）) + transfer_cancel；
                                  **0.3.6 认证收敛**：client_cached 经 default_headers 给一切请求注入 `X-Client-Id`；srv_login 请求体带 clientId、响应只读 token；`try_refresh`→`try_autologin`（401→用户名+keyring 记住的密码静默重登→重试；无密码→AUTH_REQUIRED 登录框——重启自动登录/1h 闲置过期自愈/改密后重登全靠它）；srv_logout 与 logout_all_for_exit（退出钩子）发 {token}+Bearer；srv_thumb 删 Legacy/Unsupported 兜底变体——415/404/413/403 一律 Ok(None) 图标，浏览零整文件；
                                  0.3.2 断连大修：reqwest Client 按(地址|TLS|用途)缓存复用+
                                  tcp_keepalive30s/nodelay、put_chunk 网络类失败≤3 退避(1/2/4s)、
                                  会话创建后 chunkCount 校验不符 DELETE 重建、complete 移出 srv_call
                                  120s 通道(stream client+15min 上限)且失败**不重发**改轮询
                                  GET /upload/session(id=) 判 completed(5s 间隔≤15min)、取消(非暂停)
                                  尽力 DELETE /upload/session 清服务端 staging、错误加
                                  FM_PAUSE:/FM_CANCEL:/FM_CONFLICT:/FM_NET: 前缀(事件展示剥离)、
                                  srv_upload 新增 journal_gid/journal_rel 参数回写上传账本；
                                  **0.3.7 需求2 冲突死循环根治**：upload_inner 的 complete 撞 409(FM_CONFLICT)
                                  即 DELETE 会话再上抛（服务端 CreateOrResume 按路径命中旧会话会原样带回过期
                                  BaseHash=旧"永久 409 无法恢复"根因）；srv_upload 冲突后经 localfs::sha256_abs
                                  本地哈希与 GET /stat 远端 content_hash 比对——相同=上次中断其实已合并成功，
                                  直接判成功落账 done（崩溃恢复主场景零重试闭环）；enc_q 查询串转义辅助）
                       thumb.rs(0.2.1 相机 RAW：is_raw_ext 品牌扩展表 + extract_preview 字节级最大内嵌 JPEG
                                  提取（SOI 扫描 + 段链校验至 EOI，熵数据/progressive 合法，垃圾候选拒绝）+
                                  ensure_thumb image 缩放 ≤512px JPEG 入媒体缓存)
                       player.rs(0.3.0 需求1 外部播放器：open_media(限媒体缓存目录内文件——命令不经
                                  capabilities 门控故 canonicalize+前缀纵深防御；videoPlayerCmd 空→
                                  opener 插件系统关联播放器，非空→argv 直起不经 shell、{file} 占位、
                                  Windows CREATE_NO_WINDOW、spawn 分离) + test_player_command(设置页
                                  测试：开缓存最新视频或 0 字节 fmc-selftest.mp4 探测，返回实际路径) +
                                  ffmpeg_probe/ffmpeg_playable(0.3.3 需求3：探测=-version 首行、ui.ffmpegPath 空=PATH；
                                  playable=guarded_cache_path 纵深内，容器 WebView 友好(mp4/m4v/mov/webm/m4a/mp3/ogg/ogv)且非
                                  force 原路返回，否则 tokio::process 起 ffmpeg 转 H.264/AAC MP4 落 <hash>.ffmpeg.mp4 入媒体缓存
                                  复用——存在即 touch、失败删半成品、stderr 按字符截尾、Windows 防闪窗、note_media_write 计 LRU、
                                  零 fm-transfer；不内嵌 ffmpeg；**0.3.6** `video_codec_probe`/`probe_video_codec`：ffmpeg -i 解容器头取首条 `Video:` 编码名（=判不了；正向结果进程内缓存），`ffmpeg_playable` 容器直放短路前先探编码——HEVC/hvc1/hev1 必转码（修 HEVC-in-MP4 容器盲区）；
                                  **0.3.7 需求1 转码治理**：`ffmpeg_playable` 产物改 `.part` 暂存 + 成功 rename（修"半成品当成品复用→重开误报不可用"，旧 `metadata(len>0)` 复用即成品），`kill_on_drop(true)`+作业注册表（key→AtomicBool+Notify）+`ffmpeg_cancel`+每 key single-flight（对齐 MEDIA_FLIGHT）；`-progress pipe:1` 解析 out_time_ms→`fm-ffmpeg` 事件（{key,path,orig,status,secs,total,pct}，前端按 orig 过滤）；`probe_video_info` 一次窥探编码/时长/音轨（正向缓存）；`video_media_info` 供渲染档时间轴；
                                  **0.3.7 需求3 第 4 档 render**：`ffmpeg_frame`（`-ss` 定位单帧 mjpeg 管道，不落盘，0.25s 桶小缓存，ipc::Response 原始字节）+`ffmpeg_audio_track`（抽 `<key>.audio.m4a`，`.part` 暂存同纪律，无音轨 Err"无音轨"→前端静音时钟）——逐帧解码+canvas 原生渲染，边解边播不等整段转码；仍零 fm-transfer；
                                  **0.3.8 需求2 render 提速（主通道换批量）**：`ffmpeg_frames`——一次进程 `-ss time + -vf fps=源帧率,scale≤maxh + image2pipe mjpeg` 顺序解 count 帧（默认 ~1.5s），`split_jpegs` 按 SOI/EOI 切帧、逐帧 `[u32 LE 长度][jpeg]` 串接经 ipc::Response 回传（前端 api.ffmpegFramesBatch 切分→ImageBitmap）；`probe_video_info` 增解析源 fps（`-i` 视频行 "NN.NN fps"，`video_media_info` 回带）——旧 `ffmpeg_frame` 每帧起进程 0.3~1s→2–4fps 的根因修除，1080p 软解可达 25–30fps；
                                  **0.3.8 需求3 并发治理**：transcode_run 取消分支改直读**本作业** job 的 AtomicBool（旧按 key 回查注册表——关窗秒重开时条目已被新一代替换，回查读到 false 漏杀→两个 ffmpeg 互踩同一 .part/产物，"其他场景 ffmpeg 不可用"残留面）；注册表移除改 `Arc::ptr_eq` 只摘自己条目；libx264 `-threads` 按在飞作业数分摊 ncpu（单作业全速、并发均分——A 转码中打开 B 不再被挤成进度 0%）；一切 ffmpeg 子进程显式 `stdin(null)`（杜绝可交互 tty 偶发挂起））)
                       ai.rs(本地 AI)
                       cachemgr.rs(0.3.2 媒体/缩略图磁盘缓存 ≤cfg.cache.maxDiskMb LRU：
                                  touch-on-serve 仅限本进程自有拷贝（hard_link nlink 与源文件
                                  共享 mtime，绝不 touch）、原子字节计数（启动扫描校准）、
                                  写点超限即 enforce+300s 周期巡检、按 mtime 升序淘汰至 90%、
                                  *.part/*.raw-src/*.thumb.jpg.tmp mtime>24h 孤儿回收、
                                  跨程序退出保留；cache_stats/cache_clear 设置页入口；
                                  media_read_bytes IPC 原始字节命令（canonicalize+媒体目录前缀
                                  纵深，tauri::ipc::Response 免 base64，供前端 blob 内存层）；
                                  **0.3.8 需求5**：cache_dir_info（当前/默认目录、是否自定义、
                                  条目与占用）与 cache_set_dir(dir,migrate)（切换/迁移缓存目录：
                                  create_dir_all 校验→可选逐条目 rename/跨卷 copy+删源尽力搬运
                                  →st.update 落 cache.dir+emit fm-config-changed（约定13 通道）
                                  →init_counter+enforce 重扫；hard_link 条目 rename 只断链接不伤
                                  源）——目录事实源=AppState::media_cache_dir()（config.rs，
                                  cache.dir 空=默认 <appcache>/media），cachemgr/player/
                                  localfs/serverapi 全部守卫自动跟随；fmc_protocol 出图面）)
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
   历史批次已下线任意路径的 `fs_read/write_bytes_b64`（并入基线），不得恢复）。
   令牌一律经 `secret.rs` 入系统凭证库，config.json 不落盘明文（回退场景除外）。
4. **游客只读（需求6）**：`source().anonymous === true` 时禁用一切写操作 UI（含下载按钮置灰）；
   401/AUTH_REQUIRED → App.tsx 统一处理 AuthError：**显式操作**（切换服务端/点登录/游客上传）
   必弹登录框；**后台自动加载**（refresh/refreshTrash）遇 401 每服务端最多自动弹一次，
   取消后不再骚扰（错误条+顶栏登录按钮承接；登录成功/登出重置该标记）。
   刷新与位置持久化 effect 依赖激活来源的**稳定字符串签名** `kind|serverId|rootId`，
   禁止以 `cfg?.active` 等对象引用作 effect 依赖（saveConfig 每次返回新对象会形成
   "保存→刷新"死循环并导致登录框反复弹出）。
5. **传输**：服务端上传/下载一律经 `transfer.enqueue` 入队执行（任务注册表：暂停→
   断点续传 / 失败重试 / 覆盖重试在 TransferPanel，需求4/5/6），UI 不直接
   await 传输命令；本地模式导入/导出即时执行并经 `reportLocal` 记进度。
   任务 id=transferId（`uid()`），进度经 `fm-transfer` 事件（未入队 id 自动注册为
   展示任务）；取消/暂停用 `transfer_cancel(pause)`；上传覆盖的 BaseHash 在任务
   执行时重新 stat 获取（乐观锁，需求3；新文件断言 `"-"`）。
   **0.2.0 需求41 目录上传**：整树枚举走 `fs_walk`（符号链接/`.fmtrash` 跳过，
   上限内整体拒绝），远端骨架走 `POST /api/v1/mkdirs`（旧服务端自动退化逐个
   `mkdir`），文件走 `transfer.enqueueGroup` 组任务——子任务只注册不进 UI 快照、
   并发池限流、一条组行聚合进度，暂停/继续/取消/重试为组级（冲突子任务组重试
   按覆盖语义）；UI 不得绕过 `rowActions` 直接调单任务 API。
   **0.3.2 断连/兜底契约**：①错误分类走 Rust 前缀 `FM_PAUSE:/FM_CANCEL:/FM_CONFLICT:/FM_NET:`
   （fm-transfer 事件 message 已剥离前缀，invoke 异常带前缀——TS 侧嗅前缀，禁止再嗅中文文案；
   下载通道的"已暂停/已取消"旧中文串保留兜底）；②`POST /upload/complete` **绝不走 srv_call**
   （120s 总超时=本批事故根因）：走 stream client+15min，失败**只轮询 `GET /upload/session?id=`
   判 completed，禁止重发 complete**（合并期会话恒 uploading，重发=双合并竞态）；③分片 PUT
   网络类失败 ≤3 退避重试（服务端按 index 幂等）；④取消（非暂停）尽力 `DELETE /upload/session`
   清服务端 staging，暂停保留会话续传；⑤目录组任务必须登记上传账本（lg_new_group/
   lg_set_children 先于 enqueueGroup，条目 journalRel=fs_walk relPath），Rust upload_inner
   回写 session_id 与终态；组 error/paused 账本保持 active（可续语义），done/cancelled 落终态，
   启动 journal_prune 回收终态超 7 天组；重启续传走 transfer.resumeJournalGroup（done 跳过、
   failed 用覆盖语义 baseHash ""）。
6. **配置**：AppConfig 变更必须给默认值（config.rs serde default + api.ts normalize），
   兼容旧 config.json。
7. **主题**：颜色一律用 CSS 变量（themes.css），组件样式禁止硬编码色值；
   新主题 = themes.css 增加一个 `[data-theme=...]` 块 + theme.ts THEMES 注册。
8. **预览/查看（0.1.7 契约；0.2.1 增缩略图全量 + RAW；0.3.0 增视频解码体系；0.3.3 增 ffmpeg 档与查看零传输）**：图片/视频/音频/PDF 一律经媒体缓存 + `convertFileSrc`
   （asset 协议 scope 只授权应用缓存目录；无大小上限——大图片可看；缓存键必须并入
   `ver`＝entry.mtime 串，防覆盖后 exists 短路命中旧内容）；文本用 data URL（仍 ≤8MiB）。
   **相机 RAW（0.2.1）**：浏览器不可解码——`viewableType` 按 `RAW_EXT`（与 Rust
   `thumb.rs::is_raw_ext` 同表）归入 image，媒体缓存存的是 Rust 从文件提取的**最大
   内嵌 JPEG 预览**（`.jpg`，非原始字节），查看/预览/缩略图共享该条目；不得改为整文件
   入缓存再 `<img>` 直挂。网格缩略图一律 `thumbPath`（fs_thumb/srv_thumb → 媒体缓存
   ≤512px `.thumb.jpg` 路径；**0.3.2 起前端经 media_read_bytes 建 blob 上屏、走约定 9
   的双层缓存，不再 convertFileSrc**；null=永久无图标回退、抛错=瞬时重试），大图与
   RAW 无需点眼睛即可见（眼睛/角标/右键预览入口保留）；服务端模式**浏览绝不整文件**
   入缓存（0.3.2 服务端 /thumb；0.3.6 起任何回退通道都废除——配 ≤0.2.0/出不了图的格式一律图标），并发池 3 限流。
   预览＝PreviewModal 缩放弹窗（"缩略图"观感，入口＝眼睛/角标/右键"预览"）；
   查看＝FileViewer 主区覆盖层（入口＝双击/右键"查看"，双击图片/Esc/X 关闭，
   全屏＝窗口 `setFullscreen`＋CSS 覆盖层，**禁用 DOM requestFullscreen**——
   webkitgtk 支持参差违背双引擎一致性）。类型判定必须走 `lib/preview.ts`
   `viewableType`，不得与弹窗支持集分叉。层叠契约：`.modal-mask` 100 >
   `.viewer-fs` 90 > `.viewer` 80 > 页面内容（401 登录框恒在查看之上）。
   **视频解码（0.3.0 需求1；0.3.3 需求3 三档化；0.3.7 需求3 四档 system|ffmpeg|render|external，
   转码治理+进度取消见 0.3.7 批注）**：H.264/H.265 默认 `videoDecoder=system`——`<video>`
   即 WebView 原生系统解码器（Windows Media Foundation / Linux GStreamer），必须挂
   `onError` → 提示面板（缺 HEVC 组件指引）+ [用 ffmpeg 转码播放]（force 转码，见下）+
   [用外部播放器打开]（`open_media` 开媒体缓存路径；`videoPlayerCmd` 空=系统关联播放器，
   `{file}` 占位符，argv 直起不经 shell）；`external` 模式查看器自动外起一次（ref 去重）并给
   [在本窗口播放] 覆盖，**PreviewModal 一律不自动外起/不自动转码只给按钮**；`VIDEO_EXT`
   （三处同表：preview.ts / localfs kind_of / player.rs）**不得纳入 `ts`**（TypeScript 冲突）。
   **ffmpeg 档（0.3.3）**：`ffmpeg_playable(path, force)` 把媒体缓存视频按需转码 H.264 MP4
   （`<hash>.ffmpeg.mp4` 入媒体缓存、受磁盘 LRU、产物复用、零传输事件）；`ui.ffmpegPath`
   空=PATH 探测 "ffmpeg"——**不内嵌 ffmpeg，用户自备**；容器 WebView 友好且非 force 时原路
   返回（0.3.6 起先 `probe_video_codec` 窥编码——HEVC-in-mp4 不再短路、直接转码）。**查看零传输（0.3.3 需求1）**：查看/预览/
   缩略图的媒体缓存取字节一律走 `download_inner(silent=true)`——绝不发 fm-transfer 事件，
   传输面板/传输页只出现用户手动发起的上传下载；字节来源仍是既有 `GET /api/v1/preview`
   （权限/匿名语义零变化，"查看允许临时落盘进缓存"的既定边界保留）。
9. **媒体/缩略图缓存体系（0.3.2，需求3/4/5/6；0.3.3 契约收紧）**：①**网格浏览绝不整文件拉取**——
   `srv_thumb` 优先服务端 `GET /api/v1/thumb`（Server ≥0.2.2 白名单含 BMP——出图能力=
   本地缩放机制；≥0.2.1 无 bmp；守卫同 /preview，匿名语义不变），只有 ≤512px 缩略图字节
   入媒体缓存；0.3.3 契约：**413/415/403=永久无图 Ok(None) 直接图标**（不再整文件兜底、
   不再对确定性结局空转重试）；429/网络/401/5xx=瞬时 Err 退避 ≤3 轮；仅端点 404
   （Server ≤0.2.0）走旧管线整文件入缓存+本地缩放——且 0.3.3 起**静默**（不出传输行），
   属已声明兼容面、受磁盘配额约束。②**磁盘 ≤cfg.cache.maxDiskMb
   （默认 10GB）**：cachemgr mtime-LRU（touch-on-serve 仅限自有拷贝——本地 hard_link 条目
   绝不 touch，unlink 只断链接不伤源文件）、`.part/.raw-src/.thumb.jpg.tmp` 超 24h 孤儿回收、
   300s 巡检+写点超限即淘汰、跨程序退出保留、设置页用量/清空（cache_stats/cache_clear，
   清空必须联动 clearThumbCache）。③**缩略图内存 ≤cfg.cache.maxMemMb（默认 2GB）**：
   `lib/thumbcache.ts` blob LRU，字节经 `media_read_bytes` IPC（`tauri::ipc::Response`
   ArrayBuffer，**禁止改 fetch(convertFileSrc)**——CSP connect-src 不含 asset 且双平台
   URL 形态不一；img-src 已含 blob: 故 CSP 零改动）；键=来源标识+path@mtime，覆盖自动
   重取、多根/多服务端防撞。④查看/预览整文件通道不变（维护者确认边界：双击查看允许临时
   落盘进缓存、纳入上限自动淘汰；用户手动下载仍走 srv_download 到用户目录）。
   ⑤FileView 调度契约：thumbPath 返回 null=永久无图（不重试）、抛错=瞬时失败（退避
   2/8/30s ≤3 轮后落图标）；游客立即图标（与 /preview 匿名语义一致）；目录切换全量复位。
   **0.3.6 定版**：null=415/404/413/403 永久面（浏览零整文件，0.3.5 的 415 整文件兜底废除——它是"打开图片目录带宽爆满"的根因；48MP 大图的出图面由 Server 0.2.4 服务端 YCbCr 平面路径恢复）；瞬时耗尽不永久 settle——再入视口重武装（每 key
   ≤3 批）；调度=视口优先两遍扫描（0.3.6 起慢通道移除、并发统一 3）。
10. **版本号三处同步**（需求19），发版时更新 CHANGELOG 兼容矩阵（需求20）。
11. 编译验证：`npm run build` + `cargo check` 通过即可（需求29，不写测试）；
    **不做 git 提交/分支/tag**（需求30）。
12. **本地元数据一律经 localdb.rs（localdb.sqlite3）**：AI 描述/回收站/版本索引不再
    写 `*.json`（`config.json` 仍为文件）；`AppState.db` 是 `Mutex<Connection>`，
    **禁止跨 `.await` 持锁**；表结构变更走 `PRAGMA user_version` 迁移链，保持幂等。
13. **登录态单一事实源（需求1/8；0.3.4 起凭证为服务端认证图随机值——token 与 refreshToken 同串，仍是 Rust 侧独占权威状态）**：服务端 token/refreshToken 与已记住账户
    凭证（credentials 索引 + keyring 密码）是 **Rust 侧独占的权威状态**——只有
    `srv_login`/`srv_logout`/`srv_change_password`/`try_refresh`/`cred_forget` 可以变更，任何变更必须
    `app.emit("fm-config-changed")`，前端 App 监听该事件同步（loadConfig +
    invalidateSource + setCfg + roots）；`save_config` **忽略前端快照携带的令牌与
    credentials**（禁止恢复旧的 `*c = config` 全量替换——会把已轮换的令牌写回旧值，
    造成"一直刷新/登录框反复弹"）。记住密码按 服务端+账户 隔离存 keyring，
    config.json 永不落密码本体。
14. **托盘常驻与关窗行为（0.3.0 需求2）**：`ui.closeAction`（默认 **tray**）只影响主
    窗口 `CloseRequested`——tray 且 `TRAY_OK` 且非 `QUITTING` 时 `prevent_close()+hide()`
    （先退全屏）；**托盘构建失败必须退回退出行为**（绝不静默丢窗口），托盘菜单
    「退出」先置 `QUITTING` 再 `exit(0)`。恢复入口：托盘菜单「显示主窗口」（Linux
    appindicator 不派发点击事件，菜单是 Linux 主路径）/左键·双击唤窗（Windows）/
    重复启动经单实例插件唤起。**禁止**新增任何"进程后台仍持有可见模态"假设——
    隐藏态视频/音频继续播放属已接受边界。single-instance 钉 `~2.4.5`（2.5.x 需
    tauri ^2.12 + MSRV 1.90，勿随手升）。

## 当前版本

0.3.8（上传 413 中文指引配套 Server 0.2.8（默认限额解除）+ render 档批量连续解码提速（`ffmpeg_frames` 新命令：一次进程解 ~1.5s 帧序列、SOI/EOI 切帧长度前缀回传；FfmRenderView 帧队列+rAF 节拍、只画最新帧、漂移重启、末尾停批——2–4fps → 25–30fps 量级；`video_media_info` 回带源 fps）+ 并发转码治理（取消直读本作业标志/注册表 ptr_eq 摘除/libx264 `-threads` 按在飞作业数分摊/子进程 stdin(null)——修"A 转码中打开 B 无法用 ffmpeg"）+ 批量操作显式化（工具栏 [批量操作] 进出，批量态才有复选框/Ctrl+A/Shift 范围/状态条；默认单击=单选）+ 设置页缓存目录管理（`CacheConf.dir` 重定位+`cache_dir_info`/`cache_set_dir` 切换/迁移/恢复默认+清空沿用；出图通道 `mediaUrl()`=**fmc:// 自定义协议**（守卫=当前媒体缓存目录内+Range/206）取代 convertFileSrc 四处；CSP 扩 fmc:/http://fmc.localhost），**数据协议零变更**——修复主体在 Server 0.2.8 默认值）+ 0.3.7（转码治理：`.part` 暂存+原子改名/kill_on_drop/作业注册表+ffmpeg_cancel/single-flight/`fm-ffmpeg` 进度事件（查看器与预览面板进度条+取消按钮，关窗即中断不留半成品——修"重开误报 ffmpeg 不可用"三根因）+ 四档播放（需求3：新增 render=ffmpeg 逐帧解码+canvas 原生渲染，`ffmpeg_frame`/`ffmpeg_audio_track`/FfmRenderView）+ 文件夹上传断点恢复（需求2：resumeJournalGroup 对账 completed/same/本地变更、Rust 冲突即作废会话+哈希判同落账、账本 mtime/sha 证据、fs_file_hashes 根相对路径修复、恢复组终态监听+侧栏角标）+ 批量选择（需求5：复选框列/Shift 范围/Ctrl+A/全选状态条）+ 设置页数据源下拉（需求6：stay 切换停留本页）+ Server 0.2.7 日志批配套，**数据协议零变更**——恢复所用端点全为既有面）+ 0.3.6（单凭证认证收敛：登录只回 token/X-Client-Id 标识绑定/401 自动重登/退出登出/闲置 1h——配套 Server 0.2.4 破坏批 + 浏览零整文件：srv_thumb 废除 415/404 整文件兜底、FileView 慢通道移除 + H.265 修复：video_codec_probe 探真实编码、system 档 HEVC 自动转码/ffmpeg_playable 不再被容器后缀短路）+ 0.3.5（缩略图与稳定性修复批：415→本地缩放兜底【已被 0.3.6 取代】+ 视口优先调度/重入视口重武装 + 同键 single-flight + 面板逐条隐藏 + 重登自动刷新）+ 0.3.4（认证协议配套批：服务端去 JWT 后的凭证透明承接，客户端代码零改动 + 文档/版本号定版）+ 0.3.3（查看零传输 + 缩略图契约收紧 + ffmpeg 可配转码 + 传输面板显隐）+ 0.3.2（上传中断兜底 + 缩略图全显与双层缓存 + 浏览零下载）+ 0.3.1（win10 交叉编译环境修复：镜像补装 appindicator 开发包——纯 build-env 变更，产物代码/数据协议零变更）+ 0.3.0（H.264/H.265 视频播放体系 + 系统托盘常驻）+ 0.2.1（网格缩略图全量显示 + 相机 RAW 查看/预览）+ 0.2.0（需求41 目录上传）；0.1.1/0.1.2 为构建体系批次、0.1.3–0.1.7 为修复与 UI 批次；配套 filemanageServer **0.2.8（推荐基线；大文件上传依赖其默认解除 maxUploadBytes，其余对协议零依赖，全 0.2.x/0.1.x 兼容——配 ≤0.2.7 时 >2GiB 上传仍 413 并有中文指引）**；对 0.2.4/0.2.3/≤0.2.2 的降级面见 CHANGELOG 兼容矩阵行内说明。
**0.3.4（2026-10-10 用户第三批清单第 3 条；配 Server 0.2.3，客户端代码零改动）**：服务端认证重构去 JWT——登录/刷新响应中的 `token` 变为服务端三层认证图签发的**不透明随机凭证**（64-hex 随机哈希形态，不编码任何身份；真实 user id/username 存服务端）。客户端本就对凭证无格式假设（不解析、只 bearer_auth 透传、keyring 存取），**全链路零改动**：`refreshToken` 字段为同一凭证的兼容别名（token/refreshToken 同串），401→`try_refresh`→重试、logout、change-password、分享 st、keyring 存取语义全部不变；`/auth/me` 回显 `{id,username,role}` 账户页照常。升级 Server 0.2.3 后的一次性影响=存量会话失效、重登一次（既有 AUTH_REQUIRED 登录框路径承接，无新增面）。本批变更：三处版本源 0.3.3→0.3.4、serverapi.rs/secret.rs/config.rs 认证注释按不透明凭证改写（行为零变更）、设置"关于"配套服务端文案 0.2.x（推荐，当前 0.2.3）·0.1.x 可用。兼容矩阵：0.3.4 配 Server ≤0.2.2 亦无感（协议字段形状未变，凭证内容对客户端始终不透明）。
**0.3.3（2026-10-06 用户清单 1–5 条；数据协议零变更，缩略图 BMP 对齐依赖 Server 0.2.2）**：需求原句——查看服务端视频触发了下载，查看服务端文件不得触发传输、上传下载只许手动触发；服务端按缩略图预览也要滚动到哪里哪里显示、向上向下缓存和本地目录机制保持一致；可在设置界面配置 ffmpeg 用于视频解码播放、默认系统解码但允许用户配置；右下角上传下载弹窗可关闭、按按钮可再弹出（显隐）；版本 0.3.3/0.2.2。实施——`download_inner` silent 化（media-<hash> 通道零事件，本批主修"看视频出下载行"；查看允许临时落盘进缓存的既定边界不变）；`srv_thumb`/`fs_thumb` 契约收紧（413/415/403=永久无图 null、不整文件兜底、size_hint 移除；视口 IO±2 屏/双层缓存本就双模共用，配 0.2.2 后服务端网格出图能力=本地机制：滚到哪出到哪）；`ui.videoDecoder` 三档 system|ffmpeg|external + `ui.ffmpegPath` + 新命令 `ffmpeg_probe`/`ffmpeg_playable`（H.264 MP4 转码入媒体缓存复用、零传输事件、不内嵌 ffmpeg、失败按面板提示走外部播放器兜底）；TransferPanel 头部隐藏↔右下角 .transfer-fab 圆钮显隐（会话内展示态，队列执行不受影响）。Cargo.toml tokio 增 `process` 特性；CSP/capabilities/`/api/v1` 协议零改动。三处版本源 0.3.2→0.3.3。
**0.3.2（2026-10-06 用户清单 1–6 条；依赖 Server 0.2.1 加性端点，配 ≤0.2.0 逐条退化）**：需求原句——上传目录中途断连要修；中断后重传同一目录要相同文件校验+兜底（未完成恢复/碎片清理）；缩略图可见±2屏缓存、内存≤2GB、磁盘≤10GB、有清理更新机制；图片再多也要全量显示；打开服务端文件/文件夹不得触发下载（查看允许临时落盘纳入上限淘汰——维护者确认；磁盘缓存跨退出保留）。断连主根因与修复：**complete 被 srv_call 120s 总超时掐断→服务端已成功客户端报失败→重试撞 409 风暴**——complete 独立提交（stream client+15min）且断连后只轮询 `GET /upload/session` 判 completed 绝不重发；分片网络级重试（1/2/4s 退避≤3）；reqwest Client 按服务端复用+tcp_keepalive；坏会话（size 变）DELETE 重建；**取消即时 DELETE 会话清 staging**；FM_* 前缀错误路由。**目录重传预检**：`POST /check` 两遍（先 size，unknown 集 `fs_file_hashes` 补 SHA-256 复查）→ 相同自动跳过、同名不同内容 `uploadDiff` 弹窗逐行覆盖/跳过（覆盖 baseHash ""，服务端覆盖前存版本）→ 旧服务端 404 整体退化为 0.2.0 冲突语义。**上传账本**（localdb user_version 2 upload_groups/upload_items）：Rust 回写会话/终态，TransfersView"未完成的上传组 [继续][放弃]"重启续传（done 跳过、failed 覆盖语义、放弃逐 session DELETE），终态组 7 天启动回收。**缩略图体系**：IntersectionObserver（root=.page，rootMargin 上下 2 屏）驱动无上限优先级队列（废除 slice(0,60)；失败退避 2/8/30s ≤3 轮；键=来源标识+path@mtime；目录切换复位）；`srv_thumb` 优先服务端 `/thumb`（**浏览零下载**）；内存 `thumbcache.ts` blob LRU（`media_read_bytes` IPC ArrayBuffer；CSP/capabilities 零改动）；磁盘 `cachemgr.rs` ≤10GB mtime-LRU（hard_link 条目纪律/24h 孤儿回收/300s 巡检/设置页用量+清空）。新增直接依赖 sha2（锁内 0.10.9 提升，零新下载）。三处版本源 0.3.1→0.3.2。
**0.3.1（2026-10-05 win10 构建环境修复；产物代码零变更、数据协议零变更）**：0.3.0 启用 tauri `tray-icon` 后，tauri-cli 2.11.4 在 Linux 宿主打包时无条件 pkg-config 探测 appindicator（门控是宿主机 `#[cfg(target_os="linux")]`，与 `--target`/`--bundles` 无关；上游 dev 亦未修），win10 交叉镜像缺 dev 包致 NSIS 阶段 panic（Jenkins #48，exe 编译成功）。修复：`build-env/Dockerfile.ubuntu22.04-win10` 在 rust 层后新增独立层装 `libayatana-appindicator3-dev`（仅供 CLI 宿主机侧探测，不参与 Windows 链接；三个 Linux 镜像本就装有）。**契约提醒：win10 镜像必须保留该 dev 包——tauri feature 含 tray-icon 期间删除即复现打包崩溃**；镜像改动需 `./build.sh -i -a windows10` 重建并 push harbor 才对 CI（`-n` 按 tag 拉取）生效。详见 build-env/README.md。
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
对服务端为加性依赖：配不含该端点的旧服务端时改密请求 404/405（报"接口不存在"），其余功能不变。
历史批次（需求1，已并入基线）：修复"账户页登录/取消后返回账户页"（Dialog login 分支加
`from:"settings"` 来源标记，App.tsx 单点改动；无协议变化）。
服务端基线起用户获得家目录虚拟根 `_users:<用户名>`（含内嵌回收站，服务端侧隐藏），
客户端按既有 jail 虚拟根透明处理即可，无需改动。历史批次（需求1–14，已并入基线）：传输任务注册表+管理页
（上传/下载入队、暂停→断点续传、重试/覆盖重试、统一"传输"界面带方向筛选）、
记住密码快速登录（keyring 按服务端+账户）、restoreSessions 开关、快速切换改版
（本地+选中远程+"更多"下拉）、本地文件右键上传到多个远程、登录态事件同步
（fm-config-changed + save_config 不再回写令牌）、admin 只留在服务端管理台。
以上历史批次均早于需求39 的服务端重基线（旧服务端编号不再引用）。
历史批次（已并入基线）：keyring 令牌存储、CA 证书导入、https 强制确认、CSP、游客下载置灰、
左侧可折叠导航栏（默认小箭头标签）、本地回收站 30 天自动清理、双视图显式预览按钮；
移除 fs_read/write_bytes_b64。
历史批次（已并入基线）：设置"用户管理"页替换为"账户"页（登录态/身份/被分配目录/切换账户/退出，
并修复未选服务端时页签崩溃白屏）；分享随机密码提示六位字母+数字。
服务端管理 API 仅在服务端管理端口可达——**客户端不做任何用户管理服务**，
roots 返回的虚拟根 id（`main:zhangsan` 形式）对客户端透明、原样透传即可。详见 CHANGELOG。
