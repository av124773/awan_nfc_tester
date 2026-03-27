import os
import json
import logging
import subprocess
import threading
import csv
import re
import time
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler
from contextlib import asynccontextmanager
from typing import Optional, Set, Dict, Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --- 配置區 ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "../frontend")
NFC_TOOL_PATH = os.getenv("NFC_TOOL_PATH", os.path.join(BASE_DIR, "../nfc_tool"))
STATION_CONFIG_FILE = os.path.join(BASE_DIR, "station_config.json")
LOG_DIR = os.path.join(BASE_DIR, "logs")
DATA_DIR = os.path.join(BASE_DIR, "data")
ERROR_MAPPING_FILE = os.path.join(BASE_DIR, "error_mapping.json")
NFC_TIMEOUT_SEC = 12

# --- 1. 初始化 ---
for d in [LOG_DIR, DATA_DIR]:
    if not os.path.exists(d): os.makedirs(d)

logger = logging.getLogger("NFC_Backend")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = TimedRotatingFileHandler(f"{LOG_DIR}/app.log", when="midnight", interval=1, backupCount=7, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s | %(levelname)s | %(message)s'))
    logger.addHandler(handler)
    logger.addHandler(logging.StreamHandler())

nfc_lock = threading.Lock()
csv_lock = threading.Lock()
error_mapping_cache = {}
station_config_cache = {} 

def load_configs():
    global error_mapping_cache, station_config_cache
    try:
        if os.path.exists(ERROR_MAPPING_FILE):
            with open(ERROR_MAPPING_FILE, 'r', encoding='utf-8') as f:
                error_mapping_cache = json.load(f)
        
        if os.path.exists(STATION_CONFIG_FILE):
            with open(STATION_CONFIG_FILE, 'r', encoding='utf-8') as f:
                station_config_cache = json.load(f)
                logger.info("Station config loaded.")
        else:
            logger.warning("Station config file not found!")
            station_config_cache = {"csv_fields": []}
    except Exception as e:
        logger.error(f"Config load error: {e}")

def kill_zombie_process():
    try:
        subprocess.run(["killall", "-9", "nfc_tool"], capture_output=True)
    except: pass

# --- 2. Session Manager ---
class SessionManager:
    def __init__(self):
        self.active: bool = False
        self.session_id: str = ""
        self.session_data: Dict[str, Any] = {} 
        self.scanned_barcodes: Set[str] = set()
        self.csv_filename: str = ""

    def start_session(self, data: Dict[str, Any]) -> str:
        self.active = True
        self.session_data = data
        self.scanned_barcodes.clear()
        
        # 嘗試使用 work_order 作為檔名一部分 (若有的話)
        wo = str(data.get("work_order", "SESSION"))
        wo = re.sub(r'[\\/*?:"<>|]', "", wo)
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        self.session_id = f"{wo}_{timestamp}"
        
        self.csv_filename = os.path.join(DATA_DIR, f"{self.session_id}.csv")
        self._init_csv()
        
        logger.info(f"Session Started: {self.session_id} | Data: {data}")
        return self.session_id

    def end_session(self):
        logger.info(f"Session Ended: {self.session_id}")
        self.active = False
        self.scanned_barcodes.clear()
    
    def get_status(self) -> dict:
        return {
            "active": self.active,
            "session_id": self.session_id,
            "session_data": self.session_data,
            "scanned_count": len(self.scanned_barcodes)
        }

    def _init_csv(self):
        # [動態 Header] 系統固定欄位 + Config 定義欄位 + RawData
        system_fields = ["Timestamp", "SessionID", "Barcode", "UID", "Action", "Status", "Message"]
        dynamic_fields = [f["key"] for f in station_config_cache.get("csv_fields", [])]
        header = system_fields + dynamic_fields + ["RawData"]
        
        with csv_lock:
            try:
                with open(self.csv_filename, 'w', newline='', encoding='utf-8-sig') as f:
                    writer = csv.writer(f)
                    writer.writerow(header)
            except Exception as e:
                logger.error(f"Failed to init CSV: {e}")

    def log_result(self, barcode: str, action: str, result: dict):
        if not self.active or not self.csv_filename: return

        if barcode: self.scanned_barcodes.add(barcode)

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        status = result.get("status", "FAIL")
        uid = result.get("uid", "")
        # 優先取 UI Message
        msg = result.get("ui", {}).get("message", result.get("error", "UNKNOWN"))
        if not msg and "msg" in result: msg = result["msg"]
        
        raw_data = json.dumps(result, ensure_ascii=False)

        # [動態資料寫入]
        # 1. 系統資料
        row = [timestamp, self.session_id, barcode, uid, action, status, msg]
        
        # 2. Config 定義資料 (嚴格對應 Key)
        dynamic_keys = [f["key"] for f in station_config_cache.get("csv_fields", [])]
        for key in dynamic_keys:
            # 確保轉為字串
            val = str(self.session_data.get(key, ""))
            row.append(val)
            
        # 3. Raw Data
        row.append(raw_data)

        with csv_lock:
            try:
                with open(self.csv_filename, 'a', newline='', encoding='utf-8-sig') as f:
                    writer = csv.writer(f)
                    writer.writerow(row)
            except Exception as e:
                logger.error(f"CSV Write Error: {e}")

session_mgr = SessionManager()

# --- 3. Models (僅保留操作類，SessionStart 改用 Dict) ---
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

# --- 4. Driver Layer (保持不變) ---
def _driver_execute_nfc_tool(args: list) -> dict:
    cmd = [NFC_TOOL_PATH] + args
    if not nfc_lock.acquire(blocking=False):
        return {"status": "FAIL", "error": "BUSY", "ui": error_mapping_cache.get("BUSY")}
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=NFC_TIMEOUT_SEC)
        match = re.search(r'__NFC_JSON_START__(\{.*?\})__NFC_JSON_END__', result.stdout.strip())
        if match:
            parsed_data = json.loads(match.group(1))
            
            if parsed_data.get("status") == "RETRY":
                #time.sleep(0.3)
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=NFC_TIMEOUT_SEC)
                match = re.search(r'__NFC_JSON_START__(\{.*?\})__NFC_JSON_END__', result.stdout.strip())
                if match:
                    parsed_data = json.loads(match.group(1))
            if parsed_data.get("status") == "FAIL":
                parsed_data["ui"] = error_mapping_cache.get(parsed_data.get("error"), parsed_data.get("msg"))
            return parsed_data
        else:
            return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": f"Raw Output: {result.stdout[:50]}"}
    except subprocess.TimeoutExpired:
        kill_zombie_process()
        resp = {"status": "FAIL", "error": "TIMEOUT"}
        if "TIMEOUT" in error_mapping_cache: resp["ui"] = error_mapping_cache["TIMEOUT"]
        return resp
    except Exception as e:
        return {"status": "FAIL", "error": "SYSTEM_ERROR", "msg": str(e)}
    finally:
        nfc_lock.release()

# --- 5. Lifecycle ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    load_configs()
    kill_zombie_process()
    yield
    logger.info("Shutdown.")

app = FastAPI(lifespan=lifespan)

# --- 6. API Routes ---

@app.get("/api/config")
async def get_config():
    return station_config_cache

# [修改] Start Session 接收任意 JSON
@app.post("/api/session/start")
async def start_session(request: Request):
    body = await request.json()
    
    if session_mgr.active:
        return {"status": "FAIL", "error": "SESSION_ACTIVE", "message": "已有進行中的工單"}
    
    sid = session_mgr.start_session(body)
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
        return {"status": "FAIL", "error": "DUPLICATE_SCAN", "message": "重複條碼"}
    return {"status": "OK"}

@app.get("/api/session/download_csv")
async def download_csv(session_id: Optional[str] = None):
    target_file = ""
    if session_mgr.csv_filename and (session_id is None or session_id == session_mgr.session_id):
        target_file = session_mgr.csv_filename
    elif session_id:
        safe_id = os.path.basename(session_id)
        target_file = os.path.join(DATA_DIR, f"{safe_id}.csv")
    
    if target_file and os.path.exists(target_file):
        return FileResponse(path=target_file, filename=os.path.basename(target_file), media_type='text/csv')
    raise HTTPException(status_code=404, detail="CSV file not found")
    
@app.get("/api/session/current")
async def get_current_session():
    return session_mgr.get_status()

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
    session_mgr.log_result(req.barcode, "VERIFY", result)
    return result

if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
