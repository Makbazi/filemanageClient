# Changelog — filemanageClient

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
**每次版本变更必须声明兼容的其他模块版本（需求20）。**

> 需求39（2026-09-21 维护者决策，本批用户清单第 9 条）：正式首发前从未发布，历史变更清单整体清空、从此
> 重新记录；此前明细可查本仓库 git 历史（分支 feature/dev_new_able）。

## 兼容矩阵

| filemanageClient | 配套 filemanageServer | 说明 |
|---|---|---|
| 0.1.0（当前） | **0.1.x（推荐；当前 Server 0.1.1）**；0.7.x/0.6.x/0.5.x 亦可用 | 新增账户页自助改密（需 Server ≥0.1.0 的 `/auth/change-password`；配旧服务端时该按钮报 404/405，其余功能不变）。0.7.x/0.6.x 服务端下家目录虚拟根、jail 语义与登录态处理同 0.6.1。**Server 0.1.1（文件存储驱动、管理台切换/导出/暂停）为服务端存储与管理面增项，数据协议零变更，本客户端无感兼容（仅更新本兼容列表，代码不动）** |
| ≤0.6.1 | 0.5.x–0.7.x | 见 git 历史（已按需求39清空） |

## 未发布版本

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
