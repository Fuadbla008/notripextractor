const els = {
  idleFor:      document.getElementById('idleFor'),
  concurrency:  document.getElementById('concurrency'),
  startBtn:     document.getElementById('startBtn'),
  stopBtn:      document.getElementById('stopBtn'),
  resumeBtn:    document.getElementById('resumeBtn'),
  csvBtn:       document.getElementById('csvBtn'),
  jsonBtn:      document.getElementById('jsonBtn'),
  clearBtn:     document.getElementById('clearBtn'),
  statPage:     document.getElementById('statPage'),
  statRecords:  document.getElementById('statRecords'),
  statStatus:   document.getElementById('statStatus'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  console:      document.getElementById('console'),
  preview:      document.getElementById('preview'),
  previewCount: document.getElementById('previewCount'),
  clearConsole: document.getElementById('clearConsole')
};

let lockedTabId = null;
let cachedRecords = [];

// ---------- tab helpers ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isFleetUrl(url) {
  return typeof url === 'string' && url.startsWith('https://dash.packzy.com/admin/fleet/');
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res?.ok) return;
  } catch (e) { /* not injected yet */ }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function sendToTab(type, payload = {}, opts = {}) {
  let tabId = opts.useLocked && lockedTabId ? lockedTabId : lockedTabId;

  if (!tabId) {
    const tab = await getActiveTab();
    if (!tab || !isFleetUrl(tab.url)) {
      throw new Error('Open a Packzy fleet page first');
    }
    tabId = tab.id;
    if (opts.lock) lockedTabId = tabId;
  }

  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, { type, ...payload });
}

// ---------- UI helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendLog(entry) {
  const div = document.createElement('div');
  div.className = 'log-line log-' + (entry.type || 'info');
  const t = new Date(entry.ts || Date.now()).toLocaleTimeString();
  div.innerHTML = `<span class="log-time">${t}</span><span class="log-msg">${escapeHtml(entry.msg)}</span>`;
  els.console.appendChild(div);
  els.console.scrollTop = els.console.scrollHeight;
  while (els.console.children.length > 400) els.console.removeChild(els.console.firstChild);
}

function renderPreview(records) {
  cachedRecords = records;
  els.previewCount.textContent = `(${records.length} shown)`;
  if (!records.length) {
    els.preview.innerHTML = '<div class="empty">No data yet</div>';
    return;
  }
  els.preview.innerHTML = '';
  records.slice().reverse().forEach((r) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `
      <div class="pi-top">
        <span class="pi-reg">${escapeHtml(r.vehicleNo)}</span>
        <span class="pi-hub" title="${escapeHtml(r.operatingHub)}">${escapeHtml(r.operatingHub)}</span>
      </div>
      <div class="pi-mid">
        <span>${escapeHtml(r.vehicleModel)}</span>
        <span class="muted">${escapeHtml(r.vehicleId)}</span>
      </div>
      <div class="pi-bot">
        <span>${escapeHtml(r.idleTime)}</span>
        <span class="muted">${escapeHtml(r.date)} · ${escapeHtml(r.time)}</span>
      </div>
    `;
    els.preview.appendChild(item);
  });
}

function applyState(s) {
  els.statPage.textContent = s.currentPage ?? 0;
  els.statRecords.textContent = s.totalRecords ?? 0;

  if (s.running) {
    els.statStatus.textContent = 'Running';
    els.statStatus.className = 'stat-value running';
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.resumeBtn.disabled = true;
    els.idleFor.disabled = true;
    els.concurrency.disabled = true;
    els.progressFill.classList.add('indeterminate');
    els.progressText.textContent = `Scraping page ${s.currentPage || 0} — ${s.totalRecords || 0} records`;
  } else if (s.stopped) {
    els.statStatus.textContent = 'Stopped';
    els.statStatus.className = 'stat-value stopped';
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.resumeBtn.disabled = false;
    els.idleFor.disabled = false;
    els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '0%';
    els.progressText.textContent = `Stopped at page ${s.currentPage} — ${s.totalRecords} records`;
  } else if ((s.totalRecords ?? 0) > 0 && (s.currentPage ?? 0) > 0) {
    els.statStatus.textContent = 'Done';
    els.statStatus.className = 'stat-value done';
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.resumeBtn.disabled = false;
    els.idleFor.disabled = false;
    els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '100%';
    els.progressText.textContent = `Done. ${s.totalRecords} records across ${s.currentPage} pages.`;
  } else {
    els.statStatus.textContent = 'Idle';
    els.statStatus.className = 'stat-value';
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.resumeBtn.disabled = true;
    els.idleFor.disabled = false;
    els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '0%';
    els.progressText.textContent = 'Ready';
  }

  const hasRecords = (s.totalRecords ?? 0) > 0;
  els.csvBtn.disabled = !hasRecords;
  els.jsonBtn.disabled = !hasRecords;
}

// ---------- export helpers ----------
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function toCSV(records) {
  const headers = ['vehicleNo','vehicleModel','vehicleId','operatingHub','idleTime','date','time','tripId'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(headers.map((h) => esc(r[h])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM for Excel
}

async function fetchAllRecords() {
  const res = await sendToTab('EXPORT');
  return res?.records || [];
}

// ---------- buttons ----------
els.startBtn.addEventListener('click', async () => {
  els.console.innerHTML = '';
  els.preview.innerHTML = '<div class="empty">No data yet</div>';
  els.previewCount.textContent = '(0 shown)';
  cachedRecords = [];
  lockedTabId = null;

  const idleFor = els.idleFor.value;
  const concurrency = Number(els.concurrency.value);

  try {
    const res = await sendToTab('START', { idleFor, concurrency }, { lock: true });
    if (res?.ok) appendLog({ msg: `▶ Started (idle_for=${idleFor}, x${concurrency})`, type: 'info', ts: Date.now() });
    else appendLog({ msg: `✖ ${res?.reason || 'Failed'}`, type: 'error', ts: Date.now() });
  } catch (e) {
    appendLog({ msg: `✖ ${e.message}`, type: 'error', ts: Date.now() });
  }
});

els.stopBtn.addEventListener('click', async () => {
  try { await sendToTab('STOP'); } catch (e) { appendLog({ msg: e.message, type: 'error' }); }
});

els.resumeBtn.addEventListener('click', async () => {
  try {
    const res = await sendToTab('RESUME');
    if (res?.ok) appendLog({ msg: '⟳ Resumed', type: 'info', ts: Date.now() });
    else appendLog({ msg: `✖ ${res?.reason || 'Failed'}`, type: 'error' });
  } catch (e) { appendLog({ msg: e.message, type: 'error' }); }
});

els.csvBtn.addEventListener('click', async () => {
  try {
    const records = await fetchAllRecords();
    if (!records.length) { appendLog({ msg: 'No records to export', type: 'warn', ts: Date.now() }); return; }
    const csv = toCSV(records);
    downloadBlob(csv, `no_trip_${els.idleFor.value}_${Date.now()}.csv`, 'text/csv;charset=utf-8;');
    appendLog({ msg: `✓ CSV exported (${records.length} rows)`, type: 'success', ts: Date.now() });
  } catch (e) { appendLog({ msg: e.message, type: 'error' }); }
});

els.jsonBtn.addEventListener('click', async () => {
  try {
    const records = await fetchAllRecords();
    if (!records.length) { appendLog({ msg: 'No records to export', type: 'warn', ts: Date.now() }); return; }
    downloadBlob(JSON.stringify(records, null, 2), `no_trip_${els.idleFor.value}_${Date.now()}.json`, 'application/json');
    appendLog({ msg: `✓ JSON exported (${records.length} rows)`, type: 'success', ts: Date.now() });
  } catch (e) { appendLog({ msg: e.message, type: 'error' }); }
});

els.clearBtn.addEventListener('click', () => {
  els.console.innerHTML = '';
  els.preview.innerHTML = '<div class="empty">No data yet</div>';
  els.previewCount.textContent = '(0 shown)';
  cachedRecords = [];
  applyState({ running: false, stopped: false, currentPage: 0, totalRecords: 0 });
});

els.clearConsole.addEventListener('click', () => { els.console.innerHTML = ''; });

// ---------- live broadcasts from content script ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE')        applyState(msg.state);
  else if (msg.type === 'LOG')     appendLog(msg.entry);
  else if (msg.type === 'PREVIEW') renderPreview(msg.preview);
  else if (msg.type === 'DONE') {
    applyState({ running: false, stopped: false, currentPage: 0, totalRecords: msg.total });
  }
});

// ---------- initial load ----------
(async () => {
  try {
    const res = await sendToTab('GET_STATE');
    if (res?.ok && res.state) {
      applyState(res.state);
      res.state.logs?.forEach(appendLog);
      renderPreview(res.state.preview || []);
    }
  } catch (e) {
    appendLog({ msg: '⚠ Open a Packzy fleet page first.', type: 'warn', ts: Date.now() });
  }
})();