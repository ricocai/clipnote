#!/bin/sh
# G7 设备侧代理构建：把 OpenHarmony 同版本 SQLite（oh-sqlite/src/sqlite3.c，3.40.1）
# 按 BUILD.gn 中与检索相关的主库 defines 编译，并与 addon.cc 链接为 Node N-API 插件。
#
# 刻意镜像的 flags（见 oh-sqlite/BUILD.gn ohos_shared_library("sqlite")）：
#   FTS3/3_TOKENIZER/FTS4/FTS5、THREADSAFE=2、TEMP_STORE=3、DEFAULT_AUTOVACUUM=1、
#   SECURE_DELETE、DEFAULT_JOURNAL_SIZE_LIMIT、DEFAULT_FILE_FORMAT=4、POWERSAFE_OVERWRITE。
# 刻意省略的 flags（主机无法/无需复现，不影响检索语义）：SQLITE_HAS_CODEC（OH 加密编解码
# 依赖平台 KMS，amalgamation 不含实现）、SQLITE_ENABLE_ICU（需 ICU 链接，unicode61 分词器
# 不依赖 ICU）、BATCH_ATOMIC_WRITE/USE_PREAD64/FDSAN/HARMONY_OS（OH 内核/OS 专用）、
# SQLITE_OMIT_COMPILEOPTION_DIAGS（保留，便于报告用 PRAGMA compile_options 自证构建口径）。
set -e
cd "$(dirname "$0")"

NODE_PREFIX="$(npm config get prefix)"
NODE_INC="${NODE_PREFIX}/include/node"
if [ ! -f "${NODE_INC}/node_api.h" ]; then
  # 部分发行版头文件不在 prefix 下（如 nvm），回退到 node-gyp 缓存
  NODE_INC="$(ls -d "$HOME"/.cache/node-gyp/*/include/node 2>/dev/null | sort -V | tail -1)"
fi
if [ ! -f "${NODE_INC}/node_api.h" ]; then
  echo "找不到 Node 头文件（node_api.h）" >&2
  exit 1
fi
echo "Node headers: ${NODE_INC}"

CFLAGS="-O2 -fPIC -std=c99 \
  -DSQLITE_ENABLE_FTS3 \
  -DSQLITE_ENABLE_FTS3_TOKENIZER \
  -DSQLITE_ENABLE_FTS4 \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_THREADSAFE=2 \
  -DSQLITE_TEMP_STORE=3 \
  -DHAVE_USLEEP=1 \
  -DSQLITE_HAVE_ISNAN \
  -DSQLITE_DEFAULT_JOURNAL_SIZE_LIMIT=1048576 \
  -DSQLITE_DEFAULT_FILE_FORMAT=4 \
  -DSQLITE_DEFAULT_AUTOVACUUM=1 \
  -DSQLITE_POWERSAFE_OVERWRITE=1 \
  -DSQLITE_SECURE_DELETE \
  -DSQLITE_EXPORT_SYMBOLS \
  -DNDEBUG=1"

echo "编译 sqlite3.c（OpenHarmony 3.40.1 amalgamation）…"
clang $CFLAGS -Ioh-sqlite/include -c oh-sqlite/src/sqlite3.c -o sqlite3.o

echo "编译并链接 addon（N-API）…"
clang++ -O2 -std=c++17 -fPIC -shared \
  -I"${NODE_INC}" \
  -undefined dynamic_lookup \
  addon.cc sqlite3.o \
  -o g7proxy.node

rm -f sqlite3.o
echo "完成：$(pwd)/g7proxy.node"
