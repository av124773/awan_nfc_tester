#!/bin/bash

# 定義路徑 (依據您上傳的結構)
ROOT_DIR=$(pwd)
SRC_DIR="$ROOT_DIR/src"
VENDOR_DIR="$ROOT_DIR/vendor/linux_libnfc-nci"
INCLUDE_DIR="$VENDOR_DIR/src/include"
LIB_DIR="/usr/local/lib" # 假設您之前執行 sudo make install 安裝到了這裡

# 檢查必要的 Library 是否存在
if [ ! -f "$LIB_DIR/libnfc_nci_linux.so" ]; then
    echo "[Error] libnfc_nci_linux.so not found in $LIB_DIR"
    echo "Please go to $VENDOR_DIR and run 'sudo make install' first."
    exit 1
fi

echo "Building nfc_tool..."

# 編譯指令
# -I: 包含 header
# -L: 指定 library 路徑
# -l: 連結 library (nfc_nci_linux 和 pthread)
# -Wl,-rpath: 執行時自動尋找 .so
gcc -o nfc_tool \
    "$SRC_DIR/nfc_tool.c" \
    "$SRC_DIR/ndef_helper.c" \
    -I "$SRC_DIR" \
    -I "$INCLUDE_DIR" \
    -L "$LIB_DIR" \
    -lnfc_nci_linux \
    -lpthread \
    -Wl,-rpath,"$LIB_DIR"

if [ $? -eq 0 ]; then
    echo "[Success] Binary created: ./nfc_tool"
else
    echo "[Fail] Compilation failed."
fi
