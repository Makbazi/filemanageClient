# Changelog — filemanageClient

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
**每次版本变更必须声明兼容的其他模块版本（需求20）。**

> 需求39（2026-09-21 维护者决策，本批用户清单第 9 条）：正式首发前从未发布，历史变更清单整体清空、从此
> 重新记录；此前明细可查本仓库 git 历史（分支 feature/dev_new_able）。

## 兼容矩阵

| filemanageClient | 配套 filemanageServer | 说明 |
|---|---|---|
| 0.1.3（当前） | **0.1.x（推荐；当前 Server 0.1.1）**；0.7.x/0.6.x/0.5.x 亦可用 | 新增账户页自助改密（需 Server ≥0.1.0 的 `/auth/change-password`；配旧服务端时该按钮报 404/405，其余功能不变）。0.7.x/0.6.x 服务端下家目录虚拟根、jail 语义与登录态处理同 0.6.1。**Server 0.1.1（文件存储驱动、管理台切换/导出/暂停）为服务端存储与管理面增项，数据协议零变更，本客户端无感兼容（仅更新本兼容列表，代码不动）**。Client 0.1.1–0.1.3 为构建体系与客户端本地修复（baseUrl 协议头归一、连接错误透出），数据协议零变更，对本矩阵无影响 |
| ≤0.6.1 | 0.5.x–0.7.x | 见 git 历史（已按需求39清空） |

## 未发布版本

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
