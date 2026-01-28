#!/bin/bash

# 設定路徑變數 (確保腳本在哪執行都能找到根目錄)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/.."
VENDOR_DIR="$PROJECT_ROOT/vendor/linux_libnfc-nci"

# 1. 檢查 Header 檔是否存在
HEADER_DIR="$VENDOR_DIR/src/include"
if [ ! -f "$HEADER_DIR/linux_nfc_api.h" ]; then
    echo "❌ Error: Header file not found at $HEADER_DIR/linux_nfc_api.h"
    echo "   Please check vendor submodule or path."
    exit 1
fi

# 2. 檢查 Library 連結方式
# 優先檢查系統是否有安裝 (make install)
if ldconfig -p | grep -q libnfc_nci_linux; then
    echo "ℹ️  Using system installed library (libnfc_nci_linux)"
    LIB_FLAGS="-lnfc_nci_linux"
else
    # 若系統無，則嘗試連結 vendor 內編譯好的 .so
    # 注意: Autotools 編譯出的 .so 通常在 .libs 隱藏目錄下
    LOCAL_LIB_DIR="$VENDOR_DIR/.libs"
    if [ -d "$LOCAL_LIB_DIR" ]; then
        echo "ℹ️  Using local vendor library from $LOCAL_LIB_DIR"
        # -Wl,-rpath 確保執行時找得到這個路徑，不用設 LD_LIBRARY_PATH
        LIB_FLAGS="-L$LOCAL_LIB_DIR -lnfc_nci_linux -Wl,-rpath,$LOCAL_LIB_DIR"
    else
        echo "⚠️  Warning: Local library build directory not found. Assuming -lnfc_nci_linux works globally."
        LIB_FLAGS="-lnfc_nci_linux"
    fi
fi

# 3. 執行編譯
echo "🔨 Compiling nfc_tool..."
gcc -o "$PROJECT_ROOT/nfc_tool" \
    "$PROJECT_ROOT/src/nfc_tool.c" \
    -I"$HEADER_DIR" \
    $LIB_FLAGS \
    -lpthread \
    -Wall

# 4. 檢查結果
if [ $? -eq 0 ]; then
    echo "✅ Build Success! Executable created at: $PROJECT_ROOT/nfc_tool"
    echo "   Run with: sudo ./nfc_tool read_verify"
else
    echo "❌ Build Failed."
    exit 1
fi