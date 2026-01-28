#ifndef NDEF_HELPER_H
#define NDEF_HELPER_H

#include <stdint.h>
#include <stddef.h>

// NDEF 類型定義 (參考 NXP DemoApp)
typedef enum {
    NDEF_TYPE_UNKNOWN = 0,
    NDEF_TYPE_URI,
    NDEF_TYPE_TEXT,
    NDEF_TYPE_MIME
} NdefType;

// NDEF 記錄結構
typedef struct {
    NdefType type;
    char* payload;      // 用於儲存 URL 或 文字內容
    size_t payload_len;
} NdefRecord;

/**
 * 建構 NDEF 訊息的 Byte Array (目前支援 URI 與 Text)
 * @param type: NDEF_TYPE_URI 或 NDEF_TYPE_TEXT
 * @param input_data: 原始資料 (如 "http://google.com" 或 "Hello")
 * @param out_buffer: 輸出的緩衝區 (呼叫者需 allocate)
 * @param out_len: 輸出 buffer 的長度，回傳實際寫入長度
 * @return: 0 成功, -1 失敗
 */
int BuildNDEFBuffer(NdefType type, const char* input_data, unsigned char* out_buffer, size_t* out_len);

/**
 * 解析 NDEF 訊息並轉換為可讀字串 (取代 PrintNDEFContent)
 * @param p_ndef_data: 讀取到的 NDEF Raw Data
 * @param ndef_len: 資料長度
 * @param out_str: 用於輸出的字串 buffer
 * @param max_str_len: out_str 的最大長度
 * @return: 0 成功, -1 解析失敗
 */
int ParseNDEFToString(const unsigned char* p_ndef_data, uint32_t ndef_len, char* out_str, size_t max_str_len);

#endif // NDEF_HELPER_H
