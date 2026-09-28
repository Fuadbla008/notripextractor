const els = {
  idleFor: document.getElementById('idleFor'),
  concurrency: document.getElementById('concurrency'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  statPage: document.getElementById('statPage'),
  statRecords: document.getElementById('statRecords'),
  statStatus: document.getElementById('statStatus'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  console: document.getElementById('console'),
  preview: document.getElementById('preview'),
  previewCount: document.getElementById('previewCount'),
  clearConsole: document.getElementById('clearConsole'),
  clearAll: document.getElementById('clearAll'),
  tabs: document.getElementById('tabs'),
  csvAll: document.getElementById('csvAll'),
  jsonAll: document.getElementById('jsonAll'),
  csvInsideSavar: document.getElementById('csvInsideSavar'),
  csvOutsideSavar: document.getElementById('csvOutsideSavar'),
  csvInsideCentral: document.getElementById('csvInsideCentral'),
  csvOutsideCentral: document.getElementById('csvOutsideCentral'),
  csvNotFound: document.getElementById('csvNotFound'),
  csvFiltered: document.getElementById('csvFiltered')
};

const CATEGORIES = ['inside_savar','outside_savar','inside_central','outside_central','not_found'];
const CAT_LABEL = {
  inside_savar:    'inside_under_savar_warehouse',
  outside_savar:   'outside_under_savar_warehouse',
  inside_central:  'inside_under_central_warehouse',
  outside_central: 'outside_under_central_warehouse',
  not_found:       'not_found'
};

let lockedTabId = null;
let allRecords = [];
let activeTab = 'all';

// ---------- tab helpers ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const isFleetUrl = (url) => typeof url === 'string' && url.startsWith('https://dash.packzy.com/admin/fleet/');

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r?.ok) return;
  } catch (e) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js','content.js'] });
}

async function sendToTab(type, payload = {}, opts = {}) {
  let tabId = opts.useLocked ? lockedTabId : lockedTabId;
  if (!tabId) {
    const tab = await getActiveTab();
    if (!tab || !isFleetUrl(tab.url)) throw new Error('Open a Packzy fleet page first');
    tabId = tab.id;
    if (opts.lock) lockedTabId = tabId;
  }
  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, { type, ...payload });
}

// ---------- UI helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
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

function updateCounts() {
  const counts = { all: allRecords.length };
  CATEGORIES.forEach((c) => { counts[c] = 0; });
  allRecords.forEach((r) => { if (counts[r.category] !== undefined) counts[r.category]++; });
  document.getElementById('cnt-all').textContent = counts.all;
  CATEGORIES.forEach((c) => {
    const el = document.getElementById('cnt-' + c);
    if (el) el.textContent = counts[c];
  });
  // enable/disable dl buttons
  els.csvInsideSavar.disabled    = counts.inside_savar === 0;
  els.csvOutsideSavar.disabled   = counts.outside_savar === 0;
  els.csvInsideCentral.disabled  = counts.inside_central === 0;
  els.csvOutsideCentral.disabled = counts.outside_central === 0;
  els.csvNotFound.disabled       = counts.not_found === 0;
  els.csvFiltered.disabled       = activeTab === 'all' || counts[activeTab] === 0;
  els.csvAll.disabled            = allRecords.length === 0;
  els.jsonAll.disabled           = allRecords.length === 0;
}

function renderPreview() {
  const list = activeTab === 'all' ? allRecords : allRecords.filter((r) => r.category === activeTab);
  const shown = list.slice(-100);
  els.previewCount.textContent = `(${shown.length} of ${list.length})`;
  if (!shown.length) {
    els.preview.innerHTML = '<div class="empty">No data</div>';
    return;
  }
  els.preview.innerHTML = '';
  shown.slice().reverse().forEach((r) => {
    const item = document.createElement('div');
    item.className = 'preview-item cat-' + (r.category || 'not_found');
    item.innerHTML = `
      <div class="pi-top">
        <span class="pi-reg">${escapeHtml(r.vehicleNo)}</span>
        <span class="pi-cat cat-${escapeHtml(r.category)}">${escapeHtml(r.category)}</span>
      </div>
      <div class="pi-mid">
        <span title="${escapeHtml(r.operatingHub)}">${escapeHtml(r.operatingHub)}</span>
      </div>
      <div class="pi-bot">
        <span>${escapeHtml(r.vehicleModel)} ${escapeHtml(r.vehicleId)}</span>
        <span class="muted">${escapeHtml(r.idleTime)}</span>
      </div>
      <div class="pi-bot">
        <span class="muted">${escapeHtml(r.date)} · ${escapeHtml(r.time)}</span>
        <span class="muted">${escapeHtml(r.tripId)}</span>
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
    els.startBtn.disabled = true; els.stopBtn.disabled = false; els.resumeBtn.disabled = true;
    els.idleFor.disabled = true; els.concurrency.disabled = true;
    els.progressFill.classList.add('indeterminate');
    els.progressText.textContent = `Scraping page ${s.currentPage||0} — ${s.totalRecords||0} records`;
  } else if (s.stopped) {
    els.statStatus.textContent = 'Stopped';
    els.statStatus.className = 'stat-value stopped';
    els.startBtn.disabled = false; els.stopBtn.disabled = true; els.resumeBtn.disabled = false;
    els.idleFor.disabled = false; els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '0%';
    els.progressText.textContent = `Stopped at page ${s.currentPage} — ${s.totalRecords} records`;
  } else if ((s.totalRecords ?? 0) > 0 && (s.currentPage ?? 0) > 0) {
    els.statStatus.textContent = 'Done';
    els.statStatus.className = 'stat-value done';
    els.startBtn.disabled = false; els.stopBtn.disabled = true; els.resumeBtn.disabled = false;
    els.idleFor.disabled = false; els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '100%';
    els.progressText.textContent = `Done. ${s.totalRecords} records.`;
  } else {
    els.statStatus.textContent = 'Idle';
    els.statStatus.className = 'stat-value';
    els.startBtn.disabled = false; els.stopBtn.disabled = true; els.resumeBtn.disabled = true;
    els.idleFor.disabled = false; els.concurrency.disabled = false;
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '0%';
    els.progressText.textContent = 'Ready';
  }
  updateCounts();
}

// ---------- export helpers ----------
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(records) {
  const headers = ['vehicleNo','vehicleModel','vehicleId','operatingHub','idleTime','date','time','tripId','category','area','categoryLabel'];
  const lines = [headers.join(',')];
  for (const r of records) {
    const row = {
      ...r,
      categoryLabel: CAT_LABEL[r.category] || r.category
    };
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function makeFilename(scope) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `no_trip_${scope}_${ts}.csv`;
}

async function fetchAllRecords() {
  const res = await sendToTab('EXPORT');
  return res?.records || [];
}

async function downloadCategory(cat) {
  const records = cat === 'all' ? allRecords : allRecords.filter((r) => r.category === cat);
  if (!records.length) { appendLog({ msg: `No records for "${cat}"`, type:'warn', ts: Date.now() }); return; }
  const csv = toCSV(records);
  downloadBlob(csv, makeFilename(cat), 'text/csv;charset=utf-8;');
  appendLog({ msg: `✓ CSV exported: ${cat} (${records.length})`, type:'success', ts: Date.now() });
}

// ---------- buttons ----------
els.startBtn.addEventListener('click', async () => {
  els.console.innerHTML = '';
  els.preview.innerHTML = '<div class="empty">No data yet</div>';
  allRecords = []; lockedTabId = null;
  updateCounts();

  const idleFor = els.idleFor.value;
  const concurrency = Number(els.concurrency.value);
  try {
    const res = await sendToTab('START', { idleFor, concurrency }, { lock: true });
    if (res?.ok) appendLog({ msg: `▶ Started (idle_for=${idleFor}, x${concurrency})`, type:'info', ts: Date.now() });
    else appendLog({ msg: `✖ ${res?.reason || 'Failed'}`, type:'error', ts: Date.now() });
  } catch (e) { appendLog({ msg: `✖ ${e.message}`, type:'error', ts: Date.now() }); }
});

els.stopBtn.addEventListener('click', async () => {
  try { await sendToTab('STOP'); } catch (e) { appendLog({ msg: e.message, type:'error' }); }
});

els.resumeBtn.addEventListener('click', async () => {
  try {
    const res = await sendToTab('RESUME');
    if (res?.ok) appendLog({ msg: '⟳ Resumed', type:'info', ts: Date.now() });
    else appendLog({ msg: `✖ ${res?.reason || 'Failed'}`, type:'error' });
  } catch (e) { appendLog({ msg: e.message, type:'error' }); }
});

els.csvAll.addEventListener('click', () => downloadCategory('all'));
els.jsonAll.addEventListener('click', async () => {
  if (!allRecords.length) return;
  downloadBlob(JSON.stringify(allRecords, null, 2), makeFilename('all').replace('.csv','.json'), 'application/json');
  appendLog({ msg: `✓ JSON exported (${allRecords.length})`, type:'success', ts: Date.now() });
});
els.csvInsideSavar.addEventListener('click',    () => downloadCategory('inside_savar'));
els.csvOutsideSavar.addEventListener('click',   () => downloadCategory('outside_savar'));
els.csvInsideCentral.addEventListener('click',  () => downloadCategory('inside_central'));
els.csvOutsideCentral.addEventListener('click', () => downloadCategory('outside_central'));
els.csvNotFound.addEventListener('click',       () => downloadCategory('not_found'));
els.csvFiltered.addEventListener('click',       () => { if (activeTab !== 'all') downloadCategory(activeTab); });

els.clearConsole.addEventListener('click', () => { els.console.innerHTML = ''; });
els.clearAll.addEventListener('click', () => {
  allRecords = []; els.console.innerHTML = '';
  els.preview.innerHTML = '<div class="empty">No data yet</div>';
  applyState({ running:false, stopped:false, currentPage:0, totalRecords:0 });
});

// Tabs
els.tabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  els.tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  activeTab = btn.dataset.cat;
  updateCounts();
  renderPreview();
});

// ---------- messages from content script ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE')        applyState(msg.state);
  else if (msg.type === 'LOG')     appendLog(msg.entry);
  else if (msg.type === 'PREVIEW') {
    // preview is the last 100 records (all)
    // we don't have full records here; only state has totalRecords.
    // We'll rely on EXPORT for full data when done. But to show live preview:
    // keep a live buffer via the preview payload plus state (not ideal but works).
    // Actually, better: on each PREVIEW, we still don't know all records.
    // So we fetch full set when Done or on tab click.
    // For simplicity, accumulate: we can't know total from preview alone.
    // We'll instead rely on DONE to pull all.
    // Still, do a best-effort: keep last 100 as preview only.
    // (Leave as-is — full records are pulled on DONE / on demand.)
  }
  else if (msg.type === 'DONE') {
    applyState({ running:false, stopped:false, currentPage:0, totalRecords: msg.total });
    // Pull full records once finished
    (async () => {
      try {
        allRecords = await fetchAllRecords();
        updateCounts();
        renderPreview();
        appendLog({ msg: `📦 Loaded ${allRecords.length} records into view`, type:'info', ts: Date.now() });
      } catch (e) { appendLog({ msg: e.message, type:'error' }); }
    })();
  }
});

// Initial
(async () => {
  try {
    const res = await sendToTab('GET_STATE');
    if (res?.ok && res.state) {
      applyState(res.state);
      res.state.logs?.forEach(appendLog);
    }
    const cfg = await sendToTab('GET_CONFIG');
    if (cfg?.ok) {
      appendLog({ msg: `Config: ${cfg.areas.length} areas, ${cfg.hubCount} hub coords`, type:'info', ts: Date.now() });
      if (cfg.areas.length === 0) appendLog({ msg: '⚠ No AREAS configured in config.js', type:'warn', ts: Date.now() });
      if (cfg.hubCount === 0)     appendLog({ msg: '⚠ No HUB_COORDS configured in config.js', type:'warn', ts: Date.now() });
    }
  } catch (e) {
    appendLog({ msg: '⚠ Open a Packzy fleet page first.', type:'warn', ts: Date.now() });
  }
})();