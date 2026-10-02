# Changelog — filemanageClient

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
**每次版本变更必须声明兼容的其他模块版本（需求20）。**

> 需求39（2026-09-21 维护者决策，本批用户清单第 9 条）：正式首发前从未发布，历史变更清单整体清空、从此
> 重新记录；此前明细可查本仓库 git 历史（分支 feature/dev_new_able）。

## 兼容矩阵

| filemanageClient | 配套 filemanageServer | 说明 |
|---|---|---|
| 0.1.5（当前） | **0.1.x（推荐；当前 Server 0.1.1）**；0.7.x/0.6.x/0.5.x 亦可用 | 兼容关系承接 0.1.4 不变。0.1.5 新增设置页"关于"页签与页头版本号显示，纯 UI 行为、数据协议零变更（"配套服务端"一栏为兼容矩阵静态文案，不产生新的接口依赖）。新增账户页自助改密（需 Server ≥0.1.0 的 `/auth/change-password`；配旧服务端时该按钮报 404/405，其余功能不变）。0.7.x/0.6.x 服务端下家目录虚拟根、jail 语义与登录态处理同 0.6.1。**Server 0.1.1（文件存储驱动、管理台切换/导出/暂停）为服务端存储与管理面增项，数据协议零变更，本客户端无感兼容（仅更新本兼容列表，代码不动）**。Client 0.1.1–0.1.5 为构建体系与客户端本地修复/改版（baseUrl 协议头归一、连接错误透出、对话框层级修复、设置全屏页、关于页版本信息），纯 UI/本地行为，数据协议零变更，对本矩阵无影响 |
| ≤0.6.1 | 0.5.x–0.7.x | 见 git 历史（已按需求39清空） |

## 未发布版本

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
