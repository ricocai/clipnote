#!/usr/bin/env bash
# S4-3 关键链路设备侧回归（设计 §8 可测试性：采集→落库→搜索→备份恢复）。
#
# 套件本体：entry/src/ohosTest/ets/test/KeyChain.test.ets（hypium）。
# 本脚本把「构建测试 HAP → 安装 → aa test 驱动 OpenHarmonyTestRunner」串成一条
# CI 可跑的命令；任一环节环境不满足（无 hvigorw / 无 hdc / 无设备）以明确
# 错误码退出（2=环境不可用，由 CI 标记为 skipped 而不是失败）。
#
# 用法：tools/hypium-keychain.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

log() { printf '[hypium-keychain] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 2; }

# --- 1. 定位工具链 -----------------------------------------------------------
HVIGORW=""
for c in "$ROOT/hvigorw" "$(command -v hvigorw 2>/dev/null || true)" \
         "$HOME/command-line-tools/bin/hvigorw" "$(command -v hvigor 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { HVIGORW="$c"; break; }
done
[ -z "$HVIGORW" ] && [ "$SKIP_BUILD" = "0" ] && die "未找到 hvigorw/hvigor（DevEco command-line-tools），且未传 --skip-build"

HDC=""
for c in "$(command -v hdc 2>/dev/null || true)" \
         "$HOME/command-line-tools/sdk/default/openharmony/toolchains/hdc"; do
  [ -n "$c" ] && [ -x "$c" ] && { HDC="$c"; break; }
done
[ -z "$HDC" ] && die "未找到 hdc"

hdc() { "$HDC" "$@"; }

# --- 2. 构建测试 HAP ---------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
  log "构建 entry@ohosTest 测试 HAP：$HVIGORW"
  "$HVIGORW" --mode module -p product=default -p module=entry@ohosTest assembleHap --no-daemon
else
  log "跳过构建（--skip-build），直接使用既有产物"
fi

APP_HAP="$(ls entry/build/default/outputs/default/entry-default-signed.hap 2>/dev/null || true)"
TEST_HAP="$(ls entry/build/default/outputs/default/entry_test-default-signed.hap 2>/dev/null || true)"
[ -z "$APP_HAP" ] && APP_HAP="$(ls entry/build/default/outputs/default/*-signed.hap 2>/dev/null | grep -v entry_test | head -1 || true)"
[ -z "$TEST_HAP" ] && TEST_HAP="$(ls entry/build/default/outputs/default/entry_test-*.hap 2>/dev/null | head -1 || true)"
[ -z "$APP_HAP" ] && die "未找到应用 HAP 产物（entry/build/.../entry-default-signed.hap）"
[ -z "$TEST_HAP" ] && die "未找到测试 HAP 产物（entry/build/.../entry_test-*.hap）"

# --- 3. 设备检查 + 安装 --------------------------------------------------------
hdc list targets | grep -q . || die "无可用 hdc 设备（连接真机/模拟器或启动 emulator）"
log "安装应用 HAP 与测试 HAP"
hdc install "$APP_HAP"
hdc install "$TEST_HAP"

# --- 4. 运行 hypium 套件 -------------------------------------------------------
BUNDLE="com.uwon.clipnote"
log "驱动 OpenHarmonyTestRunner（DataLayer + SpeechEngine + KeyChain）"
hdc shell aa test -b "$BUNDLE" -m entry_test -s unittest OpenHarmonyTestRunner
RC=$?
log "aa test 退出码：$RC（套件明细见上方输出 / hilog）"
exit "$RC"
