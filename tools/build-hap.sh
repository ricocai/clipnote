#!/bin/bash
# 命令行构建签名 HAP（等价于 DevEco Studio 的 Build Hap）
# 用法: tools/build-hap.sh [--release]
set -e
cd "$(dirname "$0")/.."

export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
export PATH="$DEVECO_SDK_HOME/../tools/node/bin:$DEVECO_SDK_HOME/../tools/ohpm/bin:$PATH"

BUILD_MODE=debug
[ "$1" = "--release" ] && BUILD_MODE=release

exec "$DEVECO_SDK_HOME/../tools/hvigor/bin/hvigorw" \
  --mode module -p product=default -p buildMode="$BUILD_MODE" \
  assembleHap --no-daemon
