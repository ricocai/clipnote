#!/bin/bash
# 命令行构建签名 HAP（等价于 DevEco Studio 的 Build Hap）
# 用法: tools/build-hap.sh [--release]
set -e
cd "$(dirname "$0")/.."

# build-profile.json5 不入库（签名凭据）：首次构建前从模板复制一份到本地
if [ ! -f build-profile.json5 ]; then
  cp build-profile.template.json5 build-profile.json5
  echo "[build-hap] 已从模板生成 build-profile.json5（请先完成 DevEco 签名配置再打包签名）"
fi

export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home
export PATH="$DEVECO_SDK_HOME/../tools/node/bin:$DEVECO_SDK_HOME/../tools/ohpm/bin:$PATH"

BUILD_MODE=debug
[ "$1" = "--release" ] && BUILD_MODE=release

exec "$DEVECO_SDK_HOME/../tools/hvigor/bin/hvigorw" \
  --mode module -p product=default -p buildMode="$BUILD_MODE" \
  assembleHap --no-daemon
