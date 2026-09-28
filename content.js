(() => {
  if (window.__noTripExtractorLoaded) return;
  window.__noTripExtractorLoaded = true;

  const BASE_URL = 'https://dash.packzy.com/admin/fleet/vehicles';

  const state = {
    running: false,
    stopped: false,
    idleFor: '24h',
    concurrency: 3,
    currentPage: 0,
    totalRecords: 0,
    records: [],
    logs: []
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function broadcast(payload) {
    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch (e) {}
  }

  function log(msg, type = 'info') {
    const entry = { msg, type, ts: Date.now() };
    state.logs.push(entry);
    if (state.logs.length > 400) state.logs.shift();
    broadcast({ type: 'LOG', entry });
  }

  function snapshot() {
    return {
      running: state.running,
      stopped: state.stopped,
      idleFor: state.idleFor,
      concurrency: state.concurrency,
      currentPage: state.currentPage,
      totalRecords: state.totalRecords,
      logs: state.logs.slice(-150),
      preview: state.records.slice(-100)
    };
  }

  function broadcastState() { broadcast({ type: 'STATE', state: snapshot() }); }

  // ---------- vehicle number normalize ----------
  function normalizeVehicle(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    s = s.replace(/DM-/g, 'DHM-');
    s = s.replace(/au/g, 'AU');
    s = s.replace(/ma/g, 'MA');
    s = s.replace(/na/g, 'NA');
    s = s.replace(/m/g,  'MA');
    s = s.replace(/a/g,  'AU');
    s = s.replace(/u/g,  'U');
    s = s.replace(/n/g,  'NA');
    return s;
  }

  // ---------- parse HTML rows ----------
  function parsePage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    doc.querySelectorAll('tr').forEach((tr) => {
      const regEl = tr.querySelector('.fv-reg');
      if (!regEl) return;

      const vehicleNo = normalizeVehicle(regEl.innerText);

      const modelEl = tr.querySelector('td.fv-c--vehicle .fv-sub');
      let vehicleModel = '', vehicleId = '';
      if (modelEl) {
        const parts = modelEl.innerText.trim().split('·').map((p) => p.trim());
        vehicleModel = parts[0] || '';
        vehicleId = parts.slice(1).join('·').trim();
      }

      const hubEl = tr.querySelector('td.fv-c--hub span');
      const operatingHub = hubEl ? hubEl.innerText.trim() : '';

      const idleForEl = tr.querySelector('.fv-idle .fv-idle__for');
      const idleTime = idleForEl ? idleForEl.innerText.trim() : '';

      const idleSubEl = tr.querySelector('.fv-idle .fv-sub');
      let date = '', time = '', tripId = '';
      if (idleSubEl) {
        const txt = idleSubEl.innerText.trim();
        const [dateTimePart = '', tripPart = ''] = txt.split('·').map((p) => p.trim());
        const [d = '', t = ''] = dateTimePart.split(',').map((p) => p.trim());
        date = d;
        time = t;
        const aEl = idleSubEl.querySelector('a');
        tripId = aEl ? aEl.innerText.trim() : tripPart;
      }

      out.push({ vehicleNo, vehicleModel, vehicleId, operatingHub, idleTime, date, time, tripId });
    });
    return out;
  }

  // ---------- fetch a single page ----------
  async function fetchPage(page, idleFor) {
    const url = `${BASE_URL}?idle_for=${encodeURIComponent(idleFor)}&status=idle&page=${page}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // ---------- concurrent scrape loop ----------
  async function runScrape(resume = false) {
    if (state.running) return;
    state.running = true;
    state.stopped = false;

    if (!resume) {
      state.currentPage = 0;
      state.totalRecords = 0;
      state.records = [];
      state.logs = [];
    }

    broadcastState();
    log(resume ? '▶ Resuming...' : '▶ Starting...', 'info');

    const batch = Math.max(1, Math.min(5, state.concurrency || 1));

    while (state.running && !state.stopped) {
      const startPage = state.currentPage + 1;
      const pages = [];
      for (let i = 0; i < batch; i++) pages.push(startPage + i);

      const lastPage = pages[pages.length - 1];
      log(`Fetching pages ${pages[0]}–${lastPage} (x${batch})...`, 'info');
      broadcastState();

      const results = await Promise.all(
        pages.map(async (p) => {
          try {
            const html = await fetchPage(p, state.idleFor);
            return { page: p, html, error: null };
          } catch (e) {
            return { page: p, html: null, error: e.message };
          }
        })
      );

      let stopNow = false;

      for (const r of results) {
        if (state.stopped) break;

        if (r.error) {
          log(`✖ Page ${r.page}: ${r.error}`, 'error');
          continue;
        }

        const rows = parsePage(r.html);

        if (rows.length === 0) {
          log(`⏹ Page ${r.page} empty — end reached.`, 'warn');
          state.currentPage = r.page - 1;
          stopNow = true;
          break;
        }

        state.records.push(...rows);
        state.totalRecords = state.records.length;
        state.currentPage = r.page;
        log(`✓ Page ${r.page}: ${rows.length} records (total ${state.totalRecords})`, 'success');
      }

      broadcastState();
      broadcast({ type: 'PREVIEW', preview: state.records.slice(-100) });

      if (stopNow) break;

      await sleep(250);
    }

    const wasStopped = state.stopped;
    state.running = false;
    state.stopped = false;

    if (wasStopped) log('⏸ Stopped by user.', 'warn');
    else log(`✔ Done. Total records: ${state.totalRecords}`, 'success');

    broadcastState();
    broadcast({ type: 'DONE', total: state.totalRecords });
  }

  function stopScrape() {
    if (!state.running) return;
    state.stopped = true;
    log('⏹ Stop requested.', 'warn');
    broadcastState();
  }

  // ---------- message bridge ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':
        sendResponse({ ok: true });
        return true;
      case 'GET_STATE':
        sendResponse({ ok: true, state: snapshot() });
        return true;
      case 'START':
        if (state.running) { sendResponse({ ok: false, reason: 'Already running' }); return true; }
        state.idleFor = msg.idleFor || '24h';
        state.concurrency = Math.max(1, Math.min(5, Number(msg.concurrency) || 3));
        runScrape(false);
        sendResponse({ ok: true });
        return true;
      case 'STOP':
        stopScrape();
        sendResponse({ ok: true });
        return true;
      case 'RESUME':
        if (state.running) { sendResponse({ ok: false, reason: 'Already running' }); return true; }
        runScrape(true);
        sendResponse({ ok: true });
        return true;
      case 'EXPORT':
        sendResponse({ ok: true, records: state.records });
        return true;
    }
    return true;
  });

  log('Content script ready.', 'info');
})();