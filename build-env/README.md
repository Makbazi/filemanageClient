# build-env —— filemanageClient 多平台编译环境

## 环境矩阵与命名规范

Dockerfile 命名 `Dockerfile.<平台标签>`，镜像命名
`harbor.localserver.com:9080/filemanage/filemanage-client-build:<平台标签>`
（与 filemanageServer 编译镜像同仓库；构建/拉取/运行一律用此全名，拉取名即运行名）：

| 平台标签（= 镜像 tag = `-a` 值） | Dockerfile | 基础镜像 | 产物 |
|---|---|---|---|
| `ubuntu22.04` | `Dockerfile.ubuntu22.04` | ubuntu:22.04 | deb + rpm + AppImage |
| `ubuntu24.04` | `Dockerfile.ubuntu24.04` | ubuntu:24.04 | deb |
| `ubuntu26.04` | `Dockerfile.ubuntu26.04` | ubuntu:26.04 | deb |
| `ubuntu22.04-win10` | `Dockerfile.ubuntu22.04-win10` | ubuntu:22.04 | NSIS exe（最低 Win10，交叉） |

工具链版本（各镜像一致，ARG 可覆盖）：Node 官方 tarball v22.20.0、rustup
minimal（`RUST_TOOLCHAIN=stable`，依赖版本由 src-tauri/Cargo.lock 锁定）。

## 为什么没有 Ubuntu 20.04 环境

Tauri 2 硬依赖 `libwebkit2gtk-4.1-dev`（wry 不再支持 4.0 栈），而 20.04 官方源
**没有**该包（连 libsoup-3.0/glibc 基线也无法满足，实测 `apt-cache policy` 为空），
Tauri 2 官方最低支持 Ubuntu 22.04。因此 20.04 的 deb 在技术上不可行，本套环境
不交付 20.04——这是编译产物体系当前唯一"4 deb → 3 deb"的偏差，特此记录。

## "最低 Windows 10" 的落实

Windows 客户端依赖 WebView2 **Evergreen** 运行时，该运行时自 2023 年起仅支持
Windows 10+（微软官方策略），即 Tauri 2 的 Windows 产物天然最低 Win10。本方案以
**产物命名（`windows10` 平台标签）+ 本文档与 CHANGELOG 声明**落实，不改动应用
代码、不自定义 NSIS 模板。

## win10 镜像为何也装了 appindicator 开发包（0.3.0 tray-icon 连带，Jenkins #48 实测）

`tauri` 启用 `tray-icon` 特性后，tauri-cli 2.11.4（上游 dev 分支亦未修）在 **Linux 宿主**
打包时，只要工程 manifest 开着该特性，就无条件用 pkg-config 探测
`ayatana-appindicator3-0.1`/`appindicator3-0.1`——**该探测块门控是宿主机的
`#[cfg(target_os = "linux")]`，与 `--target`/`--bundles` 完全无关**，两个 .pc 都找不到
即 panic `Can't detect any appindicator library`（症状：Windows exe 编译全部成功，NSIS
打包阶段崩）。探测结果只写进 deb Depends / AppImage 附带文件，对 NSIS 产物无实际影响，
但无法跳过（`TAURI_LINUX_AYATANA_APPINDICATOR` 的两个取值分支同样要求 pkg-config 成功）。
三个 Linux 镜像本就装 `libayatana-appindicator3-dev`（编译链接真需要）故无此症；win10
交叉镜像的 Windows 目标不链接 GTK，但 CLI 宿主机侧探测照样命中，故该 Dockerfile 在
rust 层之后以**独立层**补装同一包——仅供探测、不参与 Windows 链接，前序
apt/node/rust 缓存层不失效。

镜像改动生效前提（CI 走 `-n` 按 tag 拉 harbor）：本地 `./build.sh -i -a windows10`
重建后 `docker push harbor.localserver.com:9080/filemanage/filemanage-client-build:ubuntu22.04-win10`，
否则 CI 继续拉旧镜像复现 panic。

## 使用

常规入口（宿主机执行，需 docker；镜像缺失自动构建）：

```bash
./build.sh -a all                          # 四环境全量 release → release/
./build.sh -a ubuntu22.04 -d release       # deb+rpm+appimage → release/
./build.sh -a windows10 -d debug           # exe → release/debug/
./build.sh -a rpm                          # 便捷值：仅 rpm（ubuntu22.04 环境）
./build.sh -a appimage                     # 便捷值：仅 AppImage（ubuntu22.04 环境）
./build.sh -i                              # 仅构建四环境编译镜像（docker build），完成退出，不编译工程
./build.sh -i -a windows10                 # 仅构建 ubuntu22.04-win10 环境镜像
./build.sh -n                              # 仅从镜像仓库拉取四环境镜像（docker pull），完成退出
./build.sh -n -a all -V v0.2.0             # CI：拉镜像+四环境编译，产物版本固定 0.2.0（覆盖 package.json）
```

- `-a`：`ubuntu22.04` | `ubuntu24.04` | `ubuntu26.04` | `windows10` | `rpm` | `appimage` | `all`
- `-d`：`debug` | `release`（默认 release）；产物文件名保持
  `filemanageClient_<平台>_<版本号>.<扩展名>` 规范，debug 仅目录不同（`release/debug/`）
- `-i`：构建编译环境镜像（缺失时 `-a` 编译亦会自动构建；改 Dockerfile 后强制重建用 `-f`）
- `-n`：编译前拉取编译环境镜像（镜像名自带 harbor 仓库前缀，与 filemanageServer
  编译镜像同仓库惯例；拉取名即运行名，无本地重打步骤）；裸 `-n` 拉完即退出，配
  `-a` 继续编译
- `-V <版本号>`：显式指定产物版本号（去 v 前缀，覆盖 package.json；仅影响产物命名与
  经 `tauri --config` 注入的 bundle 版本元数据，不改动
  package.json/Cargo.toml/tauri.conf.json 三处源文件）。tauri 要求严格 semver：
  非 semver 值（如 CI 无 tag 时 git describe 兜底出的 `unknown`）告警并回落
  package.json，不中断编译——CI 只在有明确 tag/参数时传 `-V`
- 版本号优先级：`-V` 指定值 > package.json；扩展名：`.deb` / `.rpm` / `.AppImage` / `.exe`

## 构建机制

- `build.sh`（宿主）：镜像就绪检查 + `docker run` 编排 + 缓存卷管理
  （`fmc-work-<标签>` 工作区/增量编译、`fmc-cargo-<标签>` crate 下载、共享
  `fmc-npm`、`fmc-cache`——linuxdeploy 等下载件），单平台失败不影响其余、末尾汇总
- `container-build.sh`（容器内）：`/src` rsync → `/work`（排除 node_modules/dist/
  release/.git/target，宿主工作树零污染、target 目录跨次增量）→ **清空本 profile 的
  `target/.../bundle/` 遗留产物**（tauri-bundler 安装包按"产品名_版本号"命名落在
  bundle/<type>/ 根、只清自己的暂存子目录；/work 卷跨构建持久会积累旧版本包，收集时
  可能静默取到旧包冠名新版本——症状即"产物版本对、界面是旧的"）→ `npm ci` →
  `npm run tauri -- build [--debug] --bundles <列表> [--target x86_64-pc-windows-gnu]`
  → 产物按规范名（收集按 mtime 取最新，纵深防御）复制回 `/src/release[debug]/`
- Windows 交叉采用 `x86_64-pc-windows-gnu`（mingw-w64 + NSIS makensis，Linux 侧
  即可打安装包）；若该目标在依赖升级后出现链接问题，回退方案为同基础镜像改用
  cargo-xwin + MSVC 目标（产物命名不变）

## deb 运行时依赖的 t64 兼容性（实测结论）

tauri bundler 默认 deb 依赖按 jammy 命名（`libwebkit2gtk-4.1-0, libgtk-3-0`）。
noble/resolute 的 GTK3 运行时虽经 t64 迁移更名 `libgtk-3-0t64`，但其 control 声明
`Provides: libgtk-3-0`，**在三个发行版的镜像内以 `apt-get install --dry-run` 实测
均可正常解析安装**，故产物保持默认依赖清单。若未来版本移除该虚拟 Provides，
`build.sh` 的 `plan_platform` 已预留 `DEB_DEPS` JSON 覆盖通道（经
`tauri build --config bundle.linux.deb.depends` 注入，不改工程 tauri.conf.json）。

## 已知网络注意事项

AppImage（AppRun/linuxdeploy 及其插件）与 NSIS 打包时需要从 GitHub 拉取工具链，
网络抖动可能出现瞬时失败（如 `TLS close_notify` 连接重置、xdg-open 缺失类依赖报错
已在本套镜像内置修复）。**直接重跑同一命令即可**——cargo/npm/tauri 缓存均在命名卷中，
重试只做增量（实测 windows10 环境一次重试即通过）。

**GitHub 太慢/长期拉不动时（Jenkins build #2/#3 实测卡在 AppRun 下载），宿主设置
以下任一环境变量，`build.sh` 自动透传进容器**（tauri-cli ≥2.0.0-rc.13 原生支持，
实测本仓库锁定的 @tauri-apps/cli 2.11.4 / tauri-bundler 2.9.4 生效）：

| env | 语义 | 适用镜像类型 |
|---|---|---|
| `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` | 改写后 URL = 基址 + **完整原 URL 作 path**（`https://m/https://github.com/o/r/releases/download/v/a`） | gh-proxy 类（如 `https://gh-proxy.com`） |
| `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR_TEMPLATE` | 模板占位符 `<owner>/<repo>/<version>/<asset>`（优先于上者） | 保留 releases 路径结构的镜像 |
| `HTTP(S)_PROXY` / `http(s)_proxy` | 上述两个 mirror env **未设置**时，bundler 走 `try_proxy_from_env` | 常规 HTTP 代理 |

注意两点：① mirror env 只改写 `github.com/…/releases/download/…` 资产，
`raw.githubusercontent.com` 上的两个 linuxdeploy 插件脚本（.sh，约十 KB）不走
mirror、只认代理；② 下载件统一缓存在**共享卷 `fmc-cache`**（`/root/.cache`，
四环境共用，Jenkins dind hostPath 下跨构建持久）——镜像配好后任一环境成功下载
一次，其余环境/后续构建全部命中缓存。CI 配置示例（Jenkinsfile）：

```groovy
environment {
  TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = 'https://gh-proxy.com'   // 换作内网可达的镜像
}
```

首次使用前可在构建容器内验证可达性：
`curl -skIL https://gh-proxy.com/https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64`。

**首次冷缓存全量构建很慢（CI 超时主要来源，Jenkins build #2 实测）**：四环境各自
独立 `fmc-work-*`/`fmc-cargo-*` 卷，首跑每个环境都要付 crates.io 索引+全依赖下载
与 tauri/gtk 依赖树 release 全编译（实测单环境 30–40 分钟起，网络差时索引更新伴随
大量 spurious retry）；四环境串行首次全量可远超 3 小时。缓存在 dind 命名卷内
（Jenkins k8s cloud 场景：dind `/var/lib/docker` 挂 hostPath，卷随宿主持久、跨 pod
存活），预热后整轮增量约 10–20 分钟。CI 首跑请放宽 timeout 或先手动触发一次预热构建。

## 安装验证速查

```bash
dpkg -I release/filemanageClient_ubuntu22.04_0.1.0.deb     # deb 元数据
rpm -qpi release/filemanageClient_rpm_0.1.0.rpm            # rpm 元数据
./release/filemanageClient_appimage_0.1.0.AppImage --appimage-extract  # 解包检查
file release/filemanageClient_windows10_0.1.0.exe          # PE 检查
```
