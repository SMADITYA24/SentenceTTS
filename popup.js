(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  let activeTabId = null;
  let statusTimer = null;

  const els = {
    playPause: document.getElementById('play-pause'),
    stop: document.getElementById('stop'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    rate: document.getElementById('rate'),
    rateVal: document.getElementById('rate-val'),
    pitch: document.getElementById('pitch'),
    pitchVal: document.getElementById('pitch-val'),
    engine: document.getElementById('engine'),
    voice: document.getElementById('voice'),           // hidden input stores selected value
    voiceSearch: document.getElementById('voice-search'), // text input with list="voice-list"
    voiceList: document.getElementById('voice-list'),  // datalist element
    voiceHint: document.getElementById('voice-hint'),
    status: document.getElementById('status'),
    error: document.getElementById('error'),
    gcloudKeyField: document.getElementById('gcloud-key-field'),
    gcloudKey: document.getElementById('gcloud-key'),
    gcloudSave: document.getElementById('gcloud-save'),
    gcloudKeyStatus: document.getElementById('gcloud-key-status'),
    piperHelp: document.getElementById('piper-help'),
    pdfBanner: document.getElementById('pdf-banner'),
    pdfBannerText: document.getElementById('pdf-banner-text'),
    pdfOpen: document.getElementById('pdf-open'),
  };

  const prefs = { engine: 'gfree', speed: 1, pitch: 1, voice: '' };
  let activeTab = null;
  let pdfTarget = null; // { url, tabId } once a PDF is found on this tab

  // Per-engine voice data. Each engine populates this differently.
  // voices: [{ id, label, meta }]  — id is what content.js expects.
  let voiceList = [];
  let gcloudVoices = null;   // cached fetch of the user's account voices
  let piperModels = null;

  async function getActiveTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }
  async function sendMsg(msg) {
    if (!activeTabId) return null;
    try { return await api.tabs.sendMessage(activeTabId, msg); }
    catch (e) { return null; }
  }
  async function bgSend(msg) {
    try { return await api.runtime.sendMessage(msg); }
    catch (e) { return null; }
  }
  function showError(t) { els.error.textContent = t; els.error.style.display = 'block'; }
  function hideError() { els.error.style.display = 'none'; }

  // ------------------------------------------------------------
  // PDF detection — lets users read PDFs (built-in viewer or embedded)
  // through the bundled pdfviewer.html reader.
  // ------------------------------------------------------------
  function isPdfUrl(u) {
    if (!u) return false;
    return (
      /\.pdf($|[?#])/i.test(u) ||
      /^data:application\/pdf/i.test(u) ||
      (/^file:/i.test(u) && /\.pdf($|[?#])/i.test(u))
    );
  }
  async function refreshPdfInfo() {
    pdfTarget = null;
    els.pdfBanner.style.display = 'none';
    if (!activeTab) return;
    const topUrl = activeTab.url || '';
    if (isPdfUrl(topUrl)) {
      pdfTarget = { url: topUrl, tabId: activeTab.id };
      els.pdfBannerText.textContent = 'This tab is a PDF — read it out loud in the reader';
    } else {
      const probe = await sendMsg({ type: 'ttsr-pdf-probe' });
      if (probe && probe.ok && probe.pdfUrls && probe.pdfUrls.length) {
        pdfTarget = { url: probe.pdfUrls[0], tabId: activeTab.id };
        els.pdfBannerText.textContent = 'PDF found on this page — read it out loud in the reader';
      }
    }
    if (pdfTarget) els.pdfBanner.style.display = 'flex';
  }

  async function loadPrefs() {
    const s = await api.storage.local.get(['ttsr_engine', 'ttsr_speed', 'ttsr_pitch', 'ttsr_voice']);
    if (s.ttsr_engine) prefs.engine = s.ttsr_engine;
    else prefs.engine = 'gfree';
    if (typeof s.ttsr_speed === 'number') prefs.speed = s.ttsr_speed;
    if (typeof s.ttsr_pitch === 'number') prefs.pitch = s.ttsr_pitch;
    if (typeof s.ttsr_voice === 'string') prefs.voice = s.ttsr_voice;

    els.engine.value = prefs.engine;
    els.rate.value = String(prefs.speed);
    els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
    els.pitch.value = String(prefs.pitch);
    els.pitchVal.textContent = prefs.pitch.toFixed(1);
    els.voice.value = prefs.voice || '';  // initialize hidden input
  }
  function savePrefs() {
    api.storage.local.set({
      ttsr_engine: prefs.engine, ttsr_speed: prefs.speed,
      ttsr_pitch: prefs.pitch, ttsr_voice: prefs.voice,
    });
  }

  // ------------------------------------------------------------
  // Voice loading per engine
  // ------------------------------------------------------------
  // Quality heuristics for OS/browser voices. Server-side natural/neural
  // voices (Edge "Natural", Chrome "Google …", Apple Premium/Enhanced) sound
  // far better than local defaults (eSpeak, speech-dispatcher, macOS
  // "Compact"), so rank them up, sort the picker best-first, and auto-select
  // the top one when the user hasn't picked a voice.
  function systemVoiceRank(v) {
    const n = String(v.name || '');
    let r = 0;
    if (/natural|neural/i.test(n)) r += 100;
    if (/^Google /.test(n)) r += 80;
    if (/premium/i.test(n)) r += 70;
    if (/enhanced/i.test(n)) r += 60;
    if (v.localService === false) r += 15;
    if (/espeak|festival|flite|pico|compact|speech.?dispatcher/i.test(n)) r -= 100;
    return r;
  }
  function isQualitySystemVoice(v) { return systemVoiceRank(v) >= 60; }
  function rankCloud(v) {
    let r = 0;
    if (/^en-IN/i.test(v.lang || v.name)) r += 500;
    if (/Neural2|Wavenet|Journey/i.test(v.name)) r += 50;
    if (v.gender === 'FEMALE') r += 10;
    return r;
  }

  async function loadGCloudVoices() {
    if (gcloudVoices) return gcloudVoices;
    const res = await bgSend({ type: 'ttsr-gcloud-list-voices' });
    if (!res || !res.ok || !res.voices) return null;
    res.voices.sort((a, b) => rankCloud(b) - rankCloud(a));
    gcloudVoices = res.voices;
    return gcloudVoices;
  }

  async function loadPiperModels() {
    if (piperModels) return piperModels;
    const res = await bgSend({ type: 'ttsr-piper-list-models' });
    piperModels = (res && res.ok && res.models) ? res.models : [];
    return piperModels;
  }

  async function rebuildVoiceList() {
    const engine = prefs.engine;
    const query = (els.voiceSearch.value || '').trim().toLowerCase();
    voiceList = [];

    if (engine === 'gcloud') {
      const vs = await loadGCloudVoices();
      if (vs) {
        vs.forEach((v) => voiceList.push({
          id: v.name,
          label: v.name + ' (' + (v.lang || '') + (v.gender ? ' ' + v.gender[0] : '') + ')',
          meta: ((v.lang || '') + ' ' + v.gender).toLowerCase(),
        }));
      }
    } else if (engine === 'gfree' || engine === 'system') {
      // System engine: real browser voices. Free engine: lang codes.
      if (engine === 'gfree') {
        [
          { id: 'en', label: 'English (Google Free — neutral US-ish)' },
          { id: 'en-IN', label: 'English (India) — Google Free' },
          { id: 'en-GB', label: 'English (UK) — Google Free' },
          { id: 'hi', label: 'Hindi — Google Free' },
          { id: 'hi-IN', label: 'Hindi (India) — Google Free' },
          { id: 'ta', label: 'Tamil — Google Free' },
          { id: 'te', label: 'Telugu — Google Free' },
          { id: 'mr', label: 'Marathi — Google Free' },
          { id: 'bn', label: 'Bengali — Google Free' },
        ].forEach((o) => voiceList.push({ id: o.id, label: o.label, meta: o.label.toLowerCase() }));
      } else {
        let vs = speechSynthesis.getVoices() || [];
        const eng = vs.filter((v) => /^en/i.test(v.lang));
        const pool = (eng.length ? eng : vs).slice()
          .sort((a, b) => systemVoiceRank(b) - systemVoiceRank(a) || a.name.localeCompare(b.name));
        pool.forEach((v) => voiceList.push({
          id: v.name,
          label: v.name + (isQualitySystemVoice(v) ? ' ★' : '') + ' (' + v.lang + ')',
          meta: (v.name + ' ' + v.lang).toLowerCase(),
        }));
        // First run with no saved voice: pick the best-sounding voice instead
        // of leaving the OS default (often a robotic eSpeak voice).
        if (!prefs.voice && voiceList.length) {
          prefs.voice = voiceList[0].id;
          els.voice.value = prefs.voice;
          savePrefs();
        }
      }
    } else if (engine === 'piper') {
      const ms = await loadPiperModels();
      (ms || []).forEach((m) => voiceList.push({
        id: typeof m === 'string' ? m : (m.id || m.name || String(m)),
        label: typeof m === 'string' ? m : (m.label || m.name || String(m)),
        meta: (typeof m === 'string' ? m : JSON.stringify(m)).toLowerCase(),
      }));
    }

    renderVoiceSelect(query);
    updateEngineHints();
  }

  function renderVoiceSelect(query) {
    const filtered = query
      ? voiceList.filter((v) => v.label.toLowerCase().includes(query) || v.meta.includes(query))
      : voiceList;

    // Update datalist options only - do NOT touch search input
    els.voiceList.innerHTML = '';
    if (!filtered.length && voiceList.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.label = '— no voice matches filter —';
      opt.disabled = true;
      els.voiceList.appendChild(opt);
      els.voiceHint.textContent = voiceList.length + ' voices, 0 match';
      return;
    }
    if (!voiceList.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.label = buildEmptyMessage();
      opt.disabled = true;
      els.voiceList.appendChild(opt);
      els.voiceHint.textContent = 'no voices';
      return;
    }

    filtered.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.label = v.label;
      els.voiceList.appendChild(opt);
    });

    els.voiceHint.textContent = filtered.length + ' / ' + voiceList.length + ' voices';
  }

  function buildEmptyMessage() {
    if (prefs.engine === 'gcloud') return '— add a Google Cloud key in Advanced, then reopen —';
    if (prefs.engine === 'piper') return '— install the Piper host (PIPSetUp), restart browser —';
    return '— no system voices — install espeak-ng / speech-dispatcher —';
  }

  function updateEngineHints() {
    els.gcloudKeyField.style.display = (prefs.engine === 'gcloud') ? 'block' : 'none';
    els.piperHelp.style.display = (prefs.engine === 'piper') ? 'block' : 'none';

    // Also show a brief note in advanced for the current engine
    if (prefs.engine === 'gfree') {
      els.piperHelp.style.display = 'block';
      els.piperHelp.textContent = 'Google Free: no key needed. Indian English (en-IN) works. Character limit per request ~200 — longer sentences are auto-chunked. If audio cuts off, it may be rate-limited.';
    } else if (prefs.engine === 'gcloud') {
      els.piperHelp.style.display = 'none';
    } else if (prefs.engine === 'piper') {
      els.piperHelp.style.display = 'block';
      els.piperHelp.textContent = 'Piper needs a native-messaging host — see PIPER_SETUP.md.';
    } else {
      els.piperHelp.style.display = 'none';
    }

    // pitch/rate applicability hints
    if (prefs.engine === 'gfree') {
      els.pitchVal.textContent = 'n/a';
      els.rateVal.textContent = 'n/a';
    } else {
      els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
      els.pitchVal.textContent = prefs.pitch.toFixed(1);
    }
  }

  // ------------------------------------------------------------
  // status polling
  // ------------------------------------------------------------
  async function refreshStatus() {
    const res = await sendMsg({ type: 'ttsr-status' });
    if (!res) {
      // Content script unreachable. If the tab is itself a PDF or one of our
      // reader pages, that's expected — point at the PDF banner instead of
      // claiming the page is broken.
      const tabUrl = (activeTab && activeTab.url) || '';
      const isReaderPage = tabUrl.indexOf(api.runtime.getURL('')) === 0;
      if (isPdfUrl(tabUrl) || isReaderPage) {
        hideError();
        els.status.textContent = 'no readable web page here — use the PDF reader or open a novel page';
        return;
      }
      showError("Can't reach this page — reload the tab, then reopen this popup.");
      return;
    }
    hideError();
    els.playPause.textContent = (res.isPlaying && !res.isPaused) ? '⏸ Pause' : '▶ Play';
    els.status.textContent = res.total
      ? 'sentence ' + (res.currentIndex + 1) + ' / ' + res.total
      : 'not started — press play to detect and read this page';
  }

  // ------------------------------------------------------------
  // events
  // ------------------------------------------------------------
  els.playPause.addEventListener('click', async () => {
    const st = await sendMsg({ type: 'ttsr-status' });
    if (st && st.isPlaying && !st.isPaused) {
      await sendMsg({ type: 'ttsr-pause' });
    } else {
      const res = await sendMsg({
        type: 'ttsr-play',
        engine: prefs.engine,
        voice: prefs.voice,
        speed: prefs.speed,
        pitch: prefs.pitch,
      });
      if (res && res.ok === false && res.reason === 'no-content') {
        showError("Couldn't find readable text on this page.");
      }
    }
    refreshStatus();
  });

  els.stop.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-stop' }); refreshStatus(); });
  els.prev.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-prev' }); refreshStatus(); });
  els.next.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-next' }); refreshStatus(); });

  els.pdfOpen.addEventListener('click', async () => {
    if (!pdfTarget) return;
    const q = new URLSearchParams({ src: pdfTarget.url, tab: String(pdfTarget.tabId || '') });
    const reader = api.runtime.getURL('pdfviewer.html?' + q.toString());
    await api.tabs.create({ url: reader });
  });

  els.rate.addEventListener('input', () => {
    prefs.speed = parseFloat(els.rate.value);
    els.rateVal.textContent = prefs.engine === 'gfree' ? 'n/a' : prefs.speed.toFixed(1) + 'x';
    savePrefs();
  });
  els.pitch.addEventListener('input', () => {
    prefs.pitch = parseFloat(els.pitch.value);
    els.pitchVal.textContent = prefs.engine === 'gfree' ? 'n/a' : prefs.pitch.toFixed(1);
    savePrefs();
  });

  els.engine.addEventListener('change', () => {
    prefs.engine = els.engine.value;
    prefs.voice = ''; // reset; each engine has different voice ids
    savePrefs();
    rebuildVoiceList();
  });

  // When user selects from datalist, the text input holds the label.
  // Map it back to the voice id, stash in hidden #voice, save prefs.
  // 'change' catches datalist selection (blur/Enter). 'input' only filters.
  function commitVoiceSelection() {
    const typed = els.voiceSearch.value;
    const match = voiceList.find((v) => v.label === typed || v.id === typed);
    const id = match ? match.id : '';
    if (id) {
      els.voice.value = id;
      prefs.voice = id;
      savePrefs();
    }
  }
  els.voiceSearch.addEventListener('input', () => {
    // Only filter - do NOT auto-commit on input (prevents backspace issues)
    renderVoiceSelect((els.voiceSearch.value || '').trim().toLowerCase());
  });
  els.voiceSearch.addEventListener('change', commitVoiceSelection);

  els.gcloudSave.addEventListener('click', async () => {
    const k = els.gcloudKey.value.trim();
    if (!k) { els.gcloudKeyStatus.textContent = 'paste a key first'; els.gcloudKeyStatus.className = 'value bad'; return; }
    els.gcloudKeyStatus.textContent = 'testing…'; els.gcloudKeyStatus.className = 'value';
    await api.storage.local.set({ ttsr_gcloud_key: k });
    const res = await bgSend({ type: 'ttsr-gcloud-ping' });
    if (res && res.ok) {
      els.gcloudKeyStatus.textContent = '✓ key works'; els.gcloudKeyStatus.className = 'value ok';
      gcloudVoices = null; // force re-fetch
      if (prefs.engine === 'gcloud') rebuildVoiceList();
    } else {
      els.gcloudKeyStatus.textContent = '✗ ' + ((res && res.error) || 'failed');
      els.gcloudKeyStatus.className = 'value bad';
    }
  });

  // Native voices may arrive async.
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.onvoiceschanged = () => { if (prefs.engine === 'system') rebuildVoiceList(); };
  }

  async function init() {
    try {
      const tab = await getActiveTab();
      if (!tab) { showError('No active tab found.'); return; }
      activeTabId = tab.id;
      activeTab = tab;
      await loadPrefs();
      await rebuildVoiceList();
      // Sync search input to show selected voice on reopen
      const val = prefs.voice;
      if (val) {
        const match = voiceList.find(v => v.id === val);
        if (match) els.voiceSearch.value = match.label;
      }
      await refreshStatus();
      await refreshPdfInfo();
      statusTimer = setInterval(refreshStatus, 1000);
    } catch (e) {
      showError('Failed to initialize — reopen popup to retry.');
    }
  }
  init();

  window.addEventListener('unload', () => { if (statusTimer) clearInterval(statusTimer); });
})();
