#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "ndef_helper.h"

// 內部 Helper: 將 URI 前綴代碼轉換為字串 (參考 NFC Forum Spec)
static const char* get_uri_prefix(uint8_t identifier) {
    switch (identifier) {
        case 0x01: return "http://www.";
        case 0x02: return "https://www.";
        case 0x03: return "http://";
        case 0x04: return "https://";
        case 0x06: return "mailto:";
        default: return "";
    }
}

// 實作：建構 NDEF (移植自 demoapp/main.c BuildNDEFMessage 並簡化)
int BuildNDEFBuffer(NdefType type, const char* input_data, unsigned char* out_buffer, size_t* out_len) {
    if (!input_data || !out_buffer || !out_len) return -1;
    
    size_t data_len = strlen(input_data);
    size_t idx = 0;

    if (type == NDEF_TYPE_URI) {
        // 建構 URI Record (簡化版：不自動壓縮前綴，統一使用 0x00 無前綴模式以保持相容性)
        // Header: MB=1, ME=1, CF=0, SR=1, IL=0, TNF=0x01 (NFC Forum Well Known Type) -> 0xD1
        out_buffer[idx++] = 0xD1; 
        out_buffer[idx++] = 0x01; // Type Length (1 byte for 'U')
        out_buffer[idx++] = (unsigned char)(data_len + 1); // Payload Length (1 byte prefix + data)
        out_buffer[idx++] = 'U';  // Type: URI
        out_buffer[idx++] = 0x00; // Identifier Code: 0x00 (No prepending)
        memcpy(&out_buffer[idx], input_data, data_len);
        idx += data_len;
    } 
    else if (type == NDEF_TYPE_TEXT) {
        // 建構 Text Record
        // Header: MB=1, ME=1, CF=0, SR=1, IL=0, TNF=0x01 -> 0xD1
        out_buffer[idx++] = 0xD1;
        out_buffer[idx++] = 0x01; // Type Length ('T')
        // Payload Len: Status Byte (1) + Lang (2 "en") + Text
        size_t lang_len = 2;
        out_buffer[idx++] = (unsigned char)(1 + lang_len + data_len); 
        out_buffer[idx++] = 'T';  // Type: Text
        
        // Status Byte: UTF-8 (bit7=0), Lang Len=2 (bit5-0) -> 0x02
        out_buffer[idx++] = 0x02; 
        out_buffer[idx++] = 'e'; out_buffer[idx++] = 'n'; // Lang: en
        memcpy(&out_buffer[idx], input_data, data_len);
        idx += data_len;
    } else {
        return -1; // 不支援的類型
    }

    *out_len = idx;
    return 0;
}

// 實作：解析 NDEF (重構自 PrintNDEFContent)
int ParseNDEFToString(const unsigned char* p_ndef_data, uint32_t ndef_len, char* out_str, size_t max_str_len) {
    if (!p_ndef_data || ndef_len < 3 || !out_str) return -1;

    // 清空輸出
    memset(out_str, 0, max_str_len);

    uint32_t idx = 0;
    
    // 簡單解析第一個 Record (假設是單一 Message)
    // 檢查 TNF (Type Name Format) - Mask 0x07
    uint8_t header = p_ndef_data[idx++];
    uint8_t tnf = header & 0x07;

    if (tnf != 0x01) { // 僅支援 Well Known Type
        snprintf(out_str, max_str_len, "ERR:Unsupported_TNF_%02X", tnf);
        return -1;
    }

    uint8_t type_len = p_ndef_data[idx++];
    uint32_t payload_len = 0;
    
    // 檢查 SR (Short Record) - Bit 4
    if (header & 0x10) {
        payload_len = p_ndef_data[idx++];
    } else {
        // Long Record (4 bytes length) - 我們的應用場景可能較少見，但還是保留邏輯
        // DemoApp 簡化了這裡，我們暫時假設是 SR，因為產線寫入通常不長
        snprintf(out_str, max_str_len, "ERR:Long_Record_Unsupported"); 
        return -1;
    }

    // 檢查 Type
    if (idx + type_len > ndef_len) return -1;
    char type_char = p_ndef_data[idx];
    idx += type_len; // 跳過 Type 欄位

    // 解析 Payload
    if (type_char == 'U') { // URI
        if (idx >= ndef_len) return -1;
        uint8_t prefix_code = p_ndef_data[idx++];
        const char* prefix = get_uri_prefix(prefix_code);
        
        uint32_t actual_text_len = payload_len - 1; // 減去 prefix byte
        
        snprintf(out_str, max_str_len, "%s", prefix);
        size_t current_len = strlen(out_str);
        
        if (current_len + actual_text_len < max_str_len) {
            strncat(out_str, (const char*)&p_ndef_data[idx], actual_text_len);
        }
    } 
    else if (type_char == 'T') { // Text
        if (idx >= ndef_len) return -1;
        uint8_t status = p_ndef_data[idx++];
        uint8_t lang_len = status & 0x1F; // 低 5 bits 是語言長度
        
        idx += lang_len; // 跳過語言代碼 (如 "en")
        
        uint32_t actual_text_len = payload_len - 1 - lang_len;
        
        if (actual_text_len < max_str_len) {
            strncat(out_str, (const char*)&p_ndef_data[idx], actual_text_len);
        }
    } 
    else {
        snprintf(out_str, max_str_len, "ERR:Unknown_Type_%c", type_char);
        return -1;
    }

    return 0;
}
