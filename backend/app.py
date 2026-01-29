import os
import json
import logging
import subprocess
import threading
import time
import re
from logging.handlers import TimedRotatingFileHandler
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

# --- 配置區 ---
# 優先讀取環境變數，預設為相對於 backend 目錄的上一層
NFC_TOOL_PATH = os.getenv("NFC_TOOL_PATH", os.path.abspath(os.path.join(os.path.dirname(__file__), "../nfc_tool")))

LOG_DIR = "logs"
ERROR_MAPPING_FILE = "error_mapping.json"
NFC_TIMEOUT_SEC = 12 

# --- 1. 日誌系統 ---
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)

log_formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s')
log_handler = TimedRotatingFileHandler(f"{LOG_DIR}/app.log", when="midnight", interval=1, backupCount=7, encoding='utf-8')
log_handler.setFormatter(log_formatter)

logger = logging.getLogger("NFC_Backend")
logger.setLevel(logging.INFO)
logger.addHandler(log_handler)
logger.addHandler(logging.StreamHandler())

# --- 2. 全域鎖與生命週期 ---
nfc_lock = threading.Lock()
error_mapping_cache = {}

def load_error_mapping():
    global error_mapping_cache
    try:
        with open(ERROR_MAPPING_FILE, 'r', encoding='utf-8') as f:
            error_mapping_cache = json.load(f)
        logger.info("Error mapping loaded.")
    except Exception as e:
        logger.error(f"Failed to load error mapping: {e}")

def kill_zombie_process():
    try:
        subprocess.run(["killall", "-9", "nfc_tool"], capture_output=True)
        logger.info("Zombie processes killed.")
    except: pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(NFC_TOOL_PATH):
        logger.critical(f"nfc_tool NOT FOUND at: {NFC_TOOL_PATH}")
    else:
        logger.info(f"Using nfc_tool at: {NFC_TOOL_PATH}")

    kill_zombie_process()
    load_error_mapping()
    yield
    logger.info("Shutdown.")

app = FastAPI(lifespan=lifespan, title="NFC Production API", version="2.6")

# --- 3. Models ---
class WriteRequest(BaseModel):
    data: str
    is_uri: bool = False

class VerifyRequest(BaseModel):
    expect_data: str

# --- 4. Core Logic ---
def run_nfc_command(args: list) -> dict:
    cmd = [NFC_TOOL_PATH] + args

    if not nfc_lock.acquire(blocking=False):
        return {"status": "FAIL", "error": "BUSY", "ui": error_mapping_cache.get("BUSY")}

    try:
        logger.info(f"EXEC: {' '.join(cmd)}")
        start_time = time.time()

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=NFC_TIMEOUT_SEC)

        duration = time.time() - start_time
        raw_stdout = result.stdout.strip()
        logger.info(f"DONE ({duration:.2f}s). Output Len: {len(raw_stdout)}")

        match = re.search(r'__NFC_JSON_START__(\{.*?\})__NFC_JSON_END__', raw_stdout)

        if match:
            parsed = json.loads(match.group(1))
            err = parsed.get("error", "NONE")
            if err in error_mapping_cache:
                parsed["ui"] = error_mapping_cache[err]

            logger.log(logging.INFO if parsed["status"]=="PASS" else logging.WARNING, f"Result: {parsed}")
            return parsed
        else:
            logger.error(f"Format Err. STDOUT: {raw_stdout} | STDERR: {result.stderr}")
            return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": "Output format error"}

    except subprocess.TimeoutExpired:
        logger.error("TIMEOUT")
        kill_zombie_process()
        resp = {"status": "FAIL", "error": "TIMEOUT"}
        if "TIMEOUT" in error_mapping_cache: resp["ui"] = error_mapping_cache["TIMEOUT"]
        return resp

    except Exception as e:
        logger.exception(f"Exception: {e}")
        return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": str(e)}

    finally:
        nfc_lock.release()

# --- 5. Routes ---
@app.post("/api/nfc/read")
async def read_nfc(): return run_nfc_command(["read"])

@app.post("/api/nfc/write")
async def write_nfc(req: WriteRequest):
    return run_nfc_command(["write_uri" if req.is_uri else "write", req.data])

@app.post("/api/nfc/verify")
async def verify_nfc(req: VerifyRequest):
    return run_nfc_command(["verify", req.expect_data])

@app.post("/api/system/reset")
async def system_reset():
    kill_zombie_process()
    if nfc_lock.locked(): nfc_lock.release()
    return {"status": "OK"}
