/**
 * NFC Production Tester - Frontend Logic (Refactored v8)
 * Architecture: Singleton State Machine
 * Features: Full Parity with v3.2 Original Code
 */

const App = {
    // 定義系統狀態
    States: {
        IDLE: 'IDLE',           // 初始設定頁面
        READY: 'READY',         // 已進入工單，等待掃碼
        SCANNED: 'SCANNED',     // 條碼已確認，等待操作
        BUSY: 'BUSY',           // API 通訊中 (Loading)
        RESULT: 'RESULT',       // 顯示測試結果
        SUMMARY: 'SUMMARY'      // 工單結束總結
    },

    // 核心資料狀態
    state: {
        current: 'IDLE',        // 當前狀態
        sessionId: null,
        config: {               // 工單設定資訊
            workOrder: '',
            partNumber: '',
            operator: '',
            targetCount: 0
        },
        scannedCount: 0,
        currentBarcode: null,
        isProcessing: false
    },

    // --- 1. 初始化與 DOM 快取 ---
    init() {
        this.cacheDOM();
        this.bindEvents();
        this.checkAndResumeSession(); // 網頁載入時嘗試恢復
    },

    cacheDOM() {
        const el = (id) => document.getElementById(id);
        this.dom = {
            // 視圖容器
            views: {
                setup: el('view-setup'),
                test: el('view-test'),
                summary: el('view-summary')
            },
            // 輸入欄位 (包含所有原始欄位)
            inputs: {
                wo: el('input-work-order'),
                pn: el('input-part-number'),
                op: el('input-operator'),
                target: el('input-target-count'),
                barcode: el('input-barcode')
            },
            // 顯示資訊
            displays: {
                sessionId: el('display-session-id'),
                count: el('display-count'),
                status: el('status-display')
            },
            // 操作按鈕
            buttons: {
                start: el('btn-start-session'),
                write: el('btn-write'),
                read: el('btn-read'),
                end: el('btn-end-session'),
                backSetup: el('btn-back-setup'), // 返回設定
                download: el('btn-download-csv'),
                newSession: el('btn-new-session'),
                // Modal 按鈕
                modalConfirm: el('btn-modal-confirm'),
                modalCancel: el('btn-modal-cancel')
            },
            // 模態視窗
            modals: {
                warning: el('modal-warning'),
                loading: el('modal-loading'),
                title: el('modal-title'),
                message: el('modal-message')
            },
            // HTML 模板
            templates: {
                pass: el('tmpl-status-pass'),
                failVerify: el('tmpl-error-verify'),
                failGeneric: el('tmpl-error-generic')
            }
        };
    },

    bindEvents() {
        // Setup 頁面
        this.dom.buttons.start.onclick = () => this.handleStartSession();

        // Test 頁面 - 條碼掃描
        this.dom.inputs.barcode.onkeypress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleBarcodeScan(e.target.value.trim());
            }
        };

        // Test 頁面 - 測試操作
        this.dom.buttons.write.onclick = () => this.executeTest('write');
        this.dom.buttons.read.onclick = () => this.executeTest('read');
        
        // Session 管理
        this.dom.buttons.end.onclick = () => this.handleEndSession();
        this.dom.buttons.backSetup.onclick = () => this.handleBackToSetup();
        
        // Summary 頁面
        this.dom.buttons.download.onclick = () => this.downloadCSV();
        this.dom.buttons.newSession.onclick = () => this.resetToHome();
    },

    // --- 2. 視圖與狀態控制 (View Controller) ---
    
    setState(newState) {
        this.state.current = newState;
        this.render();
    },

    render() {
        const { current, sessionId, scannedCount, config } = this.state;

        // 1. 視圖切換
        this.dom.views.setup.classList.toggle('active', current === this.States.IDLE);
        this.dom.views.test.classList.toggle('active', [this.States.READY, this.States.SCANNED, this.States.BUSY, this.States.RESULT].includes(current));
        this.dom.views.summary.classList.toggle('active', current === this.States.SUMMARY);

        // 2. 資訊列更新
        if (this.dom.views.test.classList.contains('active')) {
            this.dom.displays.sessionId.textContent = `Session: ${sessionId || '--'}`;
            const targetText = config.targetCount > 0 ? ` / ${config.targetCount}` : '';
            this.dom.displays.count.textContent = `已測試: ${scannedCount}${targetText}`;
        }

        // 3. 按鈕狀態控制
        // 只有在 SCANNED 或 RESULT 狀態下，且非忙碌時，才允許測試按鈕
        const allowAction = (current === this.States.SCANNED || current === this.States.RESULT) && !this.state.isProcessing;
        this.dom.buttons.write.disabled = !allowAction;
        this.dom.buttons.read.disabled = !allowAction;
        
        // 4. 輸入框鎖定
        this.dom.inputs.barcode.disabled = (current === this.States.BUSY);
    },

    setUiBusy(busy, msg = "處理中...") {
        this.state.isProcessing = busy;
        if (busy) {
            this.dom.modals.loading.querySelector('h3').textContent = msg;
            this.dom.modals.loading.style.display = 'block';
            this.setState(this.States.BUSY);
        } else {
            this.dom.modals.loading.style.display = 'none';
            // 如果從忙碌結束，通常回到上一個狀態，這裡由呼叫者決定 setState
        }
    },

    // --- 3. 核心業務邏輯 (Business Logic) ---

    // [功能] 恢復 Session (Resume)
    async checkAndResumeSession() {
        try {
            const res = await this.apiCall('/api/session/current', 'GET');
            if (res.active) {
                console.log("Resuming session:", res);
                // 恢復狀態
                this.state.sessionId = res.session_id;
                this.state.config.workOrder = res.work_order;
                this.state.config.operator = res.operator;
                this.state.scannedCount = res.scanned_count;
                // 注意：後端通常不存 partNumber/targetCount，這裡維持原始邏輯，僅恢復後端有的數據
                
                // 恢復 UI 數值
                this.dom.inputs.wo.value = res.work_order;
                this.dom.inputs.op.value = res.operator;
                
                this.setState(this.States.READY);
                this.renderStatus('IDLE', '已恢復連線，請繼續掃描');
                this.dom.inputs.barcode.focus();
            } else {
                this.setState(this.States.IDLE);
                this.dom.inputs.wo.focus();
            }
        } catch (e) {
            console.error("Resume failed", e);
            this.setState(this.States.IDLE);
        }
    },

    // [功能] 建立工單 (Start)
    async handleStartSession() {
        const wo = this.dom.inputs.wo.value.trim();
        const pn = this.dom.inputs.pn.value.trim();
        const op = this.dom.inputs.op.value.trim();
        const target = parseInt(this.dom.inputs.target.value.trim()) || 0;

        if (!wo || !op) return alert("請輸入工單編號與操作員 ID");

        // 定義啟動程序 (含遞迴重試邏輯)
        const doStart = async () => {
            this.setUiBusy(true, "建立工單中...");
            const res = await this.apiCall('/api/session/start', 'POST', {
                work_order: wo,
                operator: op,
                // partNumber 雖然後端可能沒存，但若未來擴充可傳
            });
            this.setUiBusy(false);

            if (res.status === 'OK') {
                // 設定狀態
                this.state.sessionId = res.session_id;
                this.state.config = { workOrder: wo, partNumber: pn, operator: op, targetCount: target };
                this.state.scannedCount = 0;
                
                // 清空測試區
                this.dom.inputs.barcode.value = '';
                this.renderStatus('IDLE', '請掃描條碼開始測試');
                
                this.setState(this.States.READY);
                this.dom.inputs.barcode.focus();

            } else if (res.error === 'SESSION_ACTIVE') {
                // [關鍵保留] 處理舊 Session 衝突
                if (confirm("偵測到系統已有進行中的工單！\n\n按「確定」：強制結束舊工單，開始新工單。\n按「取消」：恢復顯示舊工單。")) {
                    await this.apiCall('/api/session/end', 'POST', {});
                    await doStart(); // 遞迴重試
                } else {
                    this.checkAndResumeSession();
                }
            } else {
                alert(`無法開始: ${res.message || res.error}`);
                this.setState(this.States.IDLE);
            }
        };

        await doStart();
    },

    // [功能] 條碼掃描與防呆 (Scan)
    async handleBarcodeScan(barcode) {
        if (!barcode) return;

        this.state.currentBarcode = barcode;
        this.renderStatus('IDLE', '檢查條碼中...');
        
        // 呼叫後端檢查
        const res = await this.apiCall('/api/session/check_barcode', 'POST', {
            session_id: this.state.sessionId,
            barcode: barcode
        });

        if (res.status === 'OK') {
            this.renderStatus('IDLE', `條碼: ${barcode} (準備就緒)`);
            this.setState(this.States.SCANNED);
        } else if (res.error === 'DUPLICATE_SCAN') {
            // 重複但允許操作 (黃燈)
            this.renderStatus('WARN', `警告: 條碼 ${barcode} 已測試過！`);
            this.setState(this.States.SCANNED); // 依然進入 SCANNED 狀態讓按鈕可按
        } else {
            this.renderStatus('FAIL', `錯誤: ${res.message || '無效條碼'}`);
            this.setState(this.States.READY); // 退回 Ready
        }
    },

    // [功能] 執行測試 (Write / Read)
    async executeTest(action, allowDuplicate = false) {
        if (!this.state.currentBarcode) return;

        const tagData = "IG2 AWAN Test OK";
        const endpoint = action === 'write' ? '/api/prod/write' : '/api/prod/read';
        const actionText = action === 'write' ? "寫入初始化" : "讀取驗證";

        this.setUiBusy(true, `正在${actionText}...`);

        const payload = {
            session_id: this.state.sessionId,
            barcode: this.state.currentBarcode,
            allow_duplicate: allowDuplicate
        };
        if (action === 'write') payload.data = tagData;
        else payload.expected_data = tagData;

        const res = await this.apiCall(endpoint, 'POST', payload);
        this.setUiBusy(false);

        // 1. 處理重複掃碼的二次確認 (Modal)
        if (res.error === 'DUPLICATE_SCAN' && res.ui) {
            this.showWarningModal(res.ui, () => this.executeTest(action, true));
            return;
        }

        // 2. 顯示結果 (使用模板)
        this.dom.displays.status.innerHTML = ''; // 清空舊顯示
        this.dom.displays.status.className = ''; // 重置樣式

        if (res.status === 'PASS') {
            // [改進] 寫入/讀取成功都用綠色卡片
            const content = this.renderTemplate('pass', {
                uid: res.uid || 'N/A',
                actual: tagData
            });
            this.dom.displays.status.appendChild(content);
            
            this.state.scannedCount++;
            this.setState(this.States.RESULT); // 狀態設為 Result
            
            // 音效與焦點 (模擬)
            this.dom.inputs.barcode.focus();
            this.dom.inputs.barcode.select();

        } else {
            // 失敗處理
            let content;
            if (res.error === 'VERIFY_FAIL') {
                content = this.renderTemplate('failVerify', {
                    uid: res.uid || 'Unknown',
                    expected: res.expected || '?',
                    actual: res.actual || '?'
                });
            } else {
                content = this.renderTemplate('failGeneric', {
                    msg: res.msg || 'Unknown Error',
                    error: res.error || 'ERR'
                });
            }
            this.dom.displays.status.appendChild(content);
            this.setState(this.States.RESULT);
            this.dom.inputs.barcode.select();
        }
    },

    // [功能] 返回設定 (Back to Setup)
    async handleBackToSetup() {
        if (!confirm("確定要中斷目前測試並返回設定頁面嗎？\n(目前的 CSV 記錄將會封存)")) return;
        
        this.setUiBusy(true, "結束 Session...");
        await this.apiCall('/api/session/end', 'POST', {});
        this.setUiBusy(false);

        this.resetInternalState();
        this.setState(this.States.IDLE);
    },

    // [功能] 結束工單 (End Session)
    async handleEndSession() {
        if (!confirm("確定要結束目前的生產批次嗎？")) return;
        await this.apiCall('/api/session/end', 'POST', {});
        this.setState(this.States.SUMMARY);
    },

    // [功能] 返回首頁 (New Session)
    resetToHome() {
        this.resetInternalState();
        // 清空輸入框
        this.dom.inputs.wo.value = '';
        this.dom.inputs.pn.value = '';
        this.dom.inputs.target.value = '';
        // operator 不清空，方便操作
        this.setState(this.States.IDLE);
    },

    resetInternalState() {
        this.state.sessionId = null;
        this.state.currentBarcode = null;
        this.state.scannedCount = 0;
        this.state.config = { workOrder: '', partNumber: '', operator: '', targetCount: 0 };
    },

    downloadCSV() {
        window.location.href = `/api/session/download_csv?session_id=${this.state.sessionId}`;
    },

    // --- 4. 輔助工具 (Utilities) ---

    renderStatus(type, text) {
        const el = this.dom.displays.status;
        el.innerHTML = ''; // 清空模板
        el.textContent = text;
        el.className = 'status-display'; // Reset
        
        const map = {
            'IDLE': 'status-idle',
            'PASS': 'status-ok',
            'FAIL': 'status-fail',
            'WARN': 'status-warn'
        };
        if (map[type]) el.classList.add(map[type]);
    },

    renderTemplate(tmplName, data) {
        const tmpl = this.dom.templates[tmplName];
        if (!tmpl) return document.createElement('div');
        
        const clone = tmpl.content.cloneNode(true);
        // 遞迴填值 data-field
        Object.keys(data).forEach(key => {
            const field = clone.querySelector(`[data-field="${key}"]`);
            if (field) field.textContent = data[key];
        });
        return clone;
    },

    showWarningModal(uiContent, onConfirm) {
        const m = this.dom.modals;
        m.title.textContent = uiContent.title || '警告';
        m.message.textContent = uiContent.message || '確認執行？';
        m.warning.style.display = 'block';

        // 重新綁定事件以避免閉包重複
        const btnConfirm = this.dom.buttons.modalConfirm;
        const btnCancel = this.dom.buttons.modalCancel;
        
        // 簡單的事件替換 (Clone node trick)
        const newConfirm = btnConfirm.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnConfirm.parentNode.replaceChild(newConfirm, btnConfirm);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
        this.dom.buttons.modalConfirm = newConfirm;
        this.dom.buttons.modalCancel = newCancel;

        newConfirm.onclick = () => {
            m.warning.style.display = 'none';
            onConfirm();
        };
        newCancel.onclick = () => {
            m.warning.style.display = 'none';
            this.renderStatus('IDLE', '操作已取消');
            this.dom.inputs.barcode.focus();
        };
    },

    async apiCall(endpoint, method = 'POST', body = null) {
        try {
            const opts = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) opts.body = JSON.stringify(body);
            const res = await fetch(endpoint, opts);
            return await res.json();
        } catch (error) {
            console.error(error);
            return { status: "FAIL", error: "NETWORK_ERROR", msg: error.message };
        }
    }
};

// 啟動
document.addEventListener('DOMContentLoaded', () => App.init());
