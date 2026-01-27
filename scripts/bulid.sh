# 在 Pi 上執行
gcc -o nfc_tool src/nfc_tool.c -lnfc_nci_linux -lpthread -I/usr/local/include

如果 `libnfc_nci_linux` 沒有安裝到系統路徑，您需要指定標頭檔和函式庫的路徑：

```bash
# 假設 linux_libnfc-nci 資料夾在 ../vendor/linux_libnfc-nci
gcc -o nfc_tool src/nfc_tool.c \
    -I../vendor/linux_libnfc-nci/src/include \
    -L../vendor/linux_libnfc-nci/.libs \
    -lnfc_nci_linux -lpthread

### 開發者注意事項
1.  **NDEF 實作**: 上述程式碼簡化了 `nfcWriteTag` 的細節。實際上 NXP 的範例 `demoapp/tools.c` 中有 `buildNDEF` 的相關實作，您可能需要將那部分邏輯複製進來或連結 `tools.c`。
2.  **執行權限**: 執行此工具需要 `sudo` 權限才能存取 I2C。

這個 `nfc_tool.c` 已經包含了我們討論的關鍵要素：JSON 標記、原子化操作邏輯、以及逾時控制。您可以先試著編譯它。