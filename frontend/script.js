/**
 * NFC Production Tester - Frontend Logic
 * Version: 3.2
 */

// --- 1. 全域狀態 (State Management) ---
const state = {
    sessionId: null,
    workOrder: null,
    operator: null,
    currentBarcode: null,
    scannedCount: 0,
    targetCount: 0,
    isProcessing: false // 防止重複點擊
};

// --- 2. DOM 元素選取 ---
const views = {
    setup: document.getElementById('view-setup'),
    test: document.getElementById('view-test'),
    summary: document.getElementById('view-summary')
};

const inputs = {
    workOrder: document.getElementById('input-work-order'),
    partNumber: document.getElementById('input-part-number'), // 新增
    operator: document.getElementById('input-operator'),
    targetCount: document.getElementById('input-target-count'), // 新增
    barcode: document.getElementById('input-barcode')
};

const displays = {
    sessionId: document.getElementById('display-session-id'),
    count: document.getElementById('display-count'),
    status: document.getElementById('status-display')
};

const buttons = {
    start: document.getElementById('btn-start-session'),
    write: document.getElementById('btn-write'),
    read: document.getElementById('btn-read'),
    end: document.getElementById('btn-end-session'),
    download: document.getElementById('btn-download-csv'),
    newSession: document.getElementById('btn-new-session'),
    backSetup: document.getElementById('btn-back-setup'), // [新增]
    // Modal Buttons
    modalConfirm: document.getElementById('btn-modal-confirm'),
    modalCancel: document.getElementById('btn-modal-cancel')
};

const modals = {
    warning: document.getElementById('modal-warning'),
    loading: document.getElementById('modal-loading'),
    title: document.getElementById('modal-title'),
    message: document.getElementById('modal-message')
};

// --- 3. 輔助函式 (Helpers) ---

// 切換視圖
function switchView(viewName) {
    Object.values(views).forEach(el => el.classList.remove('active'));
    views[viewName].classList.add('active');
}

// 顯示狀態訊息 (綠/紅/黃/灰)
function setStatus(type, text) {
    displays.status.className = ''; // reset
    displays.status.textContent = text;
    
    switch (type) {
        case 'IDLE':
            displays.status.classList.add('status-idle');
            break;
        case 'PASS':
            displays.status.classList.add('status-ok');
            break;
        case 'FAIL':
            displays.status.classList.add('status-fail');
            break;
        case 'WARN':
            displays.status.classList.add('status-warn');
            break;
    }
}

// 鎖定/解鎖 UI (Loading 狀態)
function setUiBusy(busy, message = "處理中...") {
    state.isProcessing = busy;
    if (busy) {
        modals.loading.querySelector('h3').textContent = message;
        modals.loading.style.display = 'block';
    } else {
        modals.loading.style.display = 'none';
        // 聚焦回 Barcode 輸入框，方便連續作業
        if (views.test.classList.contains('active')) {
            inputs.barcode.focus();
        }
    }
}

// 播放音效 (可選)
function playSound(type) {
    // 這裡可以預留 beep 聲邏輯，例如 new Audio('ok.mp3').play();
}

// 通用 API 呼叫
async function apiCall(endpoint, method = 'POST', body = null) {
    try {
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(endpoint, options);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error("API Error:", error);
        return { status: "FAIL", error: "NETWORK_ERROR", msg: error.message };
    }
}

// --- 4. 核心邏輯 (Core Logic) ---

// A. 開始 Session
buttons.start.addEventListener('click', async () => {
    const workOrder = inputs.workOrder.value.trim();
    const operator = inputs.operator.value.trim();
    const partNumber = inputs.partNumber.value.trim();
    const targetCountVal = parseInt(inputs.targetCount.value.trim()) || 0;

    if (!workOrder || !operator) {
        alert("請輸入工單編號與操作員 ID");
        return;
    }

    // 定義啟動邏輯，方便重試
    const doStart = async () => {
        setUiBusy(true, "建立工單中...");
        const res = await apiCall('/api/session/start', 'POST', {
            work_order: workOrder,
            operator: operator
        });
        setUiBusy(false);

        if (res.status === 'OK') {
            // 設定前端狀態
            state.sessionId = res.session_id;
            state.workOrder = workOrder;
            state.operator = operator;
            state.scannedCount = 0; // 新 Session 從 0 開始
            state.targetCount = targetCountVal;

            // 更新 UI
            displays.sessionId.textContent = `Session: ${state.sessionId}`;
            updateCountDisplay();
            
            // 重置測試區
            inputs.barcode.value = '';
            setStatus('IDLE', '請掃描條碼開始測試');
            toggleActionButtons(false);

            switchView('test');
            inputs.barcode.focus();
        } else if (res.error === 'SESSION_ACTIVE') {
            // [關鍵修正]：如果後端說有 Session 在跑，詢問是否強制結束並重開
            if (confirm("偵測到系統已有進行中的工單 Session！\n\n按「確定」：強制結束舊工單，並使用當前資訊開始新工單。\n按「取消」：恢復顯示舊工單畫面。")) {
                // 強制結束舊的
                await apiCall('/api/session/end', 'POST', {});
                // 遞迴重試 (這會再次呼叫 start，這次應該就會成功了)
                await doStart();
            } else {
                // 如果用戶選擇取消，則嘗試恢復舊 Session 畫面
                checkAndResumeSession(); 
            }
        } else {
            alert(`無法開始 Session: ${res.message || res.error}`);
        }
    };

    await doStart();
});

function updateCountDisplay() {
    if (state.targetCount > 0) {
        displays.count.textContent = `已測試: ${state.scannedCount} / ${state.targetCount}`;
    } else {
        displays.count.textContent = `已測試: ${state.scannedCount}`;
    }
}

// B. 監聽 Barcode 輸入 (掃碼槍邏輯)
// 掃碼槍通常會快速輸入字元並以 Enter 結束
inputs.barcode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault(); // 防止 Form submit
        handleBarcodeScan();
    }
});

async function handleBarcodeScan() {
    const code = inputs.barcode.value.trim();
    if (!code) return;

    state.currentBarcode = code;
    setStatus('IDLE', '檢查中...');
    
    // 呼叫後端檢查重複
    const res = await apiCall('/api/session/check_barcode', 'POST', {
        session_id: state.sessionId,
        barcode: code
    });

    if (res.status === 'OK') {
        setStatus('IDLE', `條碼: ${code} (準備就緒)`);
        toggleActionButtons(true); // 解鎖按鈕
    } else if (res.error === 'DUPLICATE_SCAN') {
        // 重複但允許操作，顯示黃色警告
        setStatus('WARN', `警告: 條碼 ${code} 已測試過！`);
        toggleActionButtons(true); // 仍然解鎖按鈕，允許重測
    } else {
        setStatus('FAIL', `錯誤: ${res.message || '無法驗證條碼'}`);
        toggleActionButtons(false);
    }
}

function toggleActionButtons(enable) {
    buttons.write.disabled = !enable;
    buttons.read.disabled = !enable;
    if (enable) {
        // 這裡可以依需求決定是否自動 focus 到 write 按鈕
        // buttons.write.focus(); 
    }
}

// const tagData = "IG2 AWAN Test OK" 

// C. 執行測試 (Write / Read->Verify)
async function executeTest(action, allowDuplicate = false) {
    if (!state.currentBarcode) return;

    // 定義預期資料
    const tagData = "IG2 AWAN Test OK"; 
    const actionText = action === 'write' ? "寫入初始化" : "讀取驗證";
    
    setUiBusy(true, `正在${actionText}...`);
    
    const endpoint = '/api/prod/' + (action === 'write' ? 'write' : 'read');
    
    const payload = {
        session_id: state.sessionId,
        barcode: state.currentBarcode,
        allow_duplicate: allowDuplicate
    };

    if (action === 'write') {
        payload.data = tagData;
    } else {
        // [修正] Read 模式下發送 expected_data 給後端進行 verify
        payload.expected_data = tagData;
    }

    const res = await apiCall(endpoint, 'POST', payload);
    setUiBusy(false);

    // 1. 處理重複掃碼警告
    if (res.error === 'DUPLICATE_SCAN' && res.ui) {
        showWarningModal(res.ui, () => executeTest(action, true));
        return;
    }

    // 2. 處理驗證失敗 (VERIFY_FAIL)
    if (res.status === 'FAIL' && res.error === 'VERIFY_FAIL') {
        // 解析 nfc_tool 回傳的 "Mismatch: Exp[A] Got[B]"
        // Regex 說明: 尋找 Exp[...] 和 Got[...] 內的內容
        const match = (res.msg || "").match(/Exp\[(.*?)\] Got\[(.*?)\]/);
        
        let errorHtml = '';
        if (match) {
            const expVal = match[1];
            const actVal = match[2];
            errorHtml = `
                <div><strong>驗證失敗 (內容不符)</strong></div>
                <div class="error-container">
                    <div class="error-line"><span class="label">內容應為:</span> <span class="val-exp">${expVal}</span></div>
                    <div class="error-line"><span class="label">實際讀取:</span> <span class="val-act">${actVal}</span></div>
                </div>
            `;
        } else {
            // 解析失敗或格式不同，顯示原始訊息
            errorHtml = `<div><strong>驗證失敗</strong></div><div style="font-size:0.8rem">${res.msg}</div>`;
        }

        displays.status.innerHTML = errorHtml;
        displays.status.className = 'status-fail'; // 紅色框
        playSound('fail');
        inputs.barcode.select();
        return;
    }

    // 3. 處理其他失敗
    if (res.status !== 'PASS') {
        const errMsg = (res.ui && res.ui.message) ? res.ui.message : (res.message || res.error);
        setStatus('FAIL', `FAIL: ${errMsg}`);
        playSound('fail');
        inputs.barcode.select();
        return;
    }

    // 4. 成功 (PASS)
    // 這裡我們信任後端 verify 通過，所以顯示預期值即可，或者顯示後端回傳的 uid
    const displayInfo = `PASS | UID: ${res.uid || 'OK'} | 內容: ${tagData}`;
    setStatus('PASS', displayInfo);
    
    state.scannedCount++;
    updateCountDisplay();
    playSound('pass');
    inputs.barcode.focus();
    inputs.barcode.select();
}

// --- 3. [新增] 返回設定按鈕邏輯 ---
if (buttons.backSetup) {
    buttons.backSetup.addEventListener('click', async () => {
        // 跳出確認，避免誤觸
        if (!confirm("確定要中斷目前測試並返回設定頁面嗎？\n(目前的 CSV 記錄將會封存)")) return;
        
        setUiBusy(true, "正在結束 Session...");
        // 呼叫後端結束 Session
        await apiCall('/api/session/end', 'POST', {});
        setUiBusy(false);
        
        // 清空前端狀態
        state.sessionId = null;
        state.currentBarcode = null;
        state.scannedCount = 0;
        
        // 切換回首頁
        switchView('setup');
    });
}

// 綁定測試按鈕事件
buttons.write.addEventListener('click', () => executeTest('write'));
buttons.read.addEventListener('click', () => executeTest('read'));

// D. Modal 處理
function showWarningModal(uiContent, onConfirm) {
    modals.title.textContent = uiContent.title || '警告';
    modals.message.textContent = uiContent.message || '確認執行？';
    modals.warning.style.display = 'block';

    // 解除舊的事件綁定 (避免重複觸發)
    const newConfirm = buttons.modalConfirm.cloneNode(true);
    const newCancel = buttons.modalCancel.cloneNode(true);
    buttons.modalConfirm.parentNode.replaceChild(newConfirm, buttons.modalConfirm);
    buttons.modalCancel.parentNode.replaceChild(newCancel, buttons.modalCancel);
    
    // 更新引用
    buttons.modalConfirm = newConfirm;
    buttons.modalCancel = newCancel;

    // 綁定新事件
    buttons.modalConfirm.addEventListener('click', () => {
        modals.warning.style.display = 'none';
        onConfirm();
    });

    buttons.modalCancel.addEventListener('click', () => {
        modals.warning.style.display = 'none';
        setStatus('IDLE', '操作已取消');
        inputs.barcode.focus();
    });
}

async function checkAndResumeSession() {
    try {
        const res = await apiCall('/api/session/current', 'GET');
        
        if (res.active) {
            console.log("Resuming active session:", res);
            
            // 恢復 State
            state.sessionId = res.session_id;
            state.workOrder = res.work_order;
            state.operator = res.operator;
            state.scannedCount = res.scanned_count;
            // 注意：targetCount 與 partNumber 後端沒有存(因為只是 setup 用)，
            // 恢復時這些欄位會是空的或預設值，這在「恢復模式」下通常可接受，
            // 若需嚴格一致，後端 SessionManager 也需儲存這些欄位。
            
            // 恢復 UI
            inputs.workOrder.value = state.workOrder;
            inputs.operator.value = state.operator;
            
            displays.sessionId.textContent = `Session: ${state.sessionId}`;
            updateCountDisplay(); // 這裡會用恢復的 scannedCount 更新顯示
            
            setStatus('IDLE', '已恢復連線，請繼續掃描');
            toggleActionButtons(false);
            
            // 直接切換到測試畫面
            switchView('test');
            inputs.barcode.focus();
        }
    } catch (e) {
        console.error("Failed to check session status", e);
    }
}

// E. 結束 Session
buttons.end.addEventListener('click', async () => {
    if (!confirm("確定要結束目前的生產批次嗎？")) return;

    await apiCall('/api/session/end', 'POST', {});
    
    // 不論 API 成功與否，前端都切換到結束畫面
    switchView('summary');
});

// F. 下載 CSV
buttons.download.addEventListener('click', () => {
    // 直接觸發瀏覽器下載
    // 注意：後端 API 是 GET /api/session/download_csv?session_id=...
    // 如果不傳 ID，後端預設抓當前/最後一個，但為了保險起見，我們帶上 ID
    const downloadUrl = `/api/session/download_csv?session_id=${state.sessionId}`;
    window.location.href = downloadUrl;
});

// G. 返回首頁 (新 Session)
buttons.newSession.addEventListener('click', () => {
    // 重置狀態
    state.sessionId = null;
    state.currentBarcode = null;
    state.scannedCount = 0;
    
    // 清空輸入框
    inputs.workOrder.value = '';
    inputs.partNumber.value = '';
    inputs.targetCount.value = '';
    // operator 保留，方便同一人繼續操作
    
    switchView('setup');
});

// --- 初始化 ---
// 確保頁面載入時游標在第一個輸入框
window.onload = () => {
    checkAndResumeSession();
    inputs.workOrder.focus();
};
