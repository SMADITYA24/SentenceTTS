// PDF reader page for SentenceTTS. Extracts text from a PDF with pdf.js and
// renders it into an <article> that the SAME content.js engine already injected
// on this page drives — sentence wraps, highlighting, auto-scroll, the
// persistent on-page player and all four TTS engines all come from content.js.
// This page only: loads the PDF bytes, extracts text into paragraph blocks
// (one per <p>, tagged with their source page), renders a page canvas, and
// brokers controls to content.js via the `ttsr-cmd` event bridge.
import * as pdfjsLib from './pdf/pdf.mjs';

const api = typeof browser !== 'undefined' ? browser : chrome;
pdfjsLib.GlobalWorkerOptions.workerSrc = api.runtime.getURL('pdf/pdf.worker.mjs');

const params = new URLSearchParams(location.search);
const srcUrl = params.get('src') || '';
const originTabId = params.get('tab') || null;

const els = {
  loading: document.getElementById('loading'),
  loadingMsg: document.getElementById('loading-msg'),
  pickLocal: document.getElementById('pick-local'),
  pickWhy: document.querySelector('#pick-local .why'),
  pickBtn: document.getElementById('pick-btn'),
  pickInput: document.getElementById('pick-input'),
  title: document.getElementById('title'),
  engine: document.getElementById('engine'),
  voiceSearch: document.getElementById('voice-search'),
  voiceList: document.getElementById('voice-list'),
  rate: document.getElementById('rate'),
  rateVal: document.getElementById('rate-val'),
  pitch: document.getElementById('pitch'),
  pitchVal: document.getElementById('pitch-val'),
  playPause: document.getElementById('play-pause'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  stop: document.getElementById('stop'),
  status: document.getElementById('pdf-status'),
  canvasWrap: document.getElementById('canvas-wrap'),
  canvas: document.getElementById('page-canvas'),
  pageLabel: document.getElementById('pdf-page-label'),
  pagePrev: document.getElementById('page-prev'),
  pageNext: document.getElementById('page-next'),
  canvasToggle: document.getElementById('canvas-toggle'),
  article: document.getElementById('ttsr-pdf-text'),
};

const prefs = { engine: 'gfree', speed: 1, pitch: 1, voice: '' };

// ---- TTS settings (shared with the popup via storage.local) --------------
async function loadPrefs() {
  const s = await api.storage.local.get(['ttsr_engine', 'ttsr_speed', 'ttsr_pitch', 'ttsr_voice']);
  if (s.ttsr_engine) prefs.engine = s.ttsr_engine;
  if (typeof s.ttsr_speed === 'number') prefs.speed = s.ttsr_speed;
  if (typeof s.ttsr_pitch === 'number') prefs.pitch = s.ttsr_pitch;
  if (typeof s.ttsr_voice === 'string') prefs.voice = s.ttsr_voice;
  els.engine.value = prefs.engine;
  els.rate.value = String(prefs.speed);
  els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
  els.pitch.value = String(prefs.pitch);
  els.pitchVal.textContent = prefs.pitch.toFixed(1);
}
function savePrefs() {
  api.storage.local.set({
    ttsr_engine: prefs.engine, ttsr_speed: prefs.speed,
    ttsr_pitch: prefs.pitch, ttsr_voice: prefs.voice,
  });
}

let voiceRows = [];
async function rebuildVoices() {
  voiceRows = [];
  const engine = prefs.engine;
  const q = (els.voiceSearch.value || '').trim().toLowerCase();
  if (engine === 'gfree') {
    [
      { id: 'en', label: 'English (Google Free)' },
      { id: 'en-IN', label: 'English (India) — Google Free' },
      { id: 'en-GB', label: 'English (UK) — Google Free' },
      { id: 'hi', label: 'Hindi — Google Free' },
      { id: 'hi-IN', label: 'Hindi (India) — Google Free' },
      { id: 'ta', label: 'Tamil — Google Free' },
      { id: 'te', label: 'Telugu — Google Free' },
      { id: 'mr', label: 'Marathi — Google Free' },
      { id: 'bn', label: 'Bengali — Google Free' },
    ].forEach((o) => voiceRows.push({ id: o.id, label: o.label }));
  } else if (engine === 'gcloud') {
    try {
      const res = await api.runtime.sendMessage({ type: 'ttsr-gcloud-list-voices' });
      if (res && res.ok && res.voices) {
        res.voices.forEach((v) => voiceRows.push({ id: v.name, label: v.name + ' (' + (v.lang || '') + ')' }));
      }
    } catch (e) {}
  } else if (engine === 'piper') {
    try {
      const res = await api.runtime.sendMessage({ type: 'ttsr-piper-list-models' });
      if (res && res.ok && res.models) {
        res.models.forEach((m) => {
          const id = typeof m === 'string' ? m : (m.id || m.name || String(m));
          voiceRows.push({ id, label: typeof m === 'string' ? m : (m.label || m.name || String(m)) });
        });
      }
    } catch (e) {}
  } else {
    const vs = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices()) || [];
    const eng = vs.filter((v) => /^en/i.test(v.lang));
    (eng.length ? eng : vs).forEach((v) => voiceRows.push({ id: v.name, label: v.name + ' (' + v.lang + ')' }));
  }
  els.voiceList.innerHTML = '';
  voiceRows.filter((v) => !q || v.label.toLowerCase().includes(q) || v.id.toLowerCase().includes(q))
    .forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.label = v.label;
      els.voiceList.appendChild(opt);
    });
  const cur = voiceRows.find((v) => v.id === prefs.voice);
  if (cur) els.voiceSearch.value = cur.label;
}

els.engine.addEventListener('change', () => {
  prefs.engine = els.engine.value;
  prefs.voice = '';
  savePrefs();
  rebuildVoices();
});
els.rate.addEventListener('input', () => {
  prefs.speed = parseFloat(els.rate.value);
  els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
  savePrefs();
});
els.pitch.addEventListener('input', () => {
  prefs.pitch = parseFloat(els.pitch.value);
  els.pitchVal.textContent = prefs.pitch.toFixed(1);
  savePrefs();
});
els.voiceSearch.addEventListener('input', () => rebuildVoices());
els.voiceSearch.addEventListener('change', () => {
  const typed = els.voiceSearch.value;
  const match = voiceRows.find((v) => v.label === typed || v.id === typed);
  if (match) { prefs.voice = match.id; savePrefs(); }
});

// ---- Driving content.js (same page, event-bridged) -----------------------
function dispatchCmd(type, extra) {
  window.dispatchEvent(new CustomEvent('ttsr-cmd', { detail: Object.assign({ type }, extra || {}) }));
}
let playState = 'stopped'; // 'playing' | 'paused' | 'stopped' — mirrors content.js
function playWithCurrentPrefs() {
  dispatchCmd('play', {
    engine: prefs.engine, voice: prefs.voice,
    speed: prefs.speed, pitch: prefs.pitch,
  });
}

// ---- PDF loading + text extraction ---------------------------------------

// Sentence splitting identical to content.js — only used to precompute a
// sentence→page map so the canvas flips pages as reading advances.
function countSentencesPerBlock(text) {
  const n = text.replace(/\s+/g, ' ').trim();
  if (!n) return 0;
  let count = 0;
  let start = 0;
  const re = /[.!?]+(?:["'”’)\]]+)?(?=\s|$)/g;
  let m;
  while ((m = re.exec(n)) !== null) {
    const end = m.index + m[0].length;
    const precedingDigits = n.slice(0, m.index).match(/(\d{1,2})$/);
    const isListMarker = m[0].replace(/["'”’)\]]+$/, '') === '.' && precedingDigits;
    if (isListMarker) continue;
    count += 1;
    start = end;
  }
  if (start < n.length) count += 1;
  return count;
}

async function obtainPdfBytes(url) {
  const res = await api.runtime.sendMessage({ type: 'ttsr-pdf-fetch', url, originTabId });
  if (!res || !res.ok) throw new Error((res && res.error) || 'failed to fetch the PDF');
  return res.data;
}

// Retry path for local PDFs if the reader page (not the event page) can fetch
// them directly — some Firefox setups allow one context and not the other.
async function fetchFromPage(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching PDF');
  return resp.arrayBuffer();
}

function titleFromUrl(url) {
  if (/^data:application\/pdf/i.test(url)) return 'PDF from this page';
  if (/^blob:/i.test(url)) return 'PDF from this page';
  if (/^file:/i.test(url)) {
    try {
      const u = new URL(url);
      const name = decodeURIComponent((u.pathname || '').replace(/\/+$/, '').split('/').pop() || '');
      return name || 'local PDF';
    } catch (e) { return 'local PDF'; }
  }
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last);
  } catch (e) { return url; }
}

function isLocalScheme(url) {
  return /^(file:|data:application\/pdf|blob:)/i.test(url);
}

async function extractParagraphs(pdf) {
  const blocks = []; // { text, page }
  for (let p = 1; p <= pdf.numPages; p++) {
    let page;
    try { page = await pdf.getPage(p); } catch (e) { continue; }
    try {
      const tc = await page.getTextContent({ normalizeWhitespace: true });
      const items = tc.items || [];
      const lines = [];
      let cur = '';
      for (const it of items) {
        const s = (it.str || '');
        if (!s) continue;
        cur += s;
        if (it.hasEOL) { lines.push(cur); cur = ''; }
      }
      if (cur.trim()) lines.push(cur);
      // Group consecutive non-empty lines into paragraphs.
      let para = [];
      lines.forEach((line) => {
        const t = line.trim();
        if (!t) { if (para.length) { blocks.push({ text: para.join(' ').trim(), page: p }); para = []; } }
        else para.push(t);
      });
      if (para.length) blocks.push({ text: para.join(' ').trim(), page: p });
    } catch (e) {
      // skip unreadable page
    } finally {
      try { page.cleanup(); } catch (e) {}
    }
  }
  return blocks.filter((b) => b.text && b.text.length > 1);
}

// ---- Page canvas ---------------------------------------------------------
let pdfDoc = null;
let numPages = 0;
let pageBlocks = [];       // { text, page } in DOM order
let pageRuns = [];         // [{ count, page }] run of sentences per transcript block (incl. title)
let canvasVisible = true;
let currentRenderedPage = 0;
let renderQueue = Promise.resolve();

function pageForSentence(globalIndex) {
  let acc = 0;
  for (const run of pageRuns) {
    if (globalIndex < acc + run.count) return run.page;
    acc += run.count;
  }
  return pageRuns.length ? pageRuns[pageRuns.length - 1].page : 1;
}
function firstSentenceIndexForPage(page) {
  let acc = 0;
  for (const run of pageRuns) {
    if (run.page === page) return acc;
    acc += run.count;
  }
  return 0;
}

async function renderPage(n) {
  if (!pdfDoc || n < 1 || n > numPages) return;
  currentRenderedPage = n;
  els.pageLabel.textContent = n + ' / ' + numPages;
  try {
    const page = await pdfDoc.getPage(n);
    const base = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: 1.35 * base });
    els.canvas.width = viewport.width;
    els.canvas.height = viewport.height;
    const ctx = els.canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    const task = page.render({ canvasContext: ctx, viewport });
    await task.promise;
    page.cleanup();
  } catch (e) {}
}

function schedulePage(n) {
  renderQueue = renderQueue.then(() => renderPage(n)).catch(() => {});
}

// Render the page shown at top of the stage, once
setTimeout(() => { if (canvasVisible && currentRenderedPage === 0 && numPages) schedulePage(1); }, 600);

// ---- Event hooks from content.js -----------------------------------------
window.addEventListener('ttsr-index-changed', (e) => {
  const idx = (e.detail && e.detail.index) || 0;
  const page = pageForSentence(idx);
  if (canvasVisible && page !== currentRenderedPage) schedulePage(page);
});
window.addEventListener('ttsr-status-changed', (e) => {
  const d = e.detail || {};
  playState = (d.isPlaying && !d.isPaused) ? 'playing' : (d.isPlaying ? 'paused' : 'stopped');
  els.playPause.textContent = playState === 'playing' ? '⏸ Pause' : '▶ Play';
  if (d.isPlaying) {
    const page = pageForSentence(d.currentIndex || 0);
    els.status.textContent = 'sentence ' + ((d.currentIndex || 0) + 1) + ' / ' + (d.total || 0) + ' · page ' + page + ' / ' + numPages;
  } else {
    els.status.textContent = d.total
      ? 'sentence ' + ((d.currentIndex || 0) + 1) + ' / ' + (d.total || 0)
      : '— press Play to read this PDF';
  }
});
window.addEventListener('ttsr-end', () => {
  playState = 'stopped';
  els.playPause.textContent = '▶ Play';
  els.status.textContent = 'finished — press Play to read again';
});

// ---- Transport -----------------------------------------------------------
els.playPause.addEventListener('click', () => {
  if (playState === 'playing') dispatchCmd('pause');
  else if (playState === 'paused') dispatchCmd('resume');
  else playWithCurrentPrefs();
});
els.prev.addEventListener('click', () => dispatchCmd('prev'));
els.next.addEventListener('click', () => dispatchCmd('next'));
els.stop.addEventListener('click', () => dispatchCmd('stop'));
els.pagePrev.addEventListener('click', () => {
  const d = currentRenderedPage > 1 ? currentRenderedPage - 1 : 1;
  dispatchCmd('jump', { index: firstSentenceIndexForPage(d) });
});
els.pageNext.addEventListener('click', () => {
  const d = currentRenderedPage < numPages ? currentRenderedPage + 1 : numPages;
  dispatchCmd('jump', { index: firstSentenceIndexForPage(d) });
});
els.canvasToggle.addEventListener('click', () => {
  canvasVisible = !canvasVisible;
  els.canvasWrap.style.display = canvasVisible ? 'flex' : 'none';
  els.canvasToggle.textContent = canvasVisible ? '☰ hide page' : '☰ show page';
  if (canvasVisible && currentRenderedPage === 0 && numPages) schedulePage(1);
});

// ---- Boot ----------------------------------------------------------------
// Everything after the bytes arrive: parse with pdf.js, extract paragraphs,
// build the transcript for content.js, then reveal the reader UI.
async function openPdf(bytes, title) {
  if (!bytes || !bytes.byteLength) throw new Error('The PDF appears to be empty.');

  const data = new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({ data, isEvalSupported: false });
  pdfDoc = await task.promise;
  numPages = pdfDoc.numPages;

  els.loadingMsg.textContent = 'Extracting text from ' + numPages + ' pages…';
  pageBlocks = await extractParagraphs(pdfDoc);
  if (!pageBlocks.length) {
    throw new Error('No selectable text found — this PDF may be a scanned / image-only document.');
  }

  // Build the transcript DOM that content.js will wrap into sentences.
  // The <h1> is content.js block #0 too, so its sentence run is recorded in
  // pageRuns[0] to keep the sentence→page map aligned.
  const frag = document.createDocumentFragment();
  const h = document.createElement('h1');
  h.textContent = title;
  frag.appendChild(h);
  pageRuns.push({ count: countSentencesPerBlock(title), page: 1 });
  pageBlocks.forEach((b) => {
    const p = document.createElement('p');
    p.dataset.page = String(b.page);
    p.textContent = b.text;
    frag.appendChild(p);
    pageRuns.push({ count: countSentencesPerBlock(b.text), page: b.page });
  });
  els.article.appendChild(frag);

  els.status.textContent = numPages + ' pages · ' + pageBlocks.length + ' paragraphs — press Play';
  els.loading.classList.add('hidden');
  els.canvasWrap.style.display = canvasVisible ? 'flex' : 'none';

  // content.js (loaded on this page) prepares content lazily inside
  // startReading, so a single Play press is all that's needed. No
  // auto-play here: browsers block audio without a user gesture, and the
  // "Read this PDF" click already happened in another tab.
  els.playPause.focus();
}

// Zero-permission fallback for local PDFs (file:/data:/blob:) when Firefox
// won't give the page direct access — let the user pick or drop the file.
function showPickLocal(reason) {
  els.loading.classList.remove('error');
  els.loadingMsg.textContent = 'Choose a PDF file to read';
  els.pickWhy.textContent = reason || '';
  els.pickLocal.hidden = false;
  els.loading.style.display = 'flex';
}

// Show the picker overlay for local PDFs that Firefox won't let the page fetch.
// Firefox MV3 blocks fetch() to file:// from both the event page and extension
// pages even with the file-access toggle on, so the picker is the reliable
// path for local files. We do NOT auto-open the dialog here: calling
// input.click() without a user gesture ("lack of user activation") is silently
// blocked by Firefox. The visible "Choose the PDF file…" button is the real
// gesture and opens the dialog reliably every time.
function startPickLocal(reason) {
  showPickLocal(reason);
  if (els.playPause) els.playPause.disabled = true;
}

function handleFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    els.loadingMsg.textContent = '⚠ "' + file.name + '" doesn\'t look like a PDF — choose a .pdf file.';
    return;
  }
  els.loadingMsg.textContent = 'Reading ' + file.name + '…';
  document.title = 'SentenceTTS — ' + file.name;
  els.title.textContent = file.name;
  const reader = new FileReader();
  reader.onerror = () => {
    els.loadingMsg.textContent = '⚠ Could not read that file.';
  };
  reader.onload = () => {
    openPdf(reader.result, file.name.replace(/\.pdf$/i, '') || 'PDF')
      .catch((err) => {
        els.loading.classList.add('error');
        els.loadingMsg.textContent = '⚠ ' + ((err && err.message) || err);
      });
  };
  reader.readAsArrayBuffer(file);
}

function onLoadError(err) {
  els.loading.classList.add('error');
  const msg = '⚠ ' + ((err && err.message) || 'Could not open this PDF.');
  els.loadingMsg.textContent = msg;
  if (!srcUrl || isLocalScheme(srcUrl)) {
    showPickLocal(
      'No permissions needed for this — just pick the file:'
    );
  }
  els.loading.style.display = 'flex';
}

els.pickBtn.addEventListener('click', () => els.pickInput.click());
els.pickInput.addEventListener('change', () => {
  const f = els.pickInput.files && els.pickInput.files[0];
  els.pickInput.value = '';
  if (f) handleFile(f);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

(async function boot() {
  try {
    await loadPrefs();
    await rebuildVoices();
    const title = titleFromUrl(srcUrl);
    document.title = 'SentenceTTS — ' + title;
    els.title.textContent = title;

    if (!srcUrl) {
      showPickLocal('Open this reader from the extension popup on a PDF page, or pick a PDF below:');
      return;
    }
    let bytes;
    if (/^file:/i.test(srcUrl)) {
      // Firefox MV3 blocks fetch() to file:// from the background/event page
      // AND extension pages regardless of the "Allow access to file URLs"
      // toggle. Try a direct page fetch first (works on some setups); if that
      // fails, fall back to the zero-permission file picker.
      try {
        bytes = await fetchFromPage(srcUrl);
      } catch (e) {
        startPickLocal(
          'This browser blocks extensions from reading local files directly. ' +
          'Just pick the file (no extra permissions needed):'
        );
        return;
      }
    } else {
      bytes = await obtainPdfBytes(srcUrl);
    }
    await openPdf(bytes, title);
  } catch (e) {
    onLoadError(e);
  }
})();