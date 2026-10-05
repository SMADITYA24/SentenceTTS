(function () {
  'use strict';

  try {
    if (window.__ttsrInjected) return;
    window.__ttsrInjected = true;

    const api = typeof browser !== 'undefined' ? browser : chrome;

    const SENTENCE_CLASS = 'ttsr-sentence';
    const HIGHLIGHT_CLASS = 'ttsr-highlight';

    // engine: 'system' | 'gcloud' | 'gfree' | 'piper'
    // For 'system',   "voice"  = SpeechSynthesisVoice name
    // For 'gcloud',    "voice"  = Google voice name, e.g. "en-IN-Neural2-D"
    // For 'gfree',     "voice"  = language code for tl=, e.g. "en" or "en-IN"
    // For 'piper',     "voice"  = .onnx model id
    const STATE = {
      sentences: [],
      currentIndex: -1,
      isPlaying: false,
      isPaused: false,
      prepared: false,
      engine: 'system',
      speed: 1,
      pitch: 1,
      voice: '',
      // audio-element playback (used by gcloud/gfree/piper)
      audioEl: null,
      gen: 0,            // invalidates stale async chains on skip/stop/jump
      // SpeechSynthesis handles (system)
      utterance: null,
    };

    // Small audio cache so back/forward/skip don't re-synthesize.
    const audioCache = new Map(); // index -> ArrayBuffer[]
    const CACHE_LIMIT = 40; // holds a deep prefetch window without eviction churn
    const prefetching = new Set(); // indices with a synthesis request in flight

    // --- Playback session persistence ------------------------------------
    // Survives same-tab reloads (sessionStorage), so a site that
    // auto-refreshes mid-read resumes where it left off. The timestamp
    // window means a tab that sat cached for hours re-splits fresh content
    // instead of auto-resuming stale text.
    const SESSION_KEY = 'ttsr_session';
    const AUTO_RESUME_MS = 5 * 60 * 1000; // 5 minutes of "recent enough to auto-resume"

    function readSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) { return null; }
    }
    function writeSession(patch) {
      try {
        const prev = readSession() || {};
        const next = Object.assign({}, prev, patch, { ts: Date.now() });
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      } catch (e) { /* private mode etc. — non-fatal */ }
    }
    function clearSession() {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    // --- On-page persistent mini-player -----------------------------------
    // Firefox dismisses toolbar popups whenever the page regains focus, so
    // playback controls must live on the page to survive through a whole
    // read. This bar is shown while playing and removed on stop/end.
    let playerEl = null;
    const PLAYER_ACTIONS = ['prev', 'toggle', 'next', 'stop'];
    function ensurePlayer() {
      if (playerEl && playerEl.isConnected) return playerEl;
      const bar = document.createElement('div');
      bar.id = 'ttsr-player';
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'SentenceTTS playback controls');
      // Inline fallback styles; full styles live in content.css.
      bar.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:16px', 'z-index:2147483647',
        'transform:translateX(-50%)', 'display:none',
        'align-items:center', 'gap:4px',
        'padding:6px 12px', 'border-radius:999px',
        'box-shadow:0 4px 18px rgba(0,0,0,0.4)',
      ].join(';');
      bar.innerHTML =
        '<button data-act="prev" title="Previous sentence" aria-label="Previous sentence">⏮</button>' +
        '<button data-act="toggle" class="ttsr-toggle" aria-label="Pause or resume">⏸</button>' +
        '<button data-act="next" title="Next sentence" aria-label="Next sentence">⏭</button>' +
        '<button data-act="stop" class="ttsr-stop" title="Stop" aria-label="Stop">■</button>' +
        '<span class="ttsr-player-status" aria-live="polite"></span>';
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('button');
        const act = btn && btn.dataset.act;
        if (!act || PLAYER_ACTIONS.indexOf(act) === -1) return;
        if (act === 'prev') { skip(-1); }
        else if (act === 'next') { skip(1); }
        else if (act === 'stop') { stopReading(); }
        else if (act === 'toggle') {
          if (STATE.isPlaying && !STATE.isPaused) pauseReading();
          else if (STATE.isPlaying && STATE.isPaused) resumeReading();
          else if (STATE.currentIndex >= 0) startReading(STATE.currentIndex);
        }
      });
      (document.body || document.documentElement).appendChild(bar);
      playerEl = bar;
      return bar;
    }
    function showPlayer() {
      const bar = ensurePlayer();
      bar.style.display = 'inline-flex';
      updatePlayer();
    }
    function hidePlayer() {
      if (playerEl && playerEl.isConnected) playerEl.style.display = 'none';
    }
    function updatePlayer() {
      emitStatus();
      if (!playerEl || !playerEl.isConnected) return;
      const toggle = playerEl.querySelector('[data-act="toggle"]');
      const status = playerEl.querySelector('.ttsr-player-status');
      if (toggle) {
        toggle.textContent = STATE.isPaused ? '▶' : '⏸';
        toggle.title = STATE.isPaused ? 'Resume' : 'Pause';
        toggle.setAttribute('aria-label', STATE.isPaused ? 'Resume' : 'Pause');
      }
      if (status) {
        const n = STATE.sentences.length ? (STATE.currentIndex + 1) : 0;
        const paused = STATE.isPaused ? ' (paused)' : '';
        status.textContent = 'sentence ' + n + ' / ' + STATE.sentences.length + paused;
      }
    }

    // --- Message/status events (used by pdfviewer page) -------------------
    function emitStatus() {
      try {
        window.dispatchEvent(new CustomEvent('ttsr-status-changed', {
          detail: {
            isPlaying: STATE.isPlaying,
            isPaused: STATE.isPaused,
            currentIndex: STATE.currentIndex,
            total: STATE.sentences.length,
            engine: STATE.engine,
          },
        }));
      } catch (e) {}
    }

    // --- On-page hiccup indicator ---
    let hiccupEl = null;
    let hiccupTimer = null;
    let hiccupCount = 0;
    function ensureHiccupEl() {
      if (hiccupEl && hiccupEl.isConnected) return hiccupEl;
      const el = document.createElement('div');
      el.id = 'ttsr-hiccup';
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'max-width:260px', 'padding:6px 12px', 'border-radius:8px',
        'font:12px/1.4 system-ui,sans-serif', 'color:#fff',
        'background:rgba(180,40,20,0.92)', 'border:1px solid rgba(255,255,255,0.25)',
        'box-shadow:0 2px 8px rgba(0,0,0,0.3)', 'pointer-events:none',
        'opacity:0', 'transform:translateY(6px)',
        'transition:opacity .2s ease, transform .2s ease',
      ].join(';');
      el.textContent = '';
      (document.body || document.documentElement).appendChild(el);
      hiccupEl = el;
      return el;
    }
    function showHiccup(msg) {
      hiccupCount += 1;
      // Persist the full message to the console so it can be copied even
      // though the on-page pill auto-hides after a few seconds. Non-fatal
      // retry notices go to warn; the final-skip / stop messages are errors.
      const isFinal = /skipped|stopped|repeated/.test(msg);
      const consoleFn = isFinal ? console.error : console.warn;
      consoleFn('[SentenceTTS] ' + msg);
      const el = ensureHiccupEl();
      el.textContent = '⚠ ' + msg + (hiccupCount > 1 ? ' (' + hiccupCount + ' so far)' : '');
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      if (hiccupTimer) clearTimeout(hiccupTimer);
      hiccupTimer = setTimeout(() => {
        if (hiccupEl) { hiccupEl.style.opacity = '0'; hiccupEl.style.transform = 'translateY(6px)'; }
      }, 4000);
    }
    function resetHiccupCount() {
      hiccupCount = 0;
      if (hiccupTimer) { clearTimeout(hiccupTimer); hiccupTimer = null; }
      if (hiccupEl) { hiccupEl.style.opacity = '0'; hiccupEl.style.transform = 'translateY(6px)'; }
    }

    // --- Circuit breaker --------------------------------------------------
    // When a page is long and the network engine is rate-limited (gfree is
    // the usual suspect), the old code kept hammering the endpoint sentence
    // after sentence. That looked like a crash/hang. After a run of
    // consecutive failures we stop cleanly instead and let the user retry.
    const MAX_CONSECUTIVE_FAILS = 8;
    let consecutiveFails = 0;
    // Bounded retries so a transient failure doesn't silently skip a sentence /
    // chunk. The counts keep total attempts per sentence small (~2) — the
    // circuit breaker still stops a genuinely dead endpoint after 8 consecutive
    // failures, it just no longer trips on a single hiccup.
    const SENTENCE_RETRIES = 1;      // extra synthesis attempts per sentence
    const SENTENCE_RETRY_DELAY_MS = 400;
    const CHUNK_RETRIES = 1;         // extra playback attempts per chunk
    const CHUNK_RETRY_DELAY_MS = 300;
    function markSynthesisOk() { consecutiveFails = 0; }
    function markSynthesisFail() {
      consecutiveFails += 1;
      if (consecutiveFails < MAX_CONSECUTIVE_FAILS) return false;
      showHiccup('stopped — repeated synthesis failures (rate-limited or offline). Press Play to retry.');
      stopReading();
      emitStatus();
      try { window.dispatchEvent(new CustomEvent('ttsr-end')); } catch (e) {}
      return true;
    }

    // --- Content change detection (for SPA/refresh/re-renders) ------------
    // Masked while we mutate the DOM ourselves; fingerprints the container so
    // ad/lazy-load churn doesn't restart the reader; when a real content swap
    // happens mid-read it re-prepares and resumes at the same spot.
    let contentObserver = null;
    let contentChangeTimer = null;
    let observerSuppressed = false;
    let observedFingerprint = null;
    let observedContainer = null;
    let lastRecoverAt = 0;

    function contentFingerprint(container) {
      try {
        const t = container.innerText || '';
        return String(t.length) + '|' + t.slice(0, 160).replace(/\s+/g, ' ').toLowerCase();
      } catch (e) { return ''; }
    }
    function significantContentChange(fp, oldFp) {
      if (!fp || !oldFp) return true;
      const a = oldFp.indexOf('|'), b = fp.indexOf('|');
      const lenOld = a > 0 ? Number(oldFp.slice(0, a)) : 0;
      const headOld = a > 0 ? oldFp.slice(a + 1) : '';
      const lenNew = b > 0 ? Number(fp.slice(0, b)) : 0;
      const headNew = b > 0 ? fp.slice(b + 1) : '';
      if (headNew && headOld && headNew.trim() !== headOld.trim()) return true;
      const growth = lenNew - lenOld;
      return growth > (0.15 * lenOld) + 200; // >15% growth or >200 chars added
    }
    // Our own on-page UI (mini-player status text, hiccup pill) mutates the
    // DOM every sentence — mutation batches caused solely by those must not
    // trigger a fingerprint pass on every sentence advance.
    function isOwnUiNode(n) {
      while (n) {
        if (n === playerEl || n === hiccupEl) return true;
        n = n.parentNode;
      }
      return false;
    }
    function observeContentChanges() {
      if (contentObserver) contentObserver.disconnect();
      contentObserver = new MutationObserver((mutations) => {
        // Deliberately NOT gated on STATE.prepared: after a reset (SPA nav,
        // stop) prepared is false, and gating here would blind the observer
        // exactly when the new content renders — the swap then went unnoticed
        // forever. runContentCheck is safe to run unprepared (it only
        // re-baselines or resets).
        if (observerSuppressed) return;
        let real = false;
        for (const m of mutations) {
          if (!isOwnUiNode(m.target)) { real = true; break; }
        }
        if (!real) return;
        scheduleContentCheck();
      });
      // Observe the whole document, NOT the content container: SPA frameworks
      // (Next.js) usually REPLACE the article element on navigation, and an
      // observer bound to the old element goes silently deaf the moment it is
      // detached — every content change after that went unnoticed. Body-level
      // observation survives the swap; runContentCheck re-resolves the
      // container and the fingerprint gate ignores ad/lazy-load churn.
      observedContainer = findContentContainer();
      observedFingerprint = observedContainer ? contentFingerprint(observedContainer) : null;
      contentObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    function scheduleContentCheck() {
      if (contentChangeTimer) clearTimeout(contentChangeTimer);
      contentChangeTimer = setTimeout(runContentCheck, 800);
    }
    // True when the container's current text no longer matches the baseline.
    // Two signals: (1) the fingerprint moved (head-text change or >15%
    // growth), (2) the old content's FIRST sentence has vanished entirely —
    // a real content swap (chapter navigation) that the fingerprint alone can
    // miss when the resolved container is coarse (e.g. document.body: site
    // chrome keeps the head identical and chapter lengths are similar).
    function contentChanged(container) {
      let t = '';
      try { t = container.innerText || ''; } catch (e) { t = ''; }
      const fp = String(t.length) + '|' + t.slice(0, 160).replace(/\s+/g, ' ').toLowerCase();
      if (significantContentChange(fp, observedFingerprint)) return true;
      const first = STATE.sentences.length ? STATE.sentences[0].text : '';
      if (first && first.length >= 40) {
        // Case-insensitive: innerText applies CSS text-transform (e.g.
        // uppercase themes) while sentences come from textContent (original
        // case) — compare lowercase on both sides.
        const hay = t.replace(/\s+/g, ' ').toLowerCase();
        if (hay.indexOf(first.toLowerCase()) === -1) return true;
      }
      return false;
    }
    function runContentCheck() {
      contentChangeTimer = null;
      let container = observedContainer;
      if (container && container.isConnected) {
        // Cheap path: same node as before — just see whether its text changed.
        if (!contentChanged(container)) return;
      }
      // The old container was detached (SPA route swap) or its text changed —
      // resolve the CURRENT container and compare against the baseline.
      container = findContentContainer();
      if (!container) return;
      const significant = contentChanged(container);
      observedContainer = container;
      observedFingerprint = contentFingerprint(container);
      if (significant) handleContentReset(true);
    }
    function handleContentReset(recoverPlayback) {
      const wasPlaying = recoverPlayback && STATE.isPlaying && !STATE.isPaused;
      const wasIndex = STATE.currentIndex;
      stopReading();
      resetHiccupCount();
      STATE.sentences = [];
      STATE.currentIndex = -1;
      STATE.prepared = false;
      clearAudioCache();

      const now = Date.now();
      const autoRecover = wasPlaying && wasIndex >= 0 && (now - lastRecoverAt) > 4000;
      lastRecoverAt = now;

      setTimeout(() => {
        if (!autoRecover) { observeContentChanges(); return; }
        prepareContent().then((ok) => {
          if (!ok || STATE.sentences.length === 0) { observeContentChanges(); return; }
          const idx = Math.min(wasIndex, STATE.sentences.length - 1);
          if (idx < 0) { observeContentChanges(); return; }
          STATE.currentIndex = idx;
          observeContentChanges();
          startReading(idx);
        });
      }, 350);
    }
    // SPA navigation (pushState/replaceState/popstate) — route changed, but do
    // NOT reset immediately: the new content renders asynchronously (often
    // hundreds of ms later), and resetting now would (a) kill playback before
    // the swap so auto-recovery never fires, and (b) set prepared=false, which
    // blinded the observer to the swap itself. Instead feed the same debounced
    // runContentCheck pipeline as the MutationObserver — the actual content
    // swap is detected once, when it actually happens, with recovery intact.
    (function () {
      const pushState = history.pushState;
      const replaceState = history.replaceState;
      history.pushState = function (...args) {
        pushState.apply(this, args);
        if (STATE.prepared) scheduleContentCheck();
      };
      history.replaceState = function (...args) {
        replaceState.apply(this, args);
        if (STATE.prepared) scheduleContentCheck();
      };
      window.addEventListener('popstate', () => {
        if (STATE.prepared) scheduleContentCheck();
      });
    })();

    // ============================================================
    // System (browser) voices — loaded locally, no background.
    // ============================================================
    let voicesCache = [];
    function loadVoices() { voicesCache = speechSynthesis.getVoices() || []; }
    loadVoices();
    if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
      speechSynthesis.onvoiceschanged = loadVoices;
    } else {
      let tries = 0;
      const iv = setInterval(() => {
        loadVoices();
        if (voicesCache.length || ++tries > 20) clearInterval(iv);
      }, 200);
    }
    function isSilentText(t) {
      // True when the text has no pronounceable content — punctuation-only
      // "sentences" like an ellipsis-only line ("…"), a scene separator
      // ("***", "—") or bare dashes. Piper synthesizes zero audio samples for
      // these and Python's wave module then crashes finalizing the empty WAV
      // (exit code 1), so they must be skipped, not synthesized.
      return !/[\p{L}\p{N}]/u.test(String(t || ''));
    }
    // Quality heuristics for OS/browser voices. Server-side natural/neural
    // voices (Edge "Natural", Chrome "Google …", Apple Premium/Enhanced) sound
    // far better than local defaults (eSpeak, speech-dispatcher, macOS
    // "Compact"), so rank them up and fall back to the best one when no voice
    // is selected — the OS default is often the robotic one.
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
    function findSystemVoice(name) {
      if (name) {
        const exact = voicesCache.find((v) => v.name === name);
        if (exact) return exact;
      }
      // No (or unknown) selected voice: don't leave it to the OS default —
      // pick the best-quality voice available instead.
      if (!voicesCache.length) return null;
      const en = voicesCache.filter((v) => /^en/i.test(v.lang));
      const pool = en.length ? en : voicesCache;
      let best = null;
      let bestRank = -Infinity;
      for (const v of pool) {
        const r = systemVoiceRank(v);
        if (r > bestRank) { bestRank = r; best = v; }
      }
      return best;
    }

    // ============================================================
    // 1) content detection (generic heuristic)
    // ============================================================
    function scoreElement(el) {
      const text = (el.innerText || '').trim();
      const textLen = text.length;
      if (textLen < 50) return -Infinity;
      let linkTextLen = 0;
      el.querySelectorAll('a').forEach((a) => { linkTextLen += (a.innerText || '').length; });
      const density = textLen > 0 ? 1 - linkTextLen / textLen : 0;
      const pCount = el.querySelectorAll('p').length;
      let score = textLen * density + pCount * 40;
      const sig = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
      if (/nav|menu|sidebar|footer|header|comment|share|related|advert|breadcrumb|toolbar|translate|original|english|spanish|portuguese|french|german|italian|russian|polish|dutch|turkish|arabic|hindi|indonesian|vietnamese|filipino|thai|japanese|korean|chinese|simplified|traditional/.test(sig)) score -= 8000;
      if (/chapter|content|article|reading|entry|prose|post-body|story/.test(sig)) score += 800;
      return score;
    }
    function findContentContainer() {
      // Prefer obvious PDF/reader containers so we never grab document.body.
      const sel = 'article, main, [class*="chapter"], [class*="content"], [id*="chapter"], [id*="content"], .entry-content, .post-content, .prose, #ttsr-pdf-text, section';
      let best = null, bestScore = -Infinity;
      for (const el of document.querySelectorAll(sel)) {
        const s = scoreElement(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      return (!best || bestScore < 200) ? document.body : best;
    }

    // ============================================================
    // 2) sentence splitting
    // ============================================================
    function splitSentences(text) {
      const n = text.replace(/\s+/g, ' ').trim();
      if (!n) return [];
      const sentences = [];
      let start = 0;
      const boundaryRe = /[.!?]+(?:["'”’)\]]+)?(?=\s|$)/g;
      let match;
      while ((match = boundaryRe.exec(n)) !== null) {
        const end = match.index + match[0].length;
        const term = match[0];
        const precedingDigits = n.slice(0, match.index).match(/(\d{1,2})$/);
        const isListMarker = term.replace(/["'”’)\]]+$/, '') === '.' && precedingDigits;
        if (isListMarker) continue;
        sentences.push(n.slice(start, end).trim());
        start = end;
      }
      if (start < n.length) sentences.push(n.slice(start).trim());
      return sentences.filter(Boolean);
    }

    // ============================================================
    // 3) paragraph blocks
    // ============================================================
    function getParagraphBlocks(container) {
      let blocks = Array.from(container.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6'))
        .filter((b) => (b.innerText || '').trim().length > 0);
      const set = new Set(blocks);
      blocks = blocks.filter((b) => {
        let p = b.parentElement;
        while (p && p !== container) { if (set.has(p)) return false; p = p.parentElement; }
        return true;
      });
      return blocks.length >= 2 ? blocks : splitByBreaks(container);
    }
    function splitByBreaks(container) {
      const out = [];
      try {
        const groups = [];
        let cur = [];
        container.childNodes.forEach((n) => {
          if (n.nodeType === 1 && n.tagName === 'BR') { if (cur.length) { groups.push(cur); cur = []; } }
          else cur.push(n);
        });
        if (cur.length) groups.push(cur);
        groups.forEach((g) => {
          if (!g.some((n) => (n.textContent || '').trim().length > 0)) return;
          const w = document.createElement('p');
          w.className = 'ttsr-pseudo-block';
          const first = g[0];
          if (first && first.parentNode) {
            first.parentNode.insertBefore(w, first);
            g.forEach((n) => w.appendChild(n));
            out.push(w);
          }
        });
      } catch (e) {}
      return out;
    }

    // ============================================================
    // 4) wrap sentences in spans (async, batched — never freezes the tab)
    // ============================================================
    const PREPARE_BATCH = 120;
    function yieldFrame() { return new Promise((r) => setTimeout(r, 0)); }

    async function prepareContent() {
      observerSuppressed = true;
      try {
        // Always clear old sentence spans so STATE.sentences doesn't grow.
        document.querySelectorAll('.' + SENTENCE_CLASS).forEach((el) => el.remove());
        await yieldFrame();
        const container = findContentContainer();
        const blocks = getParagraphBlocks(container);
        const sentences = [];
        let idx = 0;
        for (let b = 0; b < blocks.length; b++) {
          const block = blocks[b];
          if (!block || !block.isConnected) continue;
          let parts = [];
          try { parts = splitSentences(block.textContent || ''); } catch (e) { parts = []; }
          if (!parts.length) continue;
          const frag = document.createDocumentFragment();
          parts.forEach((part) => {
            const span = document.createElement('span');
            span.className = SENTENCE_CLASS;
            span.dataset.ttsrIndex = String(idx);
            span.textContent = part + ' ';
            frag.appendChild(span);
            sentences.push({ el: span, text: part });
            idx += 1;
          });
          try { block.replaceChildren(frag); } catch (e) { block.innerHTML = ''; block.appendChild(frag); }
          if (b % PREPARE_BATCH === PREPARE_BATCH - 1) await yieldFrame();
        }
        STATE.sentences = sentences;
        STATE.prepared = true;
        observeContentChanges();
        return sentences.length > 0;
      } catch (e) {
        STATE.prepared = false;
        return false;
      } finally {
        observerSuppressed = false;
      }
    }

    // ============================================================
    // 5) highlighting + crash-proof auto-scroll
    // ============================================================
    function clearHighlight() {
      const prev = document.querySelector('.' + HIGHLIGHT_CLASS);
      if (prev) prev.classList.remove(HIGHLIGHT_CLASS);
    }
    function highlightSentence(i) {
      clearHighlight();
      const item = STATE.sentences[i];
      if (!item || !item.el) return;
      item.el.classList.add(HIGHLIGHT_CLASS);
      scrollSentenceIntoView(item.el);
      updatePlayer();
      writeSession({ index: i });
      try {
        window.dispatchEvent(new CustomEvent('ttsr-index-changed', { detail: { index: i } }));
      } catch (e) {}
    }

    // The scroll fix. Sites like novelbuddy set `html { scroll-behavior:
    // smooth }`, and the old `scrollIntoView({behavior:'smooth'})` on every
    // sentence compounded smooth-scroll animations across a huge chapter —
    // freezing/crashing long tabs and stealing focus back from the popup
    // (which makes Firefox close it). We now scroll instantly, only when the
    // sentence is actually out of view, on the correct scroll container.
    function scrollSentenceIntoView(el) {
      try {
        const root = document.scrollingElement || document.documentElement;
        const prevRoot = root.style.scrollBehavior;
        const prevBody = document.body.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        document.body.style.scrollBehavior = 'auto';
        try {
          const viewH = window.innerHeight || document.documentElement.clientHeight || 600;
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.bottom <= viewH) return; // already visible
          let sc = el.parentElement;
          let scrollable = null;
          while (sc && sc !== document.body && sc !== document.documentElement) {
            let oy = '';
            try { oy = getComputedStyle(sc).overflowY || ''; } catch (e) { oy = ''; }
            if (/(auto|scroll|overlay)/.test(oy) && sc.scrollHeight > sc.clientHeight + 4) {
              scrollable = sc;
              break;
            }
            sc = sc.parentElement;
          }
          if (scrollable) {
            const target = scrollable.scrollTop + rect.top - scrollable.clientHeight / 2 + el.clientHeight / 2;
            scrollable.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
          } else {
            const target = (window.scrollY || root.scrollTop || 0) + rect.top - viewH / 2 + el.clientHeight / 2;
            window.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
          }
        } finally {
          root.style.scrollBehavior = prevRoot;
          document.body.style.scrollBehavior = prevBody;
        }
      } catch (e) { /* scroll failure must never break playback */ }
    }

    // ============================================================
    // 6a) SYSTEM playback via speechSynthesis (one utterance / sentence)
    // ============================================================
    function systemSpeak(i, retryLeft) {
      if (retryLeft === undefined) retryLeft = SENTENCE_RETRIES;
      if (i < 0 || i >= STATE.sentences.length) { stopReading(); return; }
      // Silent sentence (punctuation-only line, e.g. an ellipsis-only "…"):
      // nothing to pronounce — advance straight to the next sentence.
      if (isSilentText(STATE.sentences[i].text)) { systemSpeak(i + 1); return; }
      STATE.currentIndex = i;
      highlightSentence(i);
      const u = new SpeechSynthesisUtterance(STATE.sentences[i].text);
      u.rate = STATE.speed;
      u.pitch = STATE.pitch;
      const v = findSystemVoice(STATE.voice);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      STATE.gen += 1;
      const my = STATE.gen;
      STATE.utterance = u;
      u.onend = () => {
        if (my === STATE.gen && STATE.utterance === u && STATE.isPlaying && !STATE.isPaused) {
          markSynthesisOk();
          systemSpeak(i + 1);
        }
      };
      u.onerror = () => {
        if (my === STATE.gen && STATE.utterance === u) {
          if (STATE.isPlaying && !STATE.isPaused) {
            const er = u.error && u.error.name ? String(u.error.name) : '';
            if (er === 'canceled' || er === 'interrupted') return;
            // Mirrors the audio-engine retry: a transient speech-engine hiccup
            // is retried once in place before the sentence is skipped.
            if (retryLeft > 0) {
              showHiccup('sentence ' + (i + 1) + ' failed — retrying…');
              setTimeout(() => {
                if (my === STATE.gen && STATE.utterance === u && STATE.isPlaying && !STATE.isPaused) {
                  systemSpeak(i, retryLeft - 1);
                }
              }, SENTENCE_RETRY_DELAY_MS);
              return;
            }
            if (markSynthesisFail()) return;
            showHiccup('sentence ' + (i + 1) + ' skipped — speech error');
            systemSpeak(i + 1);
          }
        }
      };
      speechSynthesis.speak(u);
    }
    function systemStop() {
      STATE.gen += 1;
      STATE.utterance = null;
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    }
    function systemPause() { if (STATE.isPlaying && !STATE.isPaused) { STATE.gen += 1; STATE.utterance = null; if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); STATE.isPaused = true; } }
    function systemResume() { if (STATE.isPlaying && STATE.isPaused) { STATE.isPaused = false; systemSpeak(STATE.currentIndex); } }

    // ============================================================
    // 6b) AUDIO playback (gcloud / gfree / piper) with prefetch
    // ============================================================
    function cacheAudio(index, buf) {
      audioCache.set(index, buf);
      if (audioCache.size > CACHE_LIMIT) {
        audioCache.delete(audioCache.keys().next().value);
      }
    }
    function clearAudioCache() {
      audioCache.clear();
      // In-flight prefetch synthesis was made with the now-stale settings speed
      // / pitch, so don't let it resolve into the fresh cache. Restart prefetch
      // from a clean slate on the next tick (schedulePrefetch re-arms on play).
      prefetching.clear();
      if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    }
    function requestAudio(index) {
      if (audioCache.has(index)) return Promise.resolve(audioCache.get(index));
      const item = STATE.sentences[index];
      if (!item) return Promise.reject(new Error('no such sentence'));

      // Silent sentence — no pronounceable characters (ellipsis-only lines,
      // scene separators). Synthesizing them produces zero audio (Piper's WAV
      // writer literally crashes on it), so cache empty chunks and let the
      // player advance instantly, with no synthesis round-trip or retries.
      if (isSilentText(item.text)) {
        if (!audioCache.has(index)) cacheAudio(index, []);
        return Promise.resolve([]);
      }

      let p;
      if (STATE.engine === 'gcloud') {
        // Web pitch 0–2 -> semitones -20..+20; Web rate 0.25–4 -> GCloud rate.
        const semis = (STATE.pitch - 1) * 20;
        p = api.runtime.sendMessage({
          type: 'ttsr-gcloud-synthesize', text: item.text, voice: STATE.voice,
          rate: STATE.speed, pitch: semis,
        });
      } else if (STATE.engine === 'gfree') {
        p = api.runtime.sendMessage({
          type: 'ttsr-gfree-synthesize', text: item.text, lang: STATE.voice || 'en',
        });
      } else if (STATE.engine === 'piper') {
        // Piper length_scale = 1/rate (lower = faster).
        p = api.runtime.sendMessage({
          type: 'ttsr-piper-synthesize', text: item.text, model: STATE.voice,
          length_scale: 1 / (STATE.speed || 1), noise_scale: 0.667,
        });
      } else {
        return Promise.reject(new Error('unsupported engine: ' + STATE.engine));
      }

      return p.then((res) => {
        if (!res || !res.ok) throw new Error((res && res.error) || 'synthesis failed');
        const chunks = res.audio;
        if (!Array.isArray(chunks) || !chunks.length) {
          throw new Error('no audio chunks from background');
        }
        for (const c of chunks) {
          if (!c || !(c instanceof ArrayBuffer) || c.byteLength === 0) {
            throw new Error('empty audio chunk from background');
          }
        }
        cacheAudio(index, chunks);
        return chunks;
      });
    }

    function teardownAudioEl() {
      if (STATE.audioEl) {
        try { STATE.audioEl.pause(); } catch (e) {}
        if (STATE.audioEl.src) URL.revokeObjectURL(STATE.audioEl.src);
        STATE.audioEl.src = '';
        STATE.audioEl = null;
      }
    }

    // --- Continuous prefetch -----------------------------------------------
    // Keeps a window of upcoming sentences synthesized and cached *ahead of the
    // playback cadence*. The old code only prefetched a couple of sentences
    // when each sentence started, then went idle during that sentence's
    // playback — at 2x speed the reader drained those few ahead faster than the
    // serialized pipeline could refill, so it stalled every 2-3 sentences to
    // synthesize the next one. This loop instead tops the window back up on a
    // steady tick, so the synthesis pipeline stays busy and the reader always
    // has cached audio waiting. Each requestAudio is cache-first, so repeat
    // ticks never re-synthesize; `prefetching` dedupes in-flight indices.
    // Piper depth is kept moderately deep now that single-flight + watermark
    // cancellation solve the RAM crash (the old reason for depth 2 is gone);
    // memory stays bounded by CACHE_LIMIT.
    let prefetchTimer = null;
    function prefetchDepth() {
      // gfree rate-limits, so it stays shallow.
      return STATE.engine === 'gfree' ? 2 : 6;
    }
    function schedulePrefetch() {
      if (prefetchTimer) return;
      prefetchTimer = setTimeout(() => {
        prefetchTimer = null;
        if (!STATE.isPlaying || STATE.isPaused) return;
        const N = prefetchDepth();
        let issued = 0;
        for (let k = 1; k <= N; k++) {
          const idx = STATE.currentIndex + k;
          if (idx >= STATE.sentences.length) break;
          if (audioCache.has(idx) || prefetching.has(idx)) continue;
          prefetching.add(idx);
          issued++;
          requestAudio(idx)
            .catch(() => {})
            .finally(() => prefetching.delete(idx));
          if (issued >= 3) break; // pace the pipeline, don't flood it
        }
        schedulePrefetch();
      }, 250);
    }
    function stopPrefetch() {
      if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
      prefetching.clear();
    }

    function audioPlay(i, retryLeft) {
      if (retryLeft === undefined) retryLeft = SENTENCE_RETRIES;
      if (i < 0 || i >= STATE.sentences.length) { stopReading(); return; }
      STATE.currentIndex = i;
      highlightSentence(i);
      const my = STATE.gen;
      requestAudio(i).then((chunks) => {
        if (my !== STATE.gen) return; // stale
        if (!STATE.isPlaying || STATE.currentIndex !== i) return;
        markSynthesisOk();
        teardownAudioEl();
        resetHiccupCount();
        playChunks(i, chunks, 0, my);

        // Keep the prefetch window topped up ahead of playback cadence so the
        // next sentences are ready before this one ends (see schedulePrefetch).
        schedulePrefetch();
      }).catch((err) => {
        // Synthesis failed for this sentence. Retry it once in place before
        // advancing — Piper's host is a single process, so a sentence that
        // lands during a cold start / heavy prefetch tends to fail once, then
        // succeed. Only when every attempt fails do we skip past the sentence
        // (and still let the circuit breaker stop a truly dead endpoint).
        if (my === STATE.gen && STATE.isPlaying && !STATE.isPaused) {
          const msg = err && err.message ? String(err.message) : 'unknown error';
          if (retryLeft > 0) {
            showHiccup('sentence ' + (i + 1) + ' failed (' + msg + ') — retrying…');
            setTimeout(() => {
              if (my === STATE.gen && STATE.isPlaying && !STATE.isPaused) {
                audioPlay(i, retryLeft - 1);
              }
            }, SENTENCE_RETRY_DELAY_MS);
            return;
          }
          showHiccup('sentence ' + (i + 1) + ' skipped — synthesis failed: ' + msg);
          if (markSynthesisFail()) return;
          audioPlay(i + 1);
        }
      });
    }

    // Play one sentence's audio chunks back-to-back as separate <audio>
    // elements chained via 'ended' — the same pattern as sentence-to-sentence
    // playback, one level more granular. `autoplay=false` stages the next
    // chunk's element without playing it, so a pause exactly at a chunk
    // boundary still resumes cleanly.
    function playChunks(i, chunks, startChunk, my) {
      const mimeType = STATE.engine === 'piper' ? 'audio/wav' : 'audio/mpeg';
      let chunkIdx = startChunk;
      let chunkRetries = 0; // retries already spent on the currently failing chunk

      function playChunk(autoplay) {
        if (my !== STATE.gen) return;
        if (!STATE.isPlaying || STATE.currentIndex !== i) return;
        if (chunkIdx >= chunks.length) {
          // Every chunk of this sentence finished → next sentence (or end).
          if (i === STATE.sentences.length - 1) {
            emitStatus();
            try { window.dispatchEvent(new CustomEvent('ttsr-end')); } catch (e) {}
            stopReading();
            return;
          }
          // Always advance the chain while playing — audioPlay stages the next
          // sentence's first chunk without autoplaying when paused, so a pause
          // landing exactly on a sentence boundary resumes cleanly.
          if (STATE.isPlaying) audioPlay(i + 1);
          return;
        }
        teardownAudioEl();
        const buf = chunks[chunkIdx];
        const url = URL.createObjectURL(new Blob([buf], { type: mimeType }));
        const el = new Audio(url);
        el.preload = 'auto';
        STATE.audioEl = el;
        let endedFired = false;

        const advance = () => {
          chunkIdx += 1;
          chunkRetries = 0;
          if (!STATE.isPlaying || my !== STATE.gen) return;
          playChunk(STATE.isPaused ? false : true);
        };
        // A chunk that won't start (play() rejected) or won't decode is retried
        // once in place — a transient play interruption or brief decode hiccup
        // usually succeeds the second time. A genuinely corrupt chunk then just
        // advances with a hiccup, never stalling the sentence.
        const failChunk = () => {
          if (endedFired) return;
          endedFired = true;
          URL.revokeObjectURL(url);
          if (my !== STATE.gen) return;
          if (chunkRetries < CHUNK_RETRIES) {
            chunkRetries += 1;
            setTimeout(() => {
              if (my !== STATE.gen) return;
              if (!STATE.isPlaying || STATE.currentIndex !== i) return;
              playChunk(STATE.isPaused ? false : true);
            }, CHUNK_RETRY_DELAY_MS);
            return;
          }
          showHiccup('audio problem in sentence ' + (i + 1));
          chunkIdx += 1;
          chunkRetries = 0;
          if (!STATE.isPlaying) return;
          playChunk(STATE.isPaused ? false : true);
        };
        el.addEventListener('ended', () => {
          if (endedFired) return;
          endedFired = true;
          URL.revokeObjectURL(url);
          advance();
        });
        el.addEventListener('error', failChunk);
        if (autoplay) {
          el.play().catch(failChunk);
        }
      }

      // Stage vs autoplay the first chunk depending on pause state.
      playChunk(!STATE.isPaused);
    }

    function audioPause() {
      // Record the pause even when no <audio> element is alive (the brief gap
      // between sentences while the next one is being synthesized) — otherwise
      // the pause is silently dropped and the next sentence starts anyway.
      if (!STATE.isPlaying) return;
      if (STATE.audioEl) { try { STATE.audioEl.pause(); } catch (e) {} }
      STATE.isPaused = true;
    }
    function audioResume() {
      if (!STATE.isPlaying || !STATE.isPaused) return;
      STATE.isPaused = false;
      if (!STATE.audioEl) {
        // Paused in the gap before a sentence's audio landed (or on a staged
        // boundary). Restart the current sentence from its first chunk.
        audioPlay(STATE.currentIndex);
        return;
      }
      // Resume the live chunk element from its exact paused position. If that
      // play() rejects, replay the current sentence from its first chunk.
      const my = STATE.gen;
      STATE.audioEl.play().catch(() => {
        if (my === STATE.gen && STATE.isPlaying && !STATE.isPaused) {
          audioPlay(STATE.currentIndex);
        }
      });
    }

    // ============================================================
    // 7) unified controls
    // ============================================================
    function isAudioEngine() { return STATE.engine === 'gcloud' || STATE.engine === 'gfree' || STATE.engine === 'piper'; }

    function applyPlaySettings(opts) {
      if (!opts) return;
      const speedChanged = typeof opts.speed === 'number' && opts.speed !== STATE.speed;
      const pitchChanged = typeof opts.pitch === 'number' && opts.pitch !== STATE.pitch;
      if (speedChanged || pitchChanged) clearAudioCache();
      if (typeof opts.speed === 'number') STATE.speed = opts.speed;
      if (typeof opts.pitch === 'number') STATE.pitch = opts.pitch;
      if (opts.engine) STATE.engine = opts.engine;
      if (opts.voice !== undefined) STATE.voice = opts.voice;
    }

    async function startReading(fromIndex) {
      if (!STATE.prepared) {
        const ok = await prepareContent();
        if (!ok || STATE.sentences.length === 0) return { ok: false, reason: 'no-content' };
      }
      STATE.isPlaying = true;
      STATE.isPaused = false;
      const start = typeof fromIndex === 'number' ? fromIndex : Math.max(0, STATE.currentIndex);
      if (start < 0 || start >= STATE.sentences.length) {
        STATE.isPlaying = false;
        return { ok: false, reason: 'no-content' };
      }
      consecutiveFails = 0;
      resetHiccupCount();
      showPlayer();
      writeSession({
        url: location.href,
        engine: STATE.engine, voice: STATE.voice,
        speed: STATE.speed, pitch: STATE.pitch,
        playing: true, paused: false,
        index: start,
      });

      if (isAudioEngine()) {
        STATE.gen += 1;
        teardownAudioEl();
        audioPlay(start);
      } else {
        systemStop();
        systemSpeak(start);
      }
      emitStatus();
      return { ok: true };
    }
    function pauseReading() {
      stopPrefetch();
      isAudioEngine() ? audioPause() : systemPause();
      writeSession({ paused: true, index: STATE.currentIndex });
      updatePlayer();
    }
    function resumeReading() {
      isAudioEngine() ? audioResume() : systemResume();
      if (STATE.isPlaying && isAudioEngine()) schedulePrefetch();
      writeSession({ paused: false, index: STATE.currentIndex });
      updatePlayer();
    }
    // Ask the background to drop any queued-but-unstarted Piper synthesis for
    // sentences we've moved past, and to free the host's RAM. Fire-and-forget:
    // content has already bumped STATE.gen, so stale results it does receive are
    // discarded locally; this just stops the background from doing wasted work.
    // This is the "queued work cancellation" half of the Piper RAM-crash fix.
    function piperCancel() {
      if (STATE.engine !== 'piper') return;
      try {
        api.runtime.sendMessage({ type: 'ttsr-piper-cancel' });
      } catch (e) {}
    }
    function stopReading() {
      STATE.isPlaying = false;
      STATE.isPaused = false;
      stopPrefetch();
      teardownAudioEl();
      systemStop();
      clearHighlight();
      clearSession();
      hidePlayer();
      emitStatus();
      // If we were using Piper, ask the background to tell the native host to
      // exit now, freeing piper's RAM immediately instead of waiting for the
      // idle timeout. Fire-and-forget: a running host ignores it harmlessly if
      // it already exited. (Keeps RAM bounded even on long idle sessions.)
      if (STATE.engine === 'piper') {
        try {
          api.runtime.sendMessage({ type: 'ttsr-piper-shutdown' });
        } catch (e) {}
      }
    }
    function skip(delta) {
      const next = STATE.currentIndex + delta;
      if (STATE.isPlaying) {
        STATE.gen += 1; // invalidate the pending chain
        teardownAudioEl();
        systemStop();
        piperCancel(); // drop queued Piper work for the sentence we're leaving
        STATE.isPaused = false;
        if (next < 0 || next >= STATE.sentences.length) { stopReading(); return; }
        if (isAudioEngine()) audioPlay(next);
        else systemSpeak(next);
      } else {
        if (next < 0 || next >= STATE.sentences.length) return;
        STATE.currentIndex = Math.max(0, Math.min(next, STATE.sentences.length - 1));
        highlightSentence(STATE.currentIndex);
      }
    }

    // ============================================================
    // 8) session auto-resume (auto-refresh resistance)
    // ============================================================
    // A site that reloads itself mid-read keeps sessionStorage, so playback
    // continues where it was. If the tab was stale for hours the session is
    // thrown away and content is re-split fresh on the next Play.
    function tryAutoResume() {
      const s = readSession();
      if (!s) return;
      if (!s.playing || !s.url || s.url !== location.href) { clearSession(); return; }
      if (Date.now() - (s.ts || 0) > AUTO_RESUME_MS) { clearSession(); return; }
      setTimeout(() => {
        if (STATE.prepared) return;
        prepareContent().then((ok) => {
          if (!ok || STATE.sentences.length === 0) { clearSession(); return; }
          const idx = Math.min(Number(s.index) || 0, STATE.sentences.length - 1);
          if (idx < 0) { clearSession(); return; }
          STATE.engine = s.engine || STATE.engine;
          if (typeof s.speed === 'number') STATE.speed = s.speed;
          if (typeof s.pitch === 'number') STATE.pitch = s.pitch;
          if (typeof s.voice === 'string') STATE.voice = s.voice;
          STATE.currentIndex = idx;
          if (s.paused) {
            STATE.isPlaying = true;
            STATE.isPaused = true;
            showPlayer();
            highlightSentence(idx);
            emitStatus();
          } else {
            startReading(idx);
          }
        });
      }, 600);
    }

    // bfcache restore: content script keeps running but the audio element may
    // be dead; re-verify and restart the current sentence if needed.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      try {
        if (STATE.prepared) {
          const connected = document.querySelectorAll('.' + SENTENCE_CLASS).length;
          if (connected !== STATE.sentences.length) {
            handleContentReset(false);
          } else if (STATE.isPlaying && !STATE.isPaused && STATE.currentIndex >= 0) {
            if (isAudioEngine() && !STATE.audioEl) startReading(STATE.currentIndex);
          }
        }
      } catch (err) {}
    });

    // ============================================================
    // 9) in-page command bridge (used by pdfviewer, same-page control)
    // ============================================================
    window.addEventListener('ttsr-cmd', (e) => {
      const d = (e && e.detail) || {};
      try {
        switch (d.type) {
          case 'prepare':
            prepareContent();
            break;
          case 'play':
            applyPlaySettings(d);
            if (STATE.isPaused) resumeReading();
            else startReading(d.fromIndex);
            break;
          case 'pause': pauseReading(); break;
          case 'resume': resumeReading(); break;
          case 'stop': stopReading(); break;
          case 'next': skip(1); break;
          case 'prev': skip(-1); break;
          case 'jump':
            if (typeof d.index === 'number' && d.index >= 0 && d.index < STATE.sentences.length) {
              if (STATE.isPlaying) {
                STATE.gen += 1; teardownAudioEl(); systemStop();
                STATE.isPaused = false;
                if (isAudioEngine()) audioPlay(d.index); else systemSpeak(d.index);
              } else {
                STATE.currentIndex = d.index;
                highlightSentence(d.index);
              }
            }
            break;
        }
      } catch (err) {}
    });

    // ============================================================
    // 10) PDF support helpers (embedded PDF detection + blob/data relay)
    // ============================================================
    function detectEmbeddedPdfs() {
      const urls = [];
      const pushUrl = (raw) => {
        if (!raw) return;
        let abs = raw;
        try {
          if (!/^(https?:|file:|blob:|data:|moz-extension:)/i.test(raw)) {
            abs = new URL(raw, location.href).href;
          }
        } catch (e) {}
        if (/\.pdf($|[?#])/i.test(abs) || /^data:application\/pdf/i.test(abs) || /^blob:/i.test(abs)) {
          if (urls.indexOf(abs) === -1) urls.push(abs);
        }
      };
      try {
        document.querySelectorAll('embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], a[href*=".pdf"]').forEach((el) => {
          pushUrl(el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href') || '');
        });
      } catch (e) {}
      return urls;
    }

    // ============================================================
    // 11) messaging
    // ============================================================
    api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // Guard against our own extension pages. Two cases:
      //  - This page also loads content.js (pdfviewer.html). When that page
      //    sends synthesis / voice-list / pdf-fetch traffic to the background,
      //    the local content-script listener would otherwise answer it with
      //    ok:false and race the background's real response — so those types
      //    are never answered here.
      //  - The popup drives the ACTIVE TAB's content script with
      //    tabs.sendMessage(...). That message legitimately reaches us with the
      //    popup's URL as sender; only ignore it if the sender is the same
      //    page we're running in (a relay that targets another tab).
      if (_sender && _sender.url && _sender.url.indexOf(api.runtime.getURL('')) === 0) {
        const BACKGROUND_ONLY = [
          'ttsr-gfree-synthesize', 'ttsr-gcloud-synthesize',
          'ttsr-gcloud-list-voices', 'ttsr-piper-synthesize',
          'ttsr-piper-list-models', 'ttsr-pdf-fetch',
        ];
        if (BACKGROUND_ONLY.indexOf(msg.type) !== -1) return true;
        if (_sender.url === location.href) return true;
      }
      switch (msg.type) {
        case 'ttsr-prepare':
          prepareContent().then((ok) => sendResponse({ ok, count: STATE.sentences.length }));
          return true;
        case 'ttsr-play':
          applyPlaySettings(msg);
          if (STATE.isPaused) { resumeReading(); sendResponse({ ok: true }); }
          else { startReading(msg.fromIndex).then(sendResponse); }
          return true;
        case 'ttsr-pause': pauseReading(); sendResponse({ ok: true }); return true;
        case 'ttsr-stop': stopReading(); sendResponse({ ok: true }); return true;
        case 'ttsr-next': skip(1); sendResponse({ ok: true, index: STATE.currentIndex }); return true;
        case 'ttsr-prev': skip(-1); sendResponse({ ok: true, index: STATE.currentIndex }); return true;
        case 'ttsr-jump':
          if (STATE.isPlaying) {
            STATE.gen += 1; teardownAudioEl(); systemStop();
            piperCancel();
            STATE.isPaused = false;
            if (isAudioEngine()) audioPlay(msg.index); else systemSpeak(msg.index);
          } else {
            STATE.currentIndex = msg.index; highlightSentence(msg.index);
          }
          sendResponse({ ok: true }); return true;
        case 'ttsr-status':
          sendResponse({
            isPlaying: STATE.isPlaying, isPaused: STATE.isPaused,
            currentIndex: STATE.currentIndex, total: STATE.sentences.length,
            prepared: STATE.prepared, engine: STATE.engine,
          });
          return true;
        case 'ttsr-list-voices':
          sendResponse({ ok: true, voices: voicesCache.map((v) => ({ name: v.name, lang: v.lang, default: v.default })) });
          return true;
        case 'ttsr-pdf-probe':
          sendResponse({ ok: true, pdfUrls: detectEmbeddedPdfs() });
          return true;
        case 'ttsr-pdf-fetch-local':
          fetch(String(msg.url || ''), { credentials: 'include' })
            .then((r) => {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.arrayBuffer();
            })
            .then((buf) => sendResponse({ ok: true, data: buf }))
            .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
          return true;
        default:
          sendResponse({ ok: false, reason: 'unknown-message' }); return true;
      }
    });

    document.addEventListener('click', (e) => {
      const span = e.target.closest && e.target.closest('.' + SENTENCE_CLASS);
      if (!span || !STATE.prepared) return;
      const idx = parseInt(span.dataset.ttsrIndex, 10);
      if (Number.isNaN(idx)) return;
      STATE.isPlaying = true; STATE.isPaused = false;
      STATE.gen += 1; teardownAudioEl(); systemStop();
      piperCancel();
      writeSession({ playing: true, paused: false, index: idx });
      showPlayer();
      if (isAudioEngine()) audioPlay(idx); else systemSpeak(idx);
    });

    window.addEventListener('beforeunload', () => { teardownAudioEl(); speechSynthesis.cancel(); });

    // Kick off after the page settles (avoids racing lazy-loaded content).
    setTimeout(tryAutoResume, 400);
  } catch (err) {
    // Never let a content-script error take the page down with it.
  }
})();