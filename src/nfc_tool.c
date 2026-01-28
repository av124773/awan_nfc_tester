#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>
#include <errno.h>

#include "linux_nfc_api.h"
#include "ndef_helper.h"

#define OP_MODE_READ_VERIFY  1
#define OP_MODE_FORMAT_WRITE 2

typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t  cond;
    int             state;          // 0: Waiting, 1: Arrived
    nfc_tag_info_t  tagInfo;
} AppContext;

AppContext g_ctx;

int g_mode = 0;
char g_expect_data[256] = {0};
char g_write_payload[256] = {0};
int g_write_is_uri = 0;

// --- Callback ---
void onTagArrival(nfc_tag_info_t *pTagInfo) {
    if (pTagInfo == NULL) return;
    pthread_mutex_lock(&g_ctx.mutex);
    if (g_ctx.state == 0) {
        memcpy(&g_ctx.tagInfo, pTagInfo, sizeof(nfc_tag_info_t));
        g_ctx.state = 1;
        pthread_cond_signal(&g_ctx.cond);
    }
    pthread_mutex_unlock(&g_ctx.mutex);
}

void onTagDeparture(void) { }

// --- Helpers ---
void print_json_result(const char* status, const char* uid, const char* msg, const char* error_code) {
    printf("__NFC_JSON_START__{\"status\": \"%s\", \"uid\": \"%s\", \"msg\": \"%s\", \"error\": \"%s\"}__NFC_JSON_END__\n",
           status, uid ? uid : "", msg ? msg : "", error_code ? error_code : "");
}

void get_uid_string(nfc_tag_info_t* tag, char* buffer) {
    buffer[0] = 0;
    for (unsigned int i = 0; i < tag->uid_length; i++) {
        char temp[4];
        sprintf(temp, "%02X", tag->uid[i]);
        strcat(buffer, temp);
    }
}

// --- Logic (Aligned with DemoApp) ---

int check_is_ndef_with_retry(unsigned int handle, ndef_info_t *info) {
    int max_retries = 3;
    // DemoApp 並沒有重試，但保留一點容錯是好的
    for (int i = 0; i < max_retries; i++) {
        if (nfcTag_isNdef(handle, info) == 1) return 1;
        usleep(100 * 1000);
    }
    return 0;
}

int perform_read_verify(unsigned int handle, char* out_uid) {
    unsigned char read_buf[4096];
    char parsed_str[4096];
    int res;
    nfc_friendly_type_t friendly_type = NDEF_FRIENDLY_TYPE_OTHER;
    ndef_info_t ndefInfo;

    // 1. Check NDEF (比照 DemoApp 流程)
    if (check_is_ndef_with_retry(handle, &ndefInfo) != 1) {
        print_json_result("FAIL", out_uid, "Tag is not NDEF", "TAG_ERR");
        return -1;
    }

    // 2. Read NDEF
    if (ndefInfo.current_ndef_length > sizeof(read_buf)) {
        print_json_result("FAIL", out_uid, "NDEF too large", "SIZE_ERR");
        return -1;
    }
    
    // 如果長度為0，視為空標籤
    if (ndefInfo.current_ndef_length == 0) {
         if (strlen(g_expect_data) > 0) {
             print_json_result("FAIL", out_uid, "Empty Tag", "VERIFY_FAIL");
             return -1;
         }
         print_json_result("PASS", out_uid, "Empty", "NONE");
         return 0;
    }

    res = nfcTag_readNdef(handle, read_buf, ndefInfo.current_ndef_length, &friendly_type);
    if (res < 0) {
        print_json_result("FAIL", out_uid, "Read failed", "READ_ERR");
        return -1;
    }

    // 3. Parse & Verify
    if (ParseNDEFToString(read_buf, (unsigned int)res, parsed_str, sizeof(parsed_str)) != 0) {
        print_json_result("FAIL", out_uid, "Parse error", "PARSE_ERR");
        return -1;
    }

    if (strlen(g_expect_data) > 0) {
        if (strcmp(parsed_str, g_expect_data) == 0) {
            print_json_result("PASS", out_uid, parsed_str, "NONE");
            return 0;
        } else {
            char err_msg[512];
            snprintf(err_msg, sizeof(err_msg), "Mismatch: Exp[%s] Got[%s]", g_expect_data, parsed_str);
            print_json_result("FAIL", out_uid, err_msg, "VERIFY_FAIL");
            return -1;
        }
    } else {
        print_json_result("PASS", out_uid, parsed_str, "NONE");
        return 0;
    }
}

int perform_format_write(unsigned int handle, char* out_uid) {
    int res;
    unsigned char ndef_buf[1024];
    size_t ndef_len = 0;

    // Prepare Payload
    NdefType type = g_write_is_uri ? NDEF_TYPE_URI : NDEF_TYPE_TEXT;
    if (BuildNDEFBuffer(type, g_write_payload, ndef_buf, &ndef_len) != 0) {
        print_json_result("FAIL", out_uid, "Build NDEF failed", "BUILD_ERR");
        return -1;
    }

    // Format Logic (DemoApp Style)
    // DemoApp logic: if (!isFormatable) check isNdef. 
    // Simplified: Just try to write first if it's NDEF, if not try format.
    
    ndef_info_t info;
    int is_ndef = nfcTag_isNdef(handle, &info);
    
    if (!is_ndef) {
        if (nfcTag_isFormatable(handle)) {
            if (nfcTag_formatTag(handle) != 0) {
                print_json_result("FAIL", out_uid, "Format failed", "FORMAT_ERR");
                return -1;
            }
        } else {
            print_json_result("FAIL", out_uid, "Tag not writable", "TAG_ERR");
            return -1;
        }
    }

    // Write
    res = nfcTag_writeNdef(handle, ndef_buf, (unsigned int)ndef_len);
    if (res != 0) {
        print_json_result("FAIL", out_uid, "Write failed", "WRITE_ERR");
        return -1;
    }

    // Read Back Verify
    usleep(50 * 1000); // Small delay
    strncpy(g_expect_data, g_write_payload, sizeof(g_expect_data));
    return perform_read_verify(handle, out_uid);
}

// --- Main ---
int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("Usage: %s <read|verify|write|write_uri> [data]\n", argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "read") == 0) g_mode = OP_MODE_READ_VERIFY;
    else if (strcmp(argv[1], "verify") == 0) {
        g_mode = OP_MODE_READ_VERIFY;
        if (argc >= 3) strncpy(g_expect_data, argv[2], sizeof(g_expect_data));
    } else if (strcmp(argv[1], "write") == 0) {
        g_mode = OP_MODE_FORMAT_WRITE;
        g_write_is_uri = 0;
        if (argc >= 3) strncpy(g_write_payload, argv[2], sizeof(g_write_payload));
    } else if (strcmp(argv[1], "write_uri") == 0) {
        g_mode = OP_MODE_FORMAT_WRITE;
        g_write_is_uri = 1;
        if (argc >= 3) strncpy(g_write_payload, argv[2], sizeof(g_write_payload));
    }

    pthread_mutex_init(&g_ctx.mutex, NULL);
    pthread_cond_init(&g_ctx.cond, NULL);
    g_ctx.state = 0;

    InitializeLogLevel();

    if (doInitialize() != 0) {
        print_json_result("FAIL", "", "NFC Init failed", "INIT_ERR");
        return 1;
    }

    nfcTagCallback_t cb;
    cb.onTagArrival = onTagArrival;
    cb.onTagDeparture = onTagDeparture;
    registerTagCallback(&cb);

    doEnableDiscovery(DEFAULT_NFA_TECH_MASK, 0x00, 0, 0);

    // Wait Phase
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 10; // 10s Timeout

    pthread_mutex_lock(&g_ctx.mutex);
    int wait_res = 0;
    while (g_ctx.state == 0 && wait_res == 0) {
        wait_res = pthread_cond_timedwait(&g_ctx.cond, &g_ctx.mutex, &ts);
    }
    pthread_mutex_unlock(&g_ctx.mutex);

    if (wait_res == ETIMEDOUT) {
        print_json_result("FAIL", "", "Timeout", "TIMEOUT");
    } 
    else if (g_ctx.state == 1) {
        char uid_str[32];
        get_uid_string(&g_ctx.tagInfo, uid_str);
        
        // CORRECTION: DO NOT DISABLE DISCOVERY HERE!
        // DemoApp keeps discovery active during read/write.
        
        if (g_mode == OP_MODE_FORMAT_WRITE) {
            perform_format_write(g_ctx.tagInfo.handle, uid_str);
        } else {
            perform_read_verify(g_ctx.tagInfo.handle, uid_str);
        }
    }

    // Cleanup Phase (Disable Discovery ONLY at the end)
    disableDiscovery(); // Use disableDiscovery() not doDisableDiscovery() as per DemoApp
    deregisterTagCallback();
    doDeinitialize();
    
    pthread_mutex_destroy(&g_ctx.mutex);
    pthread_cond_destroy(&g_ctx.cond);

    return 0;
}
