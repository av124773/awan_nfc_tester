#include <stdio.h>
#include <string.h>
#include "../src/ndef_helper.h"

// 簡單的 Assert 巨集
#define ASSERT_STR_EQ(expect, actual) \
    do { \
        if (strcmp(expect, actual) != 0) { \
            printf("[FAIL] Line %d: Expect '%s', Got '%s'\n", __LINE__, expect, actual); \
            return 1; \
        } else { \
            printf("[PASS] Line %d: '%s' Match\n", __LINE__, expect); \
        } \
    } while(0)

int main() {
    unsigned char buffer[256];
    char output_str[256];
    size_t len = 0;
    
    printf("=== Test 1: URI Construction & Parsing ===\n");
    // 1. 建立 URI
    if (BuildNDEFBuffer(NDEF_TYPE_URI, "http://example.com", buffer, &len) != 0) {
        printf("[FAIL] Build URI failed\n");
        return 1;
    }
    
    // 2. 驗證 Raw Data (0xD1, 0x01, Len, 'U', 0x00, ...)
    if (buffer[0] != 0xD1 || buffer[3] != 'U') {
        printf("[FAIL] Header byte incorrect: %02X %02X\n", buffer[0], buffer[3]);
        return 1;
    }

    // 3. 解析回字串
    if (ParseNDEFToString(buffer, len, output_str, sizeof(output_str)) != 0) {
        printf("[FAIL] Parse URI failed\n");
        return 1;
    }
    
    // 4. 比對結果
    ASSERT_STR_EQ("http://example.com", output_str);


    printf("\n=== Test 2: Text Construction & Parsing ===\n");
    // 1. 建立 Text
    memset(buffer, 0, sizeof(buffer));
    memset(output_str, 0, sizeof(output_str));
    
    if (BuildNDEFBuffer(NDEF_TYPE_TEXT, "FactoryTest123", buffer, &len) != 0) {
        printf("[FAIL] Build Text failed\n");
        return 1;
    }

    // 2. 解析回字串
    if (ParseNDEFToString(buffer, len, output_str, sizeof(output_str)) != 0) {
        printf("[FAIL] Parse Text failed\n");
        return 1;
    }

    // 3. 比對結果
    ASSERT_STR_EQ("FactoryTest123", output_str);

    printf("\n=== All Tests Passed ===\n");
    return 0;
}
