/**
 * NFC Production Tester - Frontend Logic v4.0
 * Features: Flexible Schema via JSON Config.
 * Note: Test View UI preserved. Count logic removed.
 */

const App = {
    state: {
        sessionId: null,
        sessionData: {},
        scannedCount: 0,
        currentBarcode: null,
        isProcessing: false,
        stationConfig: null 
    },
    dom: {},

    init() {
        window.onload = () => {
            this.cacheDOM();
            if (!this.dom.views.setup) return console.error("Critical: DOM missing");
            this.bindEvents();
            this.loadConfigAndResume();
        };
    },

    cacheDOM() {
        const el = (id) => document.getElementById(id);
        this.dom = {
            views: { setup: el('view-setup'), test: el('view-test'), summary: el('view-summary') },
            formContainer: el('dynamic-form-container'),
            inputs: { barcode: el('input-barcode') },
            displays: { sessionId: el('display-session-id'), status: el('status-display') },
            buttons: {
                start: el('btn-start-session'), write: el('btn-write'), read: el('btn-read'),
                end: el('btn-end-session'), download: el('btn-download-csv'), newSession: el('btn-new-session'),
                backSetup: el('btn-back-setup'), modalConfirm: el('btn-modal-confirm'), modalCancel: el('btn-modal-cancel')
            },
            modals: { warning: el('modal-warning'), loading: el('modal-loading') },
            templates: { pass: el('tmpl-status-pass'), failVerify: el('tmpl-error-verify'), failGeneric: el('tmpl-error-generic') }
        };
    },

    bindEvents() {
        const b = this.dom.buttons;
        if(b.start) b.start.onclick = () => this.handleStartSession();
        if(b.write) b.write.onclick = () => this.executeTest('write');
        if(b.read) b.read.onclick = () => this.executeTest('read');
        if(b.end) b.end.onclick = () => this.handleEndSession();
        if(b.download) b.download.onclick = () => this.downloadCSV();
        if(b.newSession) b.newSession.onclick = () => this.resetToHome();
        if(b.backSetup) b.backSetup.onclick = () => this.handleBackToSetup();
        if(this.dom.inputs.barcode) {
            this.dom.inputs.barcode.onkeypress = (e) => {
                if(e.key === 'Enter') { e.preventDefault(); this.handleBarcodeScan(e.target.value.trim()); }
            };
        }
    },

    // --- Dynamic Config Logic ---

    async loadConfigAndResume() {
        try {
            const cfg = await this.apiCall('/api/config', 'GET');
            if (cfg && cfg.csv_fields) {
                this.state.stationConfig = cfg;
                this.renderDynamicForm(cfg.csv_fields);
            }
            this.checkAndResumeSession();
        } catch (e) {
            console.error("Config Load Error", e);
            if(this.dom.formContainer) this.dom.formContainer.innerHTML = "無法連接後端";
        }
    },

    renderDynamicForm(fields) {
        const c = this.dom.formContainer;
        if (!c) return;
        c.innerHTML = '';
        
        fields.forEach(f => {
            const div = document.createElement('div');
            div.className = 'form-group';
            
            const label = document.createElement('label');
            label.textContent = f.label + (f.required ? " *" : "");
            
            const input = document.createElement('input');
            input.type = f.type === 'number' ? 'number' : 'text';
            input.id = `input-dynamic-${f.key}`; // ID 命名規則
            if(f.placeholder) input.placeholder = f.placeholder;
            if(f.default !== undefined) input.value = f.default;
            
            const saved = localStorage.getItem(`last_${f.key}`);
            if(saved) input.value = saved;

            div.appendChild(label);
            div.appendChild(input);
            c.appendChild(div);
        });
    },
    
    // 統一的 UI 渲染入口
    renderStatus(type, content = null) {
        const el = this.dom.displays.status;
        if (!el) return;

        // 1. 清空舊內容
        el.innerHTML = ''; 
        
        // 2. 重置並設定新的狀態 Class (解耦關鍵：只操作 class 名稱)
        el.className = ''; // 清除所有舊 class
        
        switch (type) {
            case 'IDLE':
                el.classList.add('state-idle');
                el.textContent = content || '等待掃描...';
                break;
            case 'WARN':
                el.classList.add('state-warn');
                el.textContent = content || '警告';
                break;
            case 'PASS':
                el.classList.add('state-pass');
                if (content) el.appendChild(content); // 插入 Template DOM
                break;
            case 'FAIL':
                el.classList.add('state-fail');
                if (content) el.appendChild(content); // 插入 Template DOM
                break;
        }
    },

    async handleStartSession() {
        const payload = {};
        let isValid = true;
        
        // 根據 Config 動態抓取 Input 值
        if (this.state.stationConfig) {
            this.state.stationConfig.csv_fields.forEach(f => {
                const el = document.getElementById(`input-dynamic-${f.key}`);
                if (el) {
                    const val = el.value.trim();
                    if (f.required && !val) {
                        el.style.borderColor = "#dc3545";
                        isValid = false;
                    } else {
                        el.style.borderColor = "#ced4da";
                        payload[f.key] = val; // 這裡的 Key 與 Config 一致
                        localStorage.setItem(`last_${f.key}`, val);
                    }
                }
            });
        }

        if (!isValid) return alert("請填寫所有必填欄位");

        const doStart = async () => {
            this.setUiBusy(true, "啟動中...");
            const res = await this.apiCall('/api/session/start', 'POST', payload);
            this.setUiBusy(false);

            if (res.status === 'OK') {
                this.state.sessionId = res.session_id;
                this.state.scannedCount = 0;
                if(this.dom.displays.sessionId) this.dom.displays.sessionId.textContent = `Session: ${this.state.sessionId}`;
                if(this.dom.inputs.barcode) {
                    this.dom.inputs.barcode.value = '';
                    this.dom.inputs.barcode.focus();
                }
                this.setStatus('IDLE', '請掃描條碼開始測試');
                this.toggleActionButtons(false);
                this.switchView('test');
            } else if (res.error === 'SESSION_ACTIVE') {
                if(confirm("發現未結束的工單，是否強制開啟新工單？")) {
                    await this.apiCall('/api/session/end', 'POST', {});
                    doStart();
                } else {
                    this.checkAndResumeSession();
                }
            } else {
                alert("啟動失敗: " + (res.message || res.error));
            }
        };
        doStart();
    },

    // --- Standard Logic (Unchanged UI interactions) ---

    async checkAndResumeSession() {
        try {
            const res = await this.apiCall('/api/session/current', 'GET');
            if (res.active) {
                this.state.sessionId = res.session_id;
                this.state.scannedCount = res.scanned_count;
                if(this.dom.displays.sessionId) this.dom.displays.sessionId.textContent = `Session: ${this.state.sessionId}`;
                this.setStatus('IDLE', '已恢復連線');
                this.toggleActionButtons(false);
                this.switchView('test');
                if(this.dom.inputs.barcode) this.dom.inputs.barcode.focus();
            }
        } catch(e) {}
    },

    async handleBarcodeScan(code) {
        if (!code) return;
        this.state.currentBarcode = code;
        this.setStatus('IDLE', '檢查條碼...');
        const res = await this.apiCall('/api/session/check_barcode', 'POST', {
            session_id: this.state.sessionId, barcode: code
        });
        if (res.status === 'OK') {
            this.renderStatus('IDLE', `條碼: ${code} (就緒)`); // 使用 IDLE 樣式顯示文字
            this.toggleActionButtons(true);
        } else if (res.error === 'DUPLICATE_SCAN') {
            this.renderStatus('WARN', `警告: 條碼 ${code} 重複`); // 使用 WARN 樣式
            this.toggleActionButtons(true);
        } else {
            this.renderStatus('FAIL', document.createTextNode(`錯誤: ${res.message}`)); // 或直接傳字串
            this.toggleActionButtons(false);
        }
        /*
        if (res.status === 'OK') {
            this.setStatus('IDLE', `條碼: ${code} (就緒)`);
            this.toggleActionButtons(true);
        } else if (res.error === 'DUPLICATE_SCAN') {
            this.setStatus('WARN', `警告: 條碼 ${code} 重複`);
            this.toggleActionButtons(true);
        } else {
            this.setStatus('FAIL', `錯誤: ${res.message}`);
            this.toggleActionButtons(false);
        }
        */
    },

    async executeTest(action, allowDuplicate = false) {
        if (!this.state.currentBarcode) return;
        const endpoint = action === 'write' ? '/api/prod/write' : '/api/prod/read';
        this.setUiBusy(true, "測試中...");
        
        const payload = {
            session_id: this.state.sessionId,
            barcode: this.state.currentBarcode,
            allow_duplicate: allowDuplicate
        };
        if (action === 'write') payload.data = "IG2 AWAN Test OK";
        else payload.expected_data = "IG2 AWAN Test OK";
        
        const res = await this.apiCall(endpoint, 'POST', payload);
        this.setUiBusy(false);

        // 重複掃描處理
        if (res.error === 'DUPLICATE_SCAN' && res.ui) {
            this.showWarningModal(res.ui, () => this.executeTest(action, true));
            // 恢復原狀
            this.renderStatus('IDLE', '等待操作...'); 
            return;
        }

        // 根據結果呼叫渲染層
        if (res.status === 'PASS') {
            // 1. 準備資料
            const tmpl = this.renderTemplate('tmpl-status-pass', {
                uid: res.uid || 'N/A',
                actual: "IG2 AWAN Test OK"
            });
            
            // 2. 更新 UI 狀態
            this.renderStatus('PASS', tmpl);
            
            this.state.scannedCount++;
            if (this.dom.inputs.barcode) {
                this.dom.inputs.barcode.focus();
                this.dom.inputs.barcode.select();
            }
        } else {
            const isVerify = (res.error === 'VERIFY_FAIL');
            const tmplName = isVerify ? 'tmpl-error-verify' : 'tmpl-error-generic';
            const data = isVerify ? 
                { uid: res.uid, expected: res.expected, actual: res.actual } : 
                { msg: res.msg || 'Error', error: res.error };
            
            const tmpl = this.renderTemplate(tmplName, data);
            
            // 更新 UI 狀態
            this.renderStatus('FAIL', tmpl);
            
            if (this.dom.inputs.barcode) this.dom.inputs.barcode.select();
        }
    },
/*
        const res = await this.apiCall(endpoint, 'POST', payload);
        this.setUiBusy(false);

        const box = this.dom.displays.status;
        if (box) { box.innerHTML = ''; box.className = ''; box.removeAttribute('id'); }

        if (res.error === 'DUPLICATE_SCAN' && res.ui) {
            this.showWarningModal(res.ui, () => this.executeTest(action, true));
            if(box) box.id = 'status-display';
            return;
        }

        if (res.status === 'PASS') {
            const tmpl = this.renderTemplate('tmpl-status-pass', { uid: res.uid || 'N/A', actual: "IG2 AWAN Test OK" });
            if (box) box.appendChild(tmpl);
            this.state.scannedCount++;
            if(this.dom.inputs.barcode) { this.dom.inputs.barcode.focus(); this.dom.inputs.barcode.select(); }
        } else {
            const isVerify = (res.error === 'VERIFY_FAIL');
            const tmplName = isVerify ? 'tmpl-error-verify' : 'tmpl-error-generic';
            const data = isVerify ? { uid: res.uid, expected: res.expected, actual: res.actual } : { msg: res.msg || 'Error', error: res.error };
            const tmpl = this.renderTemplate(tmplName, data);
            if (box) box.appendChild(tmpl);
            if(this.dom.inputs.barcode) this.dom.inputs.barcode.select();
        }
    },
    * */

    // --- Utility ---

    async handleEndSession() { if(confirm("確定結束？")) { await this.apiCall('/api/session/end', 'POST', {}); this.switchView('summary'); } },
    handleBackToSetup() { if(confirm("確定中斷？")) { this.apiCall('/api/session/end', 'POST', {}); this.switchView('setup'); } },
    resetToHome() { this.switchView('setup'); },
    downloadCSV() { location.href = `/api/session/download_csv?session_id=${this.state.sessionId}`; },

    switchView(name) {
        Object.values(this.dom.views).forEach(v => { if(v) v.classList.remove('active'); });
        if(this.dom.views[name]) this.dom.views[name].classList.add('active');
    },

    setStatus(type, text) {
        const el = this.dom.displays.status;
        if (!el) return;
        el.innerHTML = text; el.className = ''; el.id = 'status-display';
        if (type === 'IDLE') el.style.color = '#6c757d';
        else if (type === 'WARN') el.classList.add('status-warn');
        else if (type === 'FAIL') el.classList.add('status-fail');
    },

    setUiBusy(busy, msg) {
        const m = this.dom.modals.loading;
        if (!m) return;
        if (busy) { m.querySelector('h3').textContent = msg; m.style.display = 'block'; }
        else m.style.display = 'none';
    },

    toggleActionButtons(enable) {
        if (this.dom.buttons.write) this.dom.buttons.write.disabled = !enable;
        if (this.dom.buttons.read) this.dom.buttons.read.disabled = !enable;
    },

    renderTemplate(id, data) {
        const t = this.dom.templates[id] || document.getElementById(id); // try key or id
        if (!t) return document.createElement('div');
        const clone = t.content.cloneNode(true);
        Object.keys(data).forEach(k => {
            const el = clone.querySelector(`[data-field="${k}"]`);
            if (el) el.textContent = data[k];
        });
        return clone;
    },

    showWarningModal(ui, onConfirm) {
        const m = this.dom.modals.warning;
        document.getElementById('modal-title').textContent = ui.title || '警告';
        document.getElementById('modal-message').textContent = ui.message;
        m.style.display = 'block';
        const newConf = document.getElementById('btn-modal-confirm').cloneNode(true);
        const newCancel = document.getElementById('btn-modal-cancel').cloneNode(true);
        document.getElementById('btn-modal-confirm').replaceWith(newConf);
        document.getElementById('btn-modal-cancel').replaceWith(newCancel);
        newConf.onclick = () => { m.style.display = 'none'; onConfirm(); };
        newCancel.onclick = () => { m.style.display = 'none'; this.setStatus('IDLE', '已取消'); };
    },

    async apiCall(url, method, body) {
        try {
            const opts = { method, headers: {'Content-Type': 'application/json'} };
            if (body) opts.body = JSON.stringify(body);
            const r = await fetch(url, opts);
            return await r.json();
        } catch (e) {
            return { status: 'FAIL', error: 'NET', message: e.message };
        }
    }
};

App.init();
