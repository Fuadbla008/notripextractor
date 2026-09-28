(() => {
  if (window.__nteLoaded) return;
  window.__nteLoaded = true;

  const CFG = window.NTE_CONFIG || { WAREHOUSE: {}, AREAS: [], HUB_COORDS: {} };
  const BASE_URL = 'https://dash.packzy.com/admin/fleet/vehicles';

  const state = {
    running: false, stopped: false,
    idleFor: '24h', concurrency: 3,
    currentPage: 0, totalRecords: 0,
    records: [], logs: []
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bcast = (p) => { try { chrome.runtime.sendMessage(p).catch(() => {}); } catch (e) {} };

  function log(msg, type = 'info') {
    const e = { msg, type, ts: Date.now() };
    state.logs.push(e); if (state.logs.length > 400) state.logs.shift();
    bcast({ type: 'LOG', entry: e });
  }
  function snapshot() {
    return {
      running: state.running, stopped: state.stopped,
      idleFor: state.idleFor, concurrency: state.concurrency,
      currentPage: state.currentPage, totalRecords: state.totalRecords,
      logs: state.logs.slice(-150),
      preview: state.records.slice(-100)
    };
  }
  const broadcastState = () => bcast({ type: 'STATE', state: snapshot() });

  // ---------- Geometry helpers ----------
  const M_PER_DEG_LAT = 110540;
  const M_PER_DEG_LNG_AT = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

  function latLngToM(lat, lng, refLat, refLng) {
    return [ (lng - refLng) * M_PER_DEG_LNG_AT(refLat), (lat - refLat) * M_PER_DEG_LAT ];
  }
  function pointToSegmentM(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ray casting (uses lng as x, lat as y)
  function pointInPolygonRaw(lat, lng, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [latI, lngI] = poly[i];
      const [latJ, lngJ] = poly[j];
      const intersect = ((lngI > lng) !== (lngJ > lng)) &&
        (lat < (latJ - latI) * (lng - lngI) / (lngJ - lngI) + latI);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // 1km tolerance: inside polygon OR within tolerance of boundary
  function pointInArea(lat, lng, poly, tolKm) {
    if (pointInPolygonRaw(lat, lng, poly)) return true;
    if (!tolKm) return false;
    // convert to local meters
    const [px, py] = latLngToM(lat, lng, lat, lng); // origin = point itself
    // Actually need distances to segments; do it in original lat/lng with approx
    let minDistM = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [latA, lngA] = poly[j];
      const [latB, lngB] = poly[i];
      const [ax, ay] = latLngToM(latA, lngA, lat, lng);
      const [bx, by] = latLngToM(latB, lngB, lat, lng);
      const d = pointToSegmentM(0, 0, ax, ay, bx, by);
      if (d < minDistM) minDistM = d;
    }
    return minDistM <= tolKm * 1000;
  }

    // ---------- Classification ----------
  function isCentralWarehouse(name) {
    const pats = CFG.WAREHOUSE.centralPatterns || [];
    return pats.some((p) => p.test(name));
  }

  function classify(hubName) {
    // 0. Force override (config.js এর FORCE_CATEGORY)
    const forced = (CFG.FORCE_CATEGORY || {})[hubName];
    if (forced) return { category: forced, area: null, forced: true };

    // 1. coordinate lookup
    const coords = CFG.HUB_COORDS[hubName];
    if (!coords) return { category: 'not_found', area: null };

    const [lat, lng] = coords;
    const tolKm = CFG.WAREHOUSE.toleranceKm ?? 1;

    // 2. find areas containing hub
    const primary = CFG.AREAS.find((a) => a.isPrimary);
    const insidePrimary = primary ? pointInArea(lat, lng, primary.polygon, tolKm) : false;
    const insideAnyOther = CFG.AREAS
      .filter((a) => !a.isPrimary)
      .some((a) => pointInArea(lat, lng, a.polygon, tolKm));
    const insideAny = insidePrimary || insideAnyOther;

    // 3. central check
    if (isCentralWarehouse(hubName)) {
      return { category: insideAny ? 'inside_central' : 'outside_central', area: null };
    }

    // 4. regular hub
    if (insidePrimary)  return { category: 'inside_savar',  area: primary.name };
    if (insideAnyOther) return { category: 'outside_savar', area: null };
    return { category: 'outside_central', area: null };
  }

  // ---------- vehicle number normalize ----------
  function normalizeVehicle(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    s = s.replace(/DM-/g, 'DHM-');
    s = s.replace(/au/g, 'AU').replace(/ma/g, 'MA').replace(/na/g, 'NA');
    s = s.replace(/m/g, 'MA').replace(/a/g, 'AU').replace(/u/g, 'U').replace(/n/g, 'NA');
    return s;
  }

  // ---------- parse page ----------
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
        const [dtPart = '', tripPart = ''] = txt.split('·').map((p) => p.trim());
        const [d = '', t = ''] = dtPart.split(',').map((p) => p.trim());
        date = d; time = t;
        const aEl = idleSubEl.querySelector('a');
        tripId = aEl ? aEl.innerText.trim() : tripPart;
      }

      const { category, area } = classify(operatingHub);

      out.push({
        vehicleNo, vehicleModel, vehicleId, operatingHub, idleTime,
        date, time, tripId,
        category, area
      });
    });
    return out;
  }

  async function fetchPage(page, idleFor) {
    const url = `${BASE_URL}?idle_for=${encodeURIComponent(idleFor)}&status=idle&page=${page}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // ---------- main loop ----------
  async function runScrape(resume = false) {
    if (state.running) return;
    state.running = true; state.stopped = false;

    if (!resume) {
      state.currentPage = 0; state.totalRecords = 0;
      state.records = []; state.logs = [];
    }
    broadcastState();
    log(resume ? '▶ Resuming...' : '▶ Starting...', 'info');

    const batch = Math.max(1, Math.min(5, state.concurrency || 1));

    while (state.running && !state.stopped) {
      const startPage = state.currentPage + 1;
      const pages = Array.from({ length: batch }, (_, i) => startPage + i);
      log(`Fetching pages ${pages[0]}–${pages[pages.length - 1]} (x${batch})...`, 'info');
      broadcastState();

      const results = await Promise.all(pages.map(async (p) => {
        try { return { page: p, html: await fetchPage(p, state.idleFor), error: null }; }
        catch (e) { return { page: p, html: null, error: e.message }; }
      }));

      let stopNow = false;
      for (const r of results) {
        if (state.stopped) break;
        if (r.error) { log(`✖ Page ${r.page}: ${r.error}`, 'error'); continue; }

        const rows = parsePage(r.html);
        if (rows.length === 0) {
          log(`⏹ Page ${r.page} empty — end reached.`, 'warn');
          state.currentPage = r.page - 1; stopNow = true; break;
        }
        state.records.push(...rows);
        state.totalRecords = state.records.length;
        state.currentPage = r.page;

        // category count summary
        const cc = {};
        rows.forEach((x) => { cc[x.category] = (cc[x.category] || 0) + 1; });
        const sum = Object.entries(cc).map(([k, v]) => `${k}:${v}`).join(' ');
        log(`✓ Page ${r.page}: ${rows.length} rows (total ${state.totalRecords}) [${sum}]`, 'success');
      }

      broadcastState();
      bcast({ type: 'PREVIEW', preview: state.records.slice(-100) });
      if (stopNow) break;
      await sleep(250);
    }

    const wasStopped = state.stopped;
    state.running = false; state.stopped = false;
    log(wasStopped ? '⏸ Stopped by user.' : `✔ Done. Total: ${state.totalRecords}`, wasStopped ? 'warn' : 'success');
    broadcastState();
    bcast({ type: 'DONE', total: state.totalRecords });
  }

  function stopScrape() {
    if (!state.running) return;
    state.stopped = true;
    log('⏹ Stop requested.', 'warn');
    broadcastState();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':      sendResponse({ ok: true }); return true;
      case 'GET_STATE': sendResponse({ ok: true, state: snapshot() }); return true;
      case 'START':
        if (state.running) { sendResponse({ ok: false, reason: 'Already running' }); return true; }
        state.idleFor = msg.idleFor || '24h';
        state.concurrency = Math.max(1, Math.min(5, Number(msg.concurrency) || 3));
        runScrape(false);
        sendResponse({ ok: true }); return true;
      case 'STOP':   stopScrape(); sendResponse({ ok: true }); return true;
      case 'RESUME':
        if (state.running) { sendResponse({ ok: false, reason: 'Already running' }); return true; }
        runScrape(true); sendResponse({ ok: true }); return true;
      case 'EXPORT': sendResponse({ ok: true, records: state.records }); return true;
      case 'GET_CONFIG':
        sendResponse({
          ok: true,
          areas: (CFG.AREAS || []).map((a) => ({ name: a.name, isPrimary: !!a.isPrimary })),
          hubCount: Object.keys(CFG.HUB_COORDS || {}).length
        });
        return true;
    }
    return true;
  });

  log(`Content ready. Areas: ${CFG.AREAS?.length || 0}, Hubs: ${Object.keys(CFG.HUB_COORDS || {}).length}`, 'info');
})();