#!/bin/bash
# =============================================================================
# build.sh —— filemanageClient 多平台构建脚本（Docker 编译环境版）
#
# 编译环境（镜像缺失时自动构建，命名规范 filemanage-client-build:<平台标签>，
# 详见 build-env/README.md；Ubuntu 20.04 因 Tauri 2 运行时依赖不可行已移除）：
#   ubuntu22.04       → deb + rpm + AppImage
#   ubuntu24.04       → deb
#   ubuntu26.04       → deb
#   ubuntu22.04-win10 → Windows NSIS 安装包（交叉，最低 Windows 10）
#
# 用法:
#   ./build.sh -a <平台> [-d <debug|release>]   # 编译工程
#   ./build.sh -i [-a <平台>]                   # 构建编译环境镜像（不编译工程）
#   ./build.sh -n [-a <平台>]                   # 拉取编译环境镜像
#     -a  ubuntu22.04 | ubuntu24.04 | ubuntu26.04 | windows10 | rpm | appimage | all
#         （rpm/appimage 为 ubuntu22.04 环境的单产物便捷值；all=四环境全量）
#     -d  debug | release（默认 release）
#         release → release/，debug → release/debug/；文件名保持规范不变
#     -i  构建编译环境镜像（docker build），完成后退出，不编译工程；
#         带 -a 时只构建该平台对应环境的镜像，缺省=四环境全建
#     -n  拉取编译环境镜像（docker pull）编译前拉取镜像；仓库前缀
#         FMC_IMAGE_REGISTRY（默认 harbor.localserver.com:9080/filemanage，
#         对齐 filemanageServer 编译镜像仓库惯例），拉取后重打为本地名；
#         裸 -n 拉完即退出，同时给 -a 则继续编译（CI 常用 ./build.sh -n -a all）
#     -f  强制重建编译环境镜像（修改 build-env/Dockerfile.* 后需要；
#         随 -a 编译流程执行，重建后继续编译）
#     -V <版本号>  显式指定产物版本号（覆盖 package.json，可带或不带 v 前缀，
#         不加 -dirty）；仅影响产物命名与经 tauri --config 注入的 bundle 版本
#         元数据，不改动 package.json/Cargo.toml/tauri.conf.json 三处源文件
#     -h  显示本帮助
#
# 示例:
#   ./build.sh -n                # 先从仓库拉取四环境编译镜像，拉完退出
#   ./build.sh -i                # 或本地构建全部编译镜像，构建完退出
#   ./build.sh -a all            # 四环境 release → release/（本地缺镜像则自动构建）
#   ./build.sh -a windows10 -d debug
#   ./build.sh -n -a all -V v0.2.0   # CI：拉镜像+编译，版本固定为 0.2.0（不走 package.json）
#
# 产物命名（版本号优先级：-V 指定值 > package.json）：工程名_平台_版本号.拓展名
#   filemanageClient_ubuntu22.04_0.1.0.deb / filemanageClient_ubuntu24.04_*.deb
#   filemanageClient_ubuntu26.04_*.deb / filemanageClient_rpm_0.1.0.rpm
#   filemanageClient_appimage_0.1.0.AppImage / filemanageClient_windows10_0.1.0.exe
#
# 历史说明：-i/-n/-V 参数对齐 filemanageServer/build.sh 同名参数（需求：镜像管理与
# 版本号显式指定统一走 build.sh；Server 版本号来自 git tag，Client 来自 package.json）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_PREFIX="harbor.localserver.com:9080/filemanage/filemanage-client-build"

PLATFORMS=""
MODE="release"
BUILD_IMAGE=0
PULL_IMAGE=0
FORCE_BUILD=0
OPT_VERSION=""

usage() {   # 打印文件头注释（第 2 行起连续 # 块）
    awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"
    exit "${1:-0}"
}

while getopts ":a:d:iV:fnh" opt; do
    case "$opt" in
        a) PLATFORMS="$OPTARG" ;;
        d) MODE="$OPTARG" ;;
        i) BUILD_IMAGE=1 ;;
        n) PULL_IMAGE=1 ;;
        V) OPT_VERSION="$OPTARG" ;;
        f) FORCE_BUILD=1 ;;
        h) usage 0 ;;
        *) echo "未知参数 -$OPTARG（-h 查看用法）" >&2; usage 2 ;;
    esac
done

cd "$SCRIPT_DIR"

TRIPLE_WINDOWS="x86_64-pc-windows-gnu"
ALL_PLATFORMS="ubuntu22.04 ubuntu24.04 ubuntu26.04 windows10"

# deb 运行时依赖覆盖（默认空）：实测 tauri 默认依赖清单
# （libwebkit2gtk-4.1-0, libgtk-3-0）在 22.04/24.04/26.04 均可安装——noble+ 的
# libgtk-3-0 经 libgtk-3-0t64 的 virtual Provides 满足（容器内 apt dry-run 实测）。
# 若未来发行版移除该虚拟名，在此按环境注入 JSON 数组即经 --config 覆盖生效。
# 平台 → (环境标签, bundles, 交叉三元组, deb平台标签, deb依赖覆盖)
plan_platform() {
    DEB_DEPS=""
    case "$1" in
        ubuntu22.04) ENV_TAG="ubuntu22.04";        BUNDLES="deb,rpm,appimage"; TRIPLE="";          DEB_TOKEN="ubuntu22.04" ;;
        ubuntu24.04) ENV_TAG="ubuntu24.04";        BUNDLES="deb";              TRIPLE="";          DEB_TOKEN="ubuntu24.04" ;;
        ubuntu26.04) ENV_TAG="ubuntu26.04";        BUNDLES="deb";              TRIPLE="";          DEB_TOKEN="ubuntu26.04" ;;
        windows10)   ENV_TAG="ubuntu22.04-win10";  BUNDLES="nsis";             TRIPLE="$TRIPLE_WINDOWS"; DEB_TOKEN="" ;;
        rpm)         ENV_TAG="ubuntu22.04";        BUNDLES="rpm";              TRIPLE="";          DEB_TOKEN="" ;;
        appimage)    ENV_TAG="ubuntu22.04";        BUNDLES="appimage";         TRIPLE="";          DEB_TOKEN="" ;;
        *) return 1 ;;
    esac
}

# -i/-n 的镜像操作范围：平台参数 → 去重后的环境标签列表（空格分隔，首次出现为序）；
# 空参/-a all → 四环境全量。rpm/appimage 便捷值归并到 ubuntu22.04 环境。
env_tags() {
    local ps="$1" p out=" "
    [[ -n "$ps" && "$ps" != "all" ]] || ps="$ALL_PLATFORMS"
    for p in $ps; do
        plan_platform "$p" || { echo "错误：未知平台 '$p'（-h 查看列表）" >&2; return 2; }
        [[ "$out" == *" ${ENV_TAG} "* ]] && continue
        out+="${ENV_TAG} "
    done
    out="${out# }"
    echo "${out% }"
}

# 镜像管理操作（-i 构建 / -n 拉取）：参照 filemanageServer 同名参数。
if [[ "$BUILD_IMAGE" -eq 1 ]]; then
    tags="$(env_tags "$PLATFORMS")" || exit 2   # 平台非法即时退出，不误报镜像就绪
    for tag in $tags; do
        echo "==> 构建编译环境镜像 ${IMAGE_PREFIX}:${tag}（Dockerfile.${tag}）..."
        docker build -f "$SCRIPT_DIR/build-env/Dockerfile.${tag}" \
            -t "${IMAGE_PREFIX}:${tag}" "$SCRIPT_DIR/build-env" \
            || { echo "!! 编译环境镜像构建失败：${IMAGE_PREFIX}:${tag}" >&2; exit 1; }
    done
    echo "==> 镜像已构建完成，退出（未编译工程）"
    exit 0
fi
if [[ "$PULL_IMAGE" -eq 1 ]]; then
    tags="$(env_tags "$PLATFORMS")" || exit 2
    for tag in $tags; do
        echo "==> 拉取编译环境镜像 ${IMAGE_PREFIX}:${tag} ..."
        docker pull "${IMAGE_PREFIX}:${tag}" \
            || { echo "!! 拉取镜像失败：${IMAGE_PREFIX}:${tag}" >&2; exit 1; }
        docker tag "${IMAGE_PREFIX}:${tag}" "${IMAGE_PREFIX}:${tag}"
    done
    echo "==> 镜像已就绪（本地名 ${IMAGE_PREFIX}:<平台标签>）"
    [[ -n "$PLATFORMS" ]] || exit 0   # 裸 -n 只拉镜像；给了 -a 则继续编译
fi

# 编译路径：必须 -a
[[ -n "$PLATFORMS" ]] || { echo "错误：必须用 -a 指定编译平台（ubuntu22.04|ubuntu24.04|ubuntu26.04|windows10|rpm|appimage|all）" >&2; usage 2; }
[[ "$MODE" == "debug" || "$MODE" == "release" ]] || { echo "错误：-d 只能为 debug 或 release" >&2; exit 2; }

# 产物版本号：-V 显式指定（去 v 前缀，视为干净指定值、不加 -dirty），经
# BUILD_VERSION 传入容器覆盖 package.json；为空则容器内取 package.json。
BUILD_VERSION=""
if [[ -n "$OPT_VERSION" ]]; then
    BUILD_VERSION="${OPT_VERSION#v}"
    [[ "$BUILD_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] \
        || { echo "错误：-V 版本号非法（仅限字母数字开头，含 . + -，不可为空/含引号）" >&2; exit 2; }
fi

build_platform() {
    local p="$1"
    plan_platform "$p" || { echo "错误：未知平台 '$p'（-h 查看列表）" >&2; return 2; }
    local image="${IMAGE_PREFIX}:${ENV_TAG}"
    if [[ "$FORCE_BUILD" -eq 1 ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "==> 构建编译环境镜像 $image（$( [[ $FORCE_BUILD -eq 1 ]] && echo '-f 强制重建' || echo '缺失自动构建' )）"
        docker build -f "$SCRIPT_DIR/build-env/Dockerfile.${ENV_TAG}" -t "$image" "$SCRIPT_DIR/build-env" \
            || { echo "!! 编译环境镜像构建失败：$image" >&2; return 1; }
    fi
    docker volume create "fmc-work-${ENV_TAG}" >/dev/null
    docker volume create "fmc-cargo-${ENV_TAG}" >/dev/null
    docker volume create fmc-npm >/dev/null
    docker volume create fmc-cache >/dev/null

    echo "==> [$p] docker run $image  bundles=$BUNDLES mode=$MODE${TRIPLE:+ target=$TRIPLE}${BUILD_VERSION:+ version=$BUILD_VERSION}"
    docker run --rm \
        -v "$SCRIPT_DIR":/src \
        -v "fmc-work-${ENV_TAG}":/work \
        -v "fmc-cargo-${ENV_TAG}":/opt/cargo \
        -v fmc-npm:/opt/npm \
        -v fmc-cache:/root/.cache \
        -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
        -e BUILD_VERSION="$BUILD_VERSION" \
        "$image" bash /src/build-env/container-build.sh "$BUNDLES" "$MODE" "$TRIPLE" "$DEB_TOKEN" "$DEB_DEPS"
}

TARGETS="$PLATFORMS"
[[ "$PLATFORMS" == "all" ]] && TARGETS="$ALL_PLATFORMS"

fail=0
for p in $TARGETS; do
    if ! build_platform "$p"; then
        echo "!! 平台 $p 构建失败" >&2
        fail=1
    fi
done

echo "==> 产物清单（$( [[ $MODE == debug ]] && echo release/debug || echo release )/）："
OUT_DIR="release"; [[ "$MODE" == "debug" ]] && OUT_DIR="release/debug"
ls -lh "$SCRIPT_DIR/$OUT_DIR"/filemanageClient_* 2>/dev/null || true
exit "$fail"
