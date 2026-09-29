#!/bin/bash
# =============================================================================
# container-build.sh —— filemanageClient 容器内构建脚本
# （由宿主机 build.sh 经 docker run 挂载调用；也可按 Dockerfile 头注释手动执行）
#
# 用法: container-build.sh <bundles> <debug|release> [windows目标三元组] [deb平台标签] [deb依赖覆盖JSON]
#   bundles   逗号列表: deb | rpm | appimage | nsis（对应环境能力，见 README）
#   三元组    非空时走 --target 交叉编译（如 x86_64-pc-windows-gnu）
#   deb平台标签  生成 deb 时的"平台"字段（ubuntu22.04 等）
#   deb依赖覆盖JSON  非空时经 --config 覆盖 bundle.linux.deb.depends。
#   默认不启用：实测 tauri 默认依赖（libgtk-3-0 等）在 noble/resolute 经
#   libgtk-3-0t64 的 virtual Provides 可正常解析安装（详见 README）；
#   此通道为未来发行版移除该虚拟名时预留
#
# 环境变量：BUILD_VERSION 非空时覆盖 package.json 的产物版本号（宿主 build.sh
#   -V 传入，CI 固定版本用）——同时经 --config "version" 注入 tauri bundle 版本
#   元数据，产物命名与包内版本一致；不改动 package.json/Cargo.toml/
#   tauri.conf.json 源文件。空 = 沿用 package.json（原行为）。
#   ⚠️ tauri 的 version 字段要求严格 semver（Jenkins build #1 实测：注入
#   git describe 兜底出的 "unknown" 报 `must be a semver string` 四平台全挂）——
#   非 semver 值告警并回落 package.json，不中断编译。
#
# 流程：/src 工程 rsync 到 /work（持久卷，src-tauri/target 等排除项增量复用）
#      → npm ci → tauri build → 产物按 工程名_平台_版本号.扩展名 规范复制回
#      /src/release/[debug/]。
# =============================================================================
set -euo pipefail

BUNDLES="${1:?用法: container-build.sh <bundles> <debug|release> [triple] [deb平台标签] [deb依赖覆盖JSON]}"
MODE="${2:?缺少第二参数 debug|release}"
TRIPLE="${3:-}"
DEB_PLATFORM="${4:-}"
DEB_DEPENDS="${5:-}"
[[ "$MODE" == "debug" || "$MODE" == "release" ]] || { echo "非法模式: $MODE" >&2; exit 2; }

PROFILE="$MODE"   # cargo profile 目录名与 debug/release 一致
OUT_SUB="release"; [[ "$MODE" == "debug" ]] && OUT_SUB="release/debug"

# ---- 1. 源码同步到 /work（保留 target/ 增量缓存，不带宿主 node_modules/dist/release）----
mkdir -p /work
rsync -a --delete \
    --exclude node_modules --exclude dist --exclude release --exclude .git \
    --exclude src-tauri/target --exclude build-env \
    /src/ /work/
cd /work

PKG_VERSION="$(node -p "require('./package.json').version")"
BUILD_VERSION="${BUILD_VERSION:-}"
# tauri "version" 字段要求严格 semver：非 semver 的 BUILD_VERSION（如 CI 无 tag 时
# git describe 兜底出的 "unknown"）不可注入，告警回落 package.json（不中断编译）
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if [[ -n "$BUILD_VERSION" && ! "$BUILD_VERSION" =~ $SEMVER_RE ]]; then
    echo "!! 警告: BUILD_VERSION '$BUILD_VERSION' 非合法 semver（tauri version 要求），回落 package.json 版本"
    BUILD_VERSION=""
fi
VERSION="${BUILD_VERSION:-$PKG_VERSION}"
if [[ -n "$BUILD_VERSION" ]]; then
    echo "==> 产物版本: $VERSION（宿主 -V 显式指定；package.json 为 $PKG_VERSION，源文件不改）"
else
    echo "==> 工程版本: $VERSION（来自 package.json）"
fi

# ---- 2. 前端依赖 ----
echo "==> npm ci"
npm ci --no-audit --no-fund --loglevel=error

# ---- 3. tauri build ----
TAURI_ARGS=(build)
[[ "$MODE" == "debug" ]] && TAURI_ARGS+=(--debug)
TAURI_ARGS+=(--bundles "$BUNDLES")
[[ -n "$TRIPLE" ]] && TAURI_ARGS+=(--target "$TRIPLE")
# tauri --config 深合并注入（不改工程 tauri.conf.json，两类覆盖合成一个 JSON）：
#   version     —— BUILD_VERSION（宿主 -V）非空时注入，bundle 命名/包元数据/应用
#                  内版本随产物版本号一致；
#   deb.depends —— noble/resolute 的 gtk3 运行时包已更名 libgtk-3-0t64，而 tauri
#                  bundler 默认写 libgtk-3-0（新系统上无可解析 provider），预留覆盖。
CFG_PARTS=()
[[ -n "$BUILD_VERSION" ]] && CFG_PARTS+=("\"version\":\"${VERSION}\"")
if [[ -n "$DEB_DEPENDS" ]]; then
    CFG_PARTS+=("\"bundle\":{\"linux\":{\"deb\":{\"depends\":${DEB_DEPENDS}}}}")
    echo "==> deb 依赖覆盖: $DEB_DEPENDS"
fi
if [[ "${#CFG_PARTS[@]}" -gt 0 ]]; then
    CFG="{$(IFS=,; echo "${CFG_PARTS[*]}")}"
    TAURI_ARGS+=(--config "$CFG")
    echo "==> tauri 配置注入: $CFG"
fi
echo "==> npm run tauri -- ${TAURI_ARGS[*]}"
npm run tauri -- "${TAURI_ARGS[@]}"

# ---- 4. 收集产物并按命名规范复制到 /src/release[debug] ----
BUNDLE_ROOT="src-tauri/target"
[[ -n "$TRIPLE" ]] && BUNDLE_ROOT="src-tauri/target/${TRIPLE}"
BUNDLE_ROOT="${BUNDLE_ROOT}/${PROFILE}/bundle"

DEST="/src/${OUT_SUB}"
mkdir -p "$DEST"

collect() { # $1=bundle子目录 $2=glob $3=平台标签 $4=扩展名
    local sub="$1" glob="$2" token="$3" ext="$4" src name
    src="$(find "${BUNDLE_ROOT}/${sub}" -maxdepth 1 -name "${glob}" 2>/dev/null | head -1 || true)"
    if [[ -z "$src" ]]; then
        echo "    !! 未找到 ${sub} 产物（期望 ${glob}）" >&2
        return 1
    fi
    name="filemanageClient_${token}_${VERSION}.${ext}"
    cp -f "$src" "${DEST}/${name}"
    echo "    产物: ${OUT_SUB}/${name}（源: $(basename "$src")）"
}

rc=0
IFS=',' read -ra BS <<< "$BUNDLES"
for b in "${BS[@]}"; do
    case "$b" in
        deb)      collect deb      '*.deb'      "$DEB_PLATFORM" deb || rc=1 ;;
        rpm)      collect rpm      '*.rpm'      rpm             rpm || rc=1 ;;
        appimage) collect appimage '*.AppImage' appimage        AppImage || rc=1 ;;
        nsis)     collect nsis     '*.exe'      windows10       exe || rc=1 ;;
        *) echo "未知 bundle: $b" >&2; rc=1 ;;
    esac
done
# 产物归属改回宿主用户（容器以 root 运行，避免 root 属主文件需 sudo 清理）
if [[ -n "${HOST_UID:-}" && "${HOST_UID}" != "0" ]]; then
    chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" /src/release 2>/dev/null || true
fi

exit "$rc"
