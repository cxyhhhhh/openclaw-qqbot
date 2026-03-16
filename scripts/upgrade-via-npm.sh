#!/bin/bash

# qqbot 通过 npm 包升级（纯文件操作版本）
#
# 重要：此脚本不修改 openclaw.json 配置文件！
# 配置更新由调用方（TS handler）在脚本完成后统一处理，
# 避免 gateway config watcher 在安装过程中触发 SIGUSR1 重启导致竞态。
#
# 用法:
#   upgrade-via-npm.sh                                    # 升级到 latest（默认）
#   upgrade-via-npm.sh --version <version>                # 升级到指定版本
#   upgrade-via-npm.sh --self-version                     # 升级到当前仓库 package.json 版本

set -eo pipefail

PKG_NAME="@tencent-connect/openclaw-qqbot"
INSTALL_SRC=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJECT_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)"

print_usage() {
    echo "用法:"
    echo "  upgrade-via-npm.sh                              # 升级到 latest（默认）"
    echo "  upgrade-via-npm.sh --version <版本号>            # 升级到指定版本"
    if [ -n "$LOCAL_VERSION" ]; then
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本（$LOCAL_VERSION）"
    else
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本"
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)
            [ -z "$2" ] && echo "❌ --tag 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --version)
            [ -z "$2" ] && echo "❌ --version 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --self-version)
            [ -z "$LOCAL_VERSION" ] && echo "❌ 无法从 package.json 读取版本" && exit 1
            INSTALL_SRC="${PKG_NAME}@${LOCAL_VERSION}"
            shift 1
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done
INSTALL_SRC="${INSTALL_SRC:-${PKG_NAME}@latest}"

# 检测 CLI（仅用于确定 extensions 目录路径）
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

EXTENSIONS_DIR="$HOME/.$CMD/extensions"

echo "==========================================="
echo "  qqbot npm 升级: $INSTALL_SRC"
echo "==========================================="
echo ""

# [1/3] 下载并安装新版本到临时目录
echo "[1/3] 下载新版本..."
TMPDIR_PACK=$(mktemp -d)
EXTRACT_DIR=$(mktemp -d)
trap "rm -rf '$TMPDIR_PACK' '$EXTRACT_DIR'" EXIT

cd "$TMPDIR_PACK"
npm pack "$INSTALL_SRC" --quiet 2>&1 || { echo "❌ npm pack 失败"; exit 1; }
TGZ_FILE=$(ls -1 *.tgz 2>/dev/null | head -1)
[ -z "$TGZ_FILE" ] && echo "❌ 未找到下载的 tgz 文件" && exit 1
echo "  已下载: $TGZ_FILE"

tar xzf "$TGZ_FILE" -C "$EXTRACT_DIR"
PACKAGE_DIR="$EXTRACT_DIR/package"
[ ! -d "$PACKAGE_DIR" ] && echo "❌ 解压失败，未找到 package 目录" && exit 1

# 准备 staging 目录：放在 ~/.openclaw/ 下（extensions 的父目录），
# 同一文件系统保证 mv 原子操作，同时避免 OpenClaw 扫描 extensions/ 时发现它。
STAGING_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$PACKAGE_DIR/"* "$STAGING_DIR/"

# 依赖处理：所有 production dependencies 都声明为 bundledDependencies，
# npm pack 时已打包进 tgz，解压后 node_modules/ 已包含全部依赖，无需 npm install。
# 注意：不能执行 npm install，否则会安装 peerDependencies（openclaw 平台及其 400+ 传递依赖），
# 导致插件目录膨胀到 900MB+，而这些依赖在运行时由宿主 openclaw 提供。
if [ -d "$STAGING_DIR/node_modules" ]; then
    BUNDLED_COUNT=$(ls -d "$STAGING_DIR/node_modules"/*/ "$STAGING_DIR/node_modules"/@*/*/ 2>/dev/null | wc -l | tr -d ' ')
    echo "  bundled 依赖已就绪（${BUNDLED_COUNT} 个包）"
else
    echo "  ⚠️  未找到 bundled node_modules，尝试安装依赖..."
    NPM_TMP_CACHE=$(mktemp -d)
    (cd "$STAGING_DIR" && npm install --omit=dev --omit=peer --ignore-scripts --cache="$NPM_TMP_CACHE" --quiet 2>&1) || echo "  ⚠️  依赖安装失败"
    rm -rf "$NPM_TMP_CACHE"
fi

# 清理下载临时文件
rm -rf "$TMPDIR_PACK" "$EXTRACT_DIR"
cd "$HOME"

# [2/3] 原子替换：先移走旧目录，再把 staging 目录 rename 过去
# 这样 extensions/openclaw-qqbot 只有极短的不存在时间窗口
echo ""
echo "[2/3] 原子替换插件目录..."
TARGET_DIR="$EXTENSIONS_DIR/openclaw-qqbot"
OLD_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-old"

rm -rf "$OLD_DIR"
if [ -d "$TARGET_DIR" ]; then
    mv "$TARGET_DIR" "$OLD_DIR"
fi
mv "$STAGING_DIR" "$TARGET_DIR"
rm -rf "$OLD_DIR"

# 清理可能残留的旧版 staging 目录（extensions 内外都清理）
rm -rf "$EXTENSIONS_DIR/openclaw-qqbot.staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-old"

# 同时清理历史遗留的其他目录名
for dir_name in qqbot openclaw-qq; do
    [ -d "$EXTENSIONS_DIR/$dir_name" ] && rm -rf "$EXTENSIONS_DIR/$dir_name"
done
echo "  已安装到: $TARGET_DIR"

# [3/3] 输出新版本号和升级报告（供调用方解析）
echo ""
echo "[3/3] 验证安装..."
NEW_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$EXTENSIONS_DIR', 'openclaw-qqbot', 'package.json');
    if (fs.existsSync(p)) {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) { process.stdout.write(v); process.exit(0); }
    }
  } catch {}
" 2>/dev/null || true)"
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"

# 输出结构化升级报告（QQBOT_REPORT=...），供 TS handler 解析后直接回复用户
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    echo "QQBOT_REPORT=✅ QQBot 升级完成: v${NEW_VERSION}"
else
    echo "QQBOT_REPORT=⚠️ QQBot 升级异常，无法确认新版本"
fi

echo ""
echo "==========================================="
echo "  ✅ 文件安装完成"
echo "==========================================="
