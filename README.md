# filemanageClient

FileManage 桌面客户端（Tauri 2 + React 19 + TypeScript）：
本地目录全功能管理（免登录）+ 多服务端切换（远程需登录，未登录游客只读）、
分片上传/断点续传/实时进度、图片/视频/音频/文档预览、高级搜索、多主题、
列表/缩略图双视图、筛选与分类分组、临时分享链接、目录权限、文件版本回滚。

当前版本：**0.1.0**（package.json / Cargo.toml / tauri.conf.json 三处同步）；配套 Server 0.1.x（推荐）

## 快速开始（Get Start）

```bash
# 前端依赖
npm install

# 开发运行（需要 Rust 工具链 + Tauri 2 系统依赖，见 https://tauri.app/start/）
npm run tauri dev

# 构建桌面应用（本机快速验证）
npm run tauri build

# 多平台发行产物（Docker 编译环境：deb/rpm/AppImage/Win10 NSIS，见 build-env/README.md）
./build.sh -a all -d release      # → release/（-d debug → release/debug/）

# 仅前端类型检查/构建
npm run build
cd src-tauri && cargo check
```

**首次上手（约 2 分钟）：**

1. 安装依赖并启动：`npm install && npm run tauri dev`（打包分发用 `npm run tauri build`）；
2. **本地模式（零配置）**：设置 → 本地目录 → 添加目录，即可全功能管理（无需登录）；
3. **服务端模式**：先在服务端管理台由管理员创建账户（服务端 0.1.0 起管理员账户
   **不能登录客户端**）→ 设置 → 服务端 → 添加（地址如 `http://192.168.1.10:8484`；
   自签 TLS 建议导入 CA 证书）→ 顶栏快速切换 → 以普通账户登录（可勾选记住密码，
   口令存系统凭证库）；
4. 未登录远程也可**游客只读浏览**（受服务端目录权限约束；下载/修改需登录）；
5. 登录后：设置 → 账户 → "修改我的密码"可**自助改密**（服务端校验旧密码；改后当前
   会话失效，用新密码重登，已记住的口令自动同步更新）。

## 功能一览

| 功能 | 说明 |
|---|---|
| 快速切换 | 顶栏 本地/远程1/远程2… 一键切换（需求10） |
| 传输 | 分片上传（4MB/片）、断点续传、进度/速度实时显示、可取消、限速（设置→传输）；下载流式 + `.part` 续传（需求3/18） |
| 会话 | 登录一次 3 周内活跃自动续期，超期需重登（需求22，Rust 侧自动 refresh） |
| 账户 | 服务端管理员在管理台创建，客户端仅普通用户可登录（需求36）；账户页可**自助修改密码**（需求31：改后强制重登，"记住密码"口令自动同步凭证库） |
| 预览 | 图片/文本内联；视频/音频/PDF 经媒体缓存 + asset 协议播放（需求11） |
| 搜索 | 名称/类型/大小区间/修改时间区间（需求12） |
| 视图 | 按行列表 / 缩略图网格，按类型分组，名称筛选+排序（需求14/15/16） |
| 主题 | 深色玻璃/浅色/Nord/Dracula/海洋蓝（设置→外观，需求5） |
| 分享 | 临时链接创建与管理（密码默认随机、有效期自定义、免密/禁用/删除，需求7） |
| 权限 | 目录 ACL 编辑：用户/用户组/公开 × 查看/下载/上传/删除/分享（需求8/9） |
| 版本 | 本地与服务端文件版本历史/回滚（覆盖前自动快照，需求13） |
| 回收站 | 删除进回收站，可还原/清空（服务端 30 天自动清理） |
| 位置恢复 | 设置→外观→「启动时恢复上次关闭位置」（需求21） |
| AI | 文件描述生成 + 按描述搜索（本地 AI 或服务端 AI） |

## 目录结构

```
src/
  App.tsx              根组件：全局状态编排、对话框调度
  lib/
    types.ts           共享类型（配置/条目/版本/分享/ACL/搜索条件）
    datasource.ts      DataSource 统一接口（接口化设计）
    local.ts           本地实现（Rust command）
    server.ts          服务端实现（srv_call 代理 + 专用传输命令）
    api.ts             配置单例 + 数据源工厂 + 分享/ACL/AI 辅助
    transfer.ts        传输进度事件订阅（TransferPanel 数据源）
    theme.ts           主题注册与切换
    format.ts          大小/时间/路径工具
  components/
    Sidebar / Topbar / FileView / FileGrid / SearchView / TrashView / AIView
    PreviewModal / ShareDialog / AclDialog / VersionsDialog / TransferPanel
    Settings / Modals / icons
  styles/
    base.css           组件与布局（引用主题变量）
    themes.css         5 套主题的 CSS 变量定义
src-tauri/src/
  lib.rs               command 注册
  config.rs            AppConfig（含 ui/transfer 偏好，原子落盘）
  localdb.rs           本地元数据 sqlite（AI 描述/回收站/版本/分析任务 + 旧 JSON 一次性导入）
  localfs.rs           本地文件命令（防逃逸）+ 本地版本库 + 导入/导出 + 媒体缓存
  serverapi.rs         登录/refresh 续期/自助改密(srv_change_password)/srv_call/分片上传/流式下载/限速/取消/预览缓存
  ai.rs                本地 AI（OpenAI 兼容 / Ollama）
```

## 注意事项

- 配置与数据在应用数据目录：`config.json`（应用配置）、`localdb.sqlite3`（本地元数据：
  AI 描述/回收站/文件版本索引，含 `*-wal`/`*-shm` WAL 伴生文件）、`trash/`、`versions/`
  （0.2.x 的 `ai_descriptions.json` / `trash.json` / `versions.json` 首次启动自动导入
  数据库后改名为 `*.imported`，不再读写）
- 媒体预览缓存在应用缓存目录（asset 协议仅授权该目录）
- 服务端 0.1.x 兼容：登录（无 refreshToken 时不自动续期）与旧上传接口仍可用，
  但分片/版本/分享/权限需要服务端 0.2.x
- 上传覆盖同名文件会提示确认，服务端自动保留旧版本可回滚

## 版本兼容

见 `CHANGELOG.md`：Client 0.3.x ↔ Server 0.2.x/0.3.x（UI 协议不变；0.3.0 仅将本地元数据
迁入 sqlite，完整功能）。
