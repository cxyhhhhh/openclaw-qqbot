#!/bin/bash

# QQBot 通过 npm 包升级
#
# 用法:
#   npm-upgrade.sh                                    # 升级到 latest（默认）
#   npm-upgrade.sh --tag alpha                        # 升级到 alpha
#   npm-upgrade.sh --version 1.0.0-alpha.0            # 升级到指定版本

set -eo pipefail

PKG_NAME="@tencent-connect/openclaw-qqbot"
INSTALL_SRC=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)     INSTALL_SRC="${PKG_NAME}@$2"; shift 2 ;;
        --version) INSTALL_SRC="${PKG_NAME}@$2"; shift 2 ;;
        -h|--help)
            echo "用法:"
            echo "  npm-upgrade.sh                              # 升级到 latest（默认）"
            echo "  npm-upgrade.sh --tag alpha                   # 升级到 alpha"
            echo "  npm-upgrade.sh --version 1.0.0-alpha.0       # 升级到指定版本"
            exit 0
            ;;
        *) echo "未知选项: $1"; exit 1 ;;
    esac
done
INSTALL_SRC="${INSTALL_SRC:-${PKG_NAME}@latest}"

# 检测 CLI
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

APP_CONFIG="$HOME/.$CMD/$CMD.json"
EXTENSIONS_DIR="$HOME/.$CMD/extensions"

echo "==========================================="
echo "  QQBot npm 升级: $INSTALL_SRC"
echo "==========================================="
echo ""

# [1/4] 备份并临时移除通道配置（避免 plugins install 因 unknown channel 拒绝执行）
echo "[1/4] 备份通道配置..."
if [ -f "$APP_CONFIG" ]; then
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
        let saved = null;
        for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (ch) { saved = ch; delete cfg.channels[key]; break; }
        }
        // 清理 plugins.entries 中的旧记录（避免 stale config entry 告警）
        if (cfg.plugins && cfg.plugins.entries) {
            delete cfg.plugins.entries['openclaw-qqbot'];
        }
        if (saved) {
            fs.writeFileSync('$APP_CONFIG.qqbot-backup.json', JSON.stringify(saved, null, 2));
            fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
            console.log('  ✅ 已备份并临时移除 channels.qqbot');
        } else {
            console.log('  ℹ️  无已有通道配置');
        }
    " 2>/dev/null || echo "  ⚠️  备份失败"
else
    echo "  ℹ️  无配置文件"
fi

# [2/4] 清理旧插件目录
echo ""
echo "[2/4] 清理旧插件..."
for old_plugin in openclaw-qqbot qqbot openclaw-qq @sliverp/qqbot @tencent-connect/qqbot @tencent-connect/openclaw-qq @tencent-connect/openclaw-qqbot; do
    $CMD plugins uninstall "$old_plugin" 2>/dev/null && echo "  已卸载: $old_plugin" || true
done
for dir_name in openclaw-qqbot qqbot openclaw-qq; do
    if [ -d "$EXTENSIONS_DIR/$dir_name" ]; then
        rm -rf "$EXTENSIONS_DIR/$dir_name"
        echo "  已清理残留目录: $dir_name"
    fi
done

# [3/4] 安装新版本
echo ""
echo "[3/4] 安装新版本..."
$CMD plugins install "$INSTALL_SRC" 2>&1

# 恢复通道配置
BACKUP_FILE="$APP_CONFIG.qqbot-backup.json"
if [ -f "$BACKUP_FILE" ] && [ -f "$APP_CONFIG" ]; then
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        const saved = JSON.parse(fs.readFileSync('$BACKUP_FILE', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = saved;
        fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        fs.unlinkSync('$BACKUP_FILE');
        console.log('  ✅ 通道配置已恢复');
    " 2>/dev/null || echo "  ⚠️  通道配置恢复失败，请手动检查: $APP_CONFIG"
fi

# [4/4] 重启网关
echo ""
echo "[4/4] 重启网关..."
$CMD gateway restart 2>&1 || true

echo ""
echo "==========================================="
echo "  ✅ 升级完成"
echo "==========================================="
echo ""
echo "常用命令:"
echo "  $CMD logs --follow        # 跟踪日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
