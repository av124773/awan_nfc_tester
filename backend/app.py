import os
import json
import logging
import subprocess
import threading
import time
import re
import csv
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler
from contextlib import asynccontextmanager
from typing import Optional, Set

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles # [新增] 靜態檔案支援
from pydantic import BaseModel

# --- 配置區 ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 設定前端目錄位置 (相對於 backend/ 的上一層 frontend/)
FRONTEND_DIR = os.path.join(BASE_DIR, "../frontend")
NFC_TOOL_PATH = os.getenv("NFC_TOOL_PATH", os.path.join(BASE_DIR, "../nfc_tool"))

LOG_DIR = os.path.join(BASE_DIR, "logs")
DATA_DIR = os.path.join(BASE_DIR, "data")
ERROR_MAPPING_FILE = os.path.join(BASE_DIR, "error_mapping.json")
NFC_TIMEOUT_SEC = 12

# --- 1. 日誌與目錄初始化 ---
for d in [LOG_DIR, DATA_DIR]:
    if not os.path.exists(d):
        os.makedirs(d)

log_formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s')
log_handler = TimedRotatingFileHandler(f"{LOG_DIR}/app.log", when="midnight", interval=1, backupCount=7, encoding='utf-8')
log_handler.setFormatter(log_formatter)
logger = logging.getLogger("NFC_Backend")
logger.setLevel(logging.INFO)
logger.addHandler(log_handler)
logger.addHandler(logging.StreamHandler())

# --- 2. 全域鎖與輔助函式 ---
nfc_lock = threading.Lock()
csv_lock = threading.Lock()
error_mapping_cache = {}

def load_error_mapping():
    global error_mapping_cache
    try:
        if os.path.exists(ERROR_MAPPING_FILE):
            with open(ERROR_MAPPING_FILE, 'r', encoding='utf-8') as f:
                error_mapping_cache = json.load(f)
            logger.info("Error mapping loaded.")
        else:
            logger.warning("error_mapping.json not found.")
    except Exception as e:
        logger.error(f"Failed to load error mapping: {e}")

def kill_zombie_process():
    try:
        subprocess.run(["killall", "-9", "nfc_tool"], capture_output=True)
    except: pass

# --- 3. 業務邏輯層 ---
class SessionManager:
    def __init__(self):
        self.active: bool = False
        self.session_id: str = ""
        self.work_order: str = ""
        self.operator: str = ""
        self.scanned_barcodes: Set[str] = set()
        self.csv_filename: str = ""

    def start_session(self, work_order: str, operator: str) -> str:
        self.active = True
        self.work_order = work_order
        self.operator = operator
        self.scanned_barcodes.clear()
        
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        self.session_id = f"{work_order}_{timestamp}"
        
        self.csv_filename = os.path.join(DATA_DIR, f"{self.session_id}.csv")
        self._init_csv()
        
        logger.info(f"Session Started: {self.session_id}")
        return self.session_id

    def end_session(self):
        logger.info(f"Session Ended: {self.session_id}")
        self.active = False
        self.scanned_barcodes.clear()

    def _init_csv(self):
        header = ["Timestamp", "SessionID", "WorkOrder", "Operator", "Barcode", 
                  "UID", "Action", "Status", "Message", "RawData"]
        with csv_lock:
            try:
                with open(self.csv_filename, 'w', newline='', encoding='utf-8-sig') as f:
                    writer = csv.writer(f)
                    writer.writerow(header)
            except Exception as e:
                logger.error(f"Failed to init CSV: {e}")

    def log_result(self, barcode: str, action: str, result: dict):
        if not self.active and not self.csv_filename: return

        # 只要有執行測試（無論 Pass/Fail）都寫入快取，防止重複作業
        if barcode:
            self.scanned_barcodes.add(barcode)

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        status = result.get("status", "FAIL")
        uid = result.get("uid", "")
        msg = result.get("ui", {}).get("message", result.get("error", "UNKNOWN"))
        raw_data = json.dumps(result, ensure_ascii=False)

        if self.active: 
            row = [timestamp, self.session_id, self.work_order, self.operator, 
                   barcode, uid, action, status, msg, raw_data]
            with csv_lock:
                try:
                    with open(self.csv_filename, 'a', newline='', encoding='utf-8-sig') as f:
                        writer = csv.writer(f)
                        writer.writerow(row)
                        f.flush()
                except Exception as e:
                    logger.error(f"CSV Write Error: {e}")

session_mgr = SessionManager()

# --- 4. Models ---
class DevWriteRequest(BaseModel):
    data: str
    is_uri: bool = False

class DevVerifyRequest(BaseModel):
    expect_data: str

class SessionStartRequest(BaseModel):
    work_order: str
    operator: str

class CheckBarcodeRequest(BaseModel):
    session_id: str
    barcode: str

class ProdWriteRequest(BaseModel):
    session_id: str
    barcode: str
    data: str
    allow_duplicate: bool = False

class ProdReadRequest(BaseModel):
    session_id: str
    barcode: str
    expected_data: str

# --- 5. Driver Layer ---
def _driver_execute_nfc_tool(args: list) -> dict:
    cmd = [NFC_TOOL_PATH] + args
    if not nfc_lock.acquire(blocking=False):
        return {"status": "FAIL", "error": "BUSY", "ui": error_mapping_cache.get("BUSY")}
    try:
        logger.info(f"EXEC: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=NFC_TIMEOUT_SEC)
        match = re.search(r'__NFC_JSON_START__(\{.*?\})__NFC_JSON_END__', result.stdout.strip())
        if match:
            parsed = json.loads(match.group(1))
            err = parsed.get("error", "NONE")
            if err in error_mapping_cache: parsed["ui"] = error_mapping_cache[err]
            return parsed
        else:
            return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": "Output format error"}
    except subprocess.TimeoutExpired:
        kill_zombie_process()
        resp = {"status": "FAIL", "error": "TIMEOUT"}
        if "TIMEOUT" in error_mapping_cache: resp["ui"] = error_mapping_cache["TIMEOUT"]
        return resp
    except Exception as e:
        return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": str(e)}
    finally:
        nfc_lock.release()

# --- 6. Lifecycle ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(NFC_TOOL_PATH):
        logger.critical(f"nfc_tool NOT FOUND at: {NFC_TOOL_PATH}")
    
    # 檢查前端目錄
    if not os.path.exists(FRONTEND_DIR):
        logger.warning(f"Frontend directory NOT FOUND at: {FRONTEND_DIR}")
    else:
        logger.info(f"Serving frontend from: {FRONTEND_DIR}")

    kill_zombie_process()
    load_error_mapping()
    yield
    logger.info("Shutdown.")

app = FastAPI(lifespan=lifespan, title="NFC Production API", version="3.3")

# --- 7. API Routes ---

@app.post("/api/session/start")
async def start_session(req: SessionStartRequest):
    if session_mgr.active:
        return {"status": "FAIL", "error": "SESSION_ACTIVE", "message": "已有進行中的 Session"}
    sid = session_mgr.start_session(req.work_order, req.operator)
    return {"status": "OK", "session_id": sid}

@app.post("/api/session/end")
async def end_session():
    session_mgr.end_session()
    return {"status": "OK"}

@app.post("/api/session/check_barcode")
async def check_barcode(req: CheckBarcodeRequest):
    if not session_mgr.active or req.session_id != session_mgr.session_id:
        return {"status": "FAIL", "error": "INVALID_SESSION", "message": "Session 無效"}
    
    if req.barcode in session_mgr.scanned_barcodes:
        return {
            "status": "FAIL", 
            "error": "DUPLICATE_SCAN", 
            "message": f"條碼 {req.barcode} 已測試過"
        }
    return {"status": "OK", "message": "Barcode Valid"}

@app.get("/api/session/download_csv")
async def download_csv(session_id: Optional[str] = None):
    target_file = ""
    if session_mgr.csv_filename and (session_id is None or session_id == session_mgr.session_id):
        target_file = session_mgr.csv_filename
    elif session_id:
        target_file = os.path.join(DATA_DIR, f"{session_id}.csv")
    
    if target_file and os.path.exists(target_file):
        filename = os.path.basename(target_file)
        return FileResponse(path=target_file, filename=filename, media_type='text/csv')
    raise HTTPException(status_code=404, detail="CSV file not found")

@app.post("/api/prod/write")
async def prod_write(req: ProdWriteRequest):
    if not session_mgr.active or req.session_id != session_mgr.session_id:
        raise HTTPException(status_code=400, detail="Invalid Session")

    if req.barcode in session_mgr.scanned_barcodes and not req.allow_duplicate:
        return {
            "status": "FAIL", 
            "error": "DUPLICATE_SCAN", 
            "ui": {"title": "重複條碼", "message": f"條碼 {req.barcode} 已測試過，確認重測？", "type": "warning"}
        }

    result = _driver_execute_nfc_tool(["write", req.data])
    session_mgr.log_result(req.barcode, "WRITE", result)
    return result

@app.post("/api/prod/read")
async def prod_read(req: ProdReadRequest):
    if not session_mgr.active or req.session_id != session_mgr.session_id:
        raise HTTPException(status_code=400, detail="Invalid Session")
    
    result = _driver_execute_nfc_tool(["verify", req.expected_data])
    session_mgr.log_result(req.barcode, "READ", result)
    return result

# Dev Routes
@app.post("/api/dev/nfc/read")
async def dev_read_nfc(): return _driver_execute_nfc_tool(["read"])

@app.post("/api/dev/nfc/write")
async def dev_write_nfc(req: DevWriteRequest): return _driver_execute_nfc_tool(["write_uri" if req.is_uri else "write", req.data])

@app.post("/api/dev/nfc/verify")
async def dev_verify_nfc(req: DevVerifyRequest): return _driver_execute_nfc_tool(["verify", req.expect_data])

@app.post("/api/system/reset")
async def system_reset():
    kill_zombie_process()
    if nfc_lock.locked(): nfc_lock.release()
    return {"status": "OK"}

# --- 8. Static Files Mount (必須放在最後) ---
# 將 "/" 掛載到 frontend 目錄，並啟用 html=True (自動尋找 index.html)
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
