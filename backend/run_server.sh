#!/bin/bash
cd "$(dirname "$0")"

lsof -t -i:8000 | xargs -r kill -9

# 檢查是否需要編譯 C 程式
if [ ! -f "../nfc_tool" ]; then
    echo "[INFO] Compiling nfc_tool..."
    cd ..
    ./scripts/build_tool.sh
    cd backend
    if [ ! -f "../nfc_tool" ]; then
        echo "[ERROR] Compilation failed!"
        exit 1
    fi
fi

# 啟動 Python 環境
if [ ! -d "venv" ]; then
    echo "[INFO] Setting up venv..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

# 啟動 Server (單一 Worker)
echo "[INFO] Starting Backend..."
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1
