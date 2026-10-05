// Background module for SentenceTTS Reader (MV3).
//
// Three online/offline TTS engines live here so the page never sees the
// credentials or runs the network/binary calls:
//
//   1. Google Cloud TTS    (real neural voices incl. en-IN; needs an API key)
//   2. Google Free (translate_tts) (no key, instant; one accent, <=200c/chunk)
//   3. Piper TTS           (offline neural; via a Native Messaging host)
//
// The content script plays whatever ArrayBuffer we return via an <audio>
// element and does its own highlighting. "System" (browser speechSynthesis)
// voices are handled entirely in the content script — they don't pass here.

const api = typeof browser !== 'undefined' ? browser : chrome;

// True in Firefox (moz-extension://), false in Chrome/Edge (chrome-extension://).
// Drives browser-specific native-messaging install notes and file-access text.
const IS_FIREFOX = api.runtime.getURL('').indexOf('moz-extension://') === 0;

// isAllowedFileSchemeAccess exists in both browsers but in different modes:
// Firefox browser.* is promise-only, Chrome chrome.* is callback-only. Look at
// the API surface once and pick the mode that answers.
function isAllowedFileScheme() {
  return new Promise((resolve) => {
    try {
      const fn = api.extension.isAllowedFileSchemeAccess;
      if (IS_FIREFOX) {
        Promise.resolve(fn()).then((v) => resolve(v === true), () => resolve(false));
      } else {
        fn((v) => resolve(v === true));
      }
    } catch (e) {
      resolve(false);
    }
  });
}

// ============================================================
// shared helpers
// ============================================================

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Native messaging timeout guard
// Piper synthesis time scales with chunk length and length_scale (slower speech = longer audio = more inference).
// Measured on this machine (en_US-arctic-medium.onnx):
//   2000 chars, length_scale=2.0  → ~18.3s
//   2000 chars, length_scale=1.0  → ~11.9s
//   2000 chars, length_scale=0.5  → ~8.9s
// Base ~0.009s/char at length_scale=1.0. Use 4x margin + 2s fixed overhead for model load.
function piperTimeoutMs(textLength, lengthScale) {
  const baseMsPerChar = 9;  // ~9ms per char at length_scale=1.0
  const overheadMs = 2000;  // model loading + connection overhead
  const margin = 4;         // 4x safety margin
  return Math.ceil((textLength * baseMsPerChar * lengthScale + overheadMs) * margin);
}

// Split text into <=max-char chunks at word boundaries.
function chunkText(text, max) {
  const words = text.split(/\s+/);
  const chunks = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) chunks.push(cur.trim());
      if (w.length > max) {
        // a single word longer than the cap — hard-split it
        for (let i = 0; i < w.length; i += max) chunks.push(w.slice(i, i + max));
        cur = '';
      } else {
        cur = w;
      }
    } else {
      cur = (cur ? cur + ' ' : '') + w;
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

// ============================================================
// 1) Google Cloud Text-to-Speech  (API key required)
// ============================================================

const CLOUD_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Google's plain-text `input.text` is capped around 5000 bytes; a single
// sentence longer than that previously failed as a whole and was skipped
// (retry couldn't help — it failed the same way every time). Chunked like
// the other engines now, each chunk as its own ArrayBuffer, played
// back-to-back by the content script.
const GCLOUD_MAX_CHARS = 1000;

async function getCloudKey() {
  const { ttsr_gcloud_key } = await api.storage.local.get('ttsr_gcloud_key');
  if (!ttsr_gcloud_key) throw new Error('No Google Cloud API key set. Add one in the popup.');
  return String(ttsr_gcloud_key).trim();
}

async function gcloudSynthesizeOne(text, key, voice, rate, pitchSemitones) {
  const url = CLOUD_ENDPOINT + '?key=' + encodeURIComponent(key);

  const languageCode = (voice || '').split('-').slice(0, 2).join('-') || 'en-IN';
  const body = {
    input: { text },
    voice: { languageCode, name: voice },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: rate,      // 0.25–4.0
      pitch: pitchSemitones,  // -20.0–+20.0 semitones
    },
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Network error contacting Google TTS: ' + (e && e.message));
  }

  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try {
      const j = await resp.json();
      if (j.error) msg = (j.error.message || j.error.status || msg);
    } catch (_) { /* not JSON */ }
    throw new Error('Google TTS error: ' + msg);
  }
  const data = await resp.json();
  if (!data || !data.audioContent) throw new Error('Google TTS returned no audio');
  const buf = base64ToArrayBuffer(data.audioContent);
  if (!buf || buf.byteLength === 0) throw new Error('Google TTS returned empty audio');
  return buf;
}

async function gcloudSynthesize(text, voice, rate, pitchSemitones) {
  const key = await getCloudKey();
  const chunks = chunkText(text, GCLOUD_MAX_CHARS);
  const parts = [];
  for (const c of chunks) {
    parts.push(await gcloudSynthesizeOne(c, key, voice, rate, pitchSemitones));
  }
  return parts;
}

async function gcloudListVoices() {
  const key = await getCloudKey();
  const url = 'https://texttospeech.googleapis.com/v1/voices?key=' + encodeURIComponent(key);
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error('Network error listing Google voices: ' + (e && e.message));
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); if (j.error) msg = j.error.message || msg; } catch (_) {}
    throw new Error('Google voices list error: ' + msg);
  }
  const data = await resp.json();
  const voices = (data.voices || []).map((v) => ({
    name: v.name,
    lang: (v.languageCodes && v.languageCodes[0]) || '',
    gender: v.ssmlGender || '',
  }));
  return voices;
}

// ============================================================
// 2) Google Free (translate.google.com/translate_tts)
//    No key. One accent per language. <=200 chars per request,
//    so longer text is chunked and each chunk's MP3 is returned as
//    a separate ArrayBuffer, played back-to-back by the content
//    script (no byte-level stitching).
// NOTE: unsupported endpoint — may rate-limit. No speed/pitch control.
//       One retry with a short backoff per chunk (see freeSynthesizeOne).
// ============================================================

const FREE_ENDPOINT = 'https://translate.google.com/translate_tts';

async function freeSynthesizeOne(text, lang) {
  const u =
    FREE_ENDPOINT +
    '?ie=UTF-8&q=' + encodeURIComponent(text) +
    '&tl=' + encodeURIComponent(lang || 'en') +
    '&total=1&idx=0&client=tw-ob&textlen=' + encodeURIComponent(String(text.length));

  async function attempt() {
    let resp;
    try {
      resp = await fetch(u, { method: 'GET' });
    } catch (e) {
      throw new Error('Network error contacting translate_tts: ' + (e && e.message));
    }
    if (!resp.ok) {
      if (resp.status === 429) throw new Error('Rate limited by Google Free TTS (429)');
      throw new Error('translate_tts returned HTTP ' + resp.status);
    }
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0) throw new Error('translate_tts returned empty audio');
    return buf;
  }

  // One retry with a short backoff before giving up on a chunk (item 5).
  try {
    return await attempt();
  } catch (e) {
    await sleep(500);
    return await attempt();
  }
}

async function gfreeSynthesize(text, lang) {
  // translate_tts caps near 200 chars. Chunk and return one ArrayBuffer
  // per chunk — the content script plays them back-to-back (no stitching).
  const chunks = chunkText(text, 190);
  const parts = [];
  for (const c of chunks) {
    parts.push(await freeSynthesizeOne(c, lang));
  }
  return parts;
}

// ============================================================
// 3) Piper TTS via Native Messaging
//    Requires a registered host "sentencetts_piper" on the user's
//    machine (see PIPER_SETUP.md). The host runs the `piper` binary,
//    returns base64 WAV. Offline neural, any installed Piper voice
//    incl. en-IN models if downloaded.
// ============================================================

const PIPER_HOST = 'sentencetts_piper';

// Piper is expensive: the native host spawns a fresh `piper` process (loading
// the model into RAM) per synthesize command, and content.js prefetches several
// sentences ahead. Without a gate, all those requests pile up — content.js can
// already be fetching a new sentence while prefetched ones are still in flight —
// and the host serially reloads the model for each queued request while holding
// every returned WAV in memory until delivered. Serialize all Piper synthesis
// through one FIFO chain so at most ONE model load + one WAV buffer is in flight
// at a time, delivering results one-at-a-time instead of stacking them up.
let piperQueue = Promise.resolve();
// Monotonic cancel watermark. When content jumps away (skip / jump / click-to-
// jump), it sends ttsr-piper-cancel which bumps this. Each enqueued synthesize
// snapshots the watermark at enqueue time; by the time its turn comes, if the
// watermark moved, the sentence was superseded — drop it without loading the
// model or spawning the piper process / returning a WAV nobody will play. This
// is the "queued work cancellation" half of the RAM-crash fix: the single-flight
// FIFO already serialized Piper work, but it still RAN stale prefetches for
// superseded sentences; now those are thrown away so they can't stack model
// loads and WAV buffers in memory.
let piperWatermark = 0;
function piperCancel() {
  piperWatermark += 1;
  // Free the host's RAM immediately (like stop does) — the user has moved on,
  // so the loaded model is now useless until the next request re-spawns it.
  piperSend({ cmd: 'shutdown' }, 2000).catch(() => {});
}
function piperEnqueue(task) {
  const mark = piperWatermark;
  function guarded() {
    if (mark !== piperWatermark) return { stale: true };
    return task();
  }
  const run = piperQueue.then(guarded, guarded);
  piperQueue = run.catch(() => {}); // never let one failure poison the chain
  return run;
}

function piperSend(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Piper host timeout'));
    }, timeoutMs ?? 10000); // default 10s for non-synthesis commands (list)

    function cleanup() {
      clearTimeout(timer);
    }

    try {
      const p = api.runtime.sendNativeMessage(PIPER_HOST, message);
      if (p && typeof p.then === 'function') {
        p.then(
          (resp) => { if (!settled) { cleanup(); settle(resp); } },
          (err) => { if (!settled) { cleanup(); settleErr(err); } }
        );
      } else {
        api.runtime.sendNativeMessage(PIPER_HOST, message, (resp) => {
          if (settled) return;
          cleanup();
          if (api.runtime.lastError || !resp) {
            settleErr(new Error((api.runtime.lastError && api.runtime.lastError.message) || 'Piper host not reachable'));
          } else {
            settle(resp);
          }
        });
      }
    } catch (e) {
      if (!settled) {
        cleanup();
        settleErr(new Error('Piper host not reachable: ' + (e && e.message)));
      }
    }

    function settle(val) { settled = true; cleanup(); resolve(val); }
    function settleErr(err) { settled = true; cleanup(); reject(err); }
  });
}

async function piperListModels() {
  const resp = await piperSend({ cmd: 'list' });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Piper list failed');
  return resp.models || [];
}

async function piperSynthesizeChunk(text, model, lengthScale, noiseScale) {
  const timeoutMs = piperTimeoutMs(text.length, lengthScale);

  async function attempt() {
    const resp = await piperSend({
      cmd: 'synthesize',
      text,
      model: model || '',
      length_scale: lengthScale,
      noise_scale: noiseScale,
    }, timeoutMs);
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Piper synthesis failed');
    if (!resp.audio_base64) throw new Error('Piper returned no audio');
    return base64ToArrayBuffer(resp.audio_base64);
  }

  // One retry with a short backoff for every failure, including host
  // "not reachable": the host is a single spawned process, so a sentence that
  // lands during a cold start or heavy prefetch can fail once and succeed on
  // the second attempt. content.js re-tries the sentence once too, so the
  // total stays bounded (~2 attempts per sentence), and the circuit breaker
  // still stops a permanently-dead host.
  try {
    return await attempt();
  } catch (e) {
    await sleep(500);
    return await attempt();
  }
}

async function piperSynthesize(text, model, lengthScale, noiseScale) {
  // A sentence with no pronounceable characters (an ellipsis-only line, a
  // scene separator) makes piper emit a zero-sample WAV, which Python's wave
  // module then crashes closing (_ensure_header_written → exit code 1). There
  // is nothing to say, so return no chunks instead of failing.
  if (!text || !/[\p{L}\p{N}]/u.test(String(text))) return [];
  // Long text used to be hard-truncated at 2000 chars (dropping the tail).
  // Now every engine chunks long text the same way (item 8): synthesize
  // each chunk separately and return one WAV ArrayBuffer per chunk, played
  // back-to-back by the content script. Removes the silent truncation.
  const chunks = chunkText(text, 2000);
  const parts = [];
  for (const c of chunks) {
    parts.push(await piperSynthesizeChunk(c, model, lengthScale, noiseScale));
  }
  return parts;
}

// ============================================================
// 4) PDF fetch (for the bundled PDF reader page in pdfviewer.html)
//    The PDF viewer is an extension page, so it fetches the PDF here
//    rather than from the web context — host_permissions <all_urls>
//    (plus file:///*) let us read http(s), file and data PDFs. blob:
//    URLs only exist in the page that created them, so those are relayed
//    to that tab's content script (ttsr-pdf-fetch-local in content.js).
// ============================================================

async function fetchPdfRoute(url, originTabId) {
  const u = String(url || '');
  if (/^blob:/i.test(u)) {
    if (!originTabId) {
      throw new Error('Blob PDFs can\'t be fetched from the extension — open the PDF from its web URL.');
    }
    const res = await api.tabs.sendMessage(originTabId, { type: 'ttsr-pdf-fetch-local', url: u });
    if (!res || !res.ok || !res.data) {
      throw new Error((res && res.error) || 'could not read this blob PDF from the page');
    }
    return res.data;
  }
  let resp;
  try {
    resp = await fetch(u, { credentials: 'include' });
  } catch (e) {
if (/^file:/i.test(u)) {
        const isAllowed = await isAllowedFileScheme();
        if (!isAllowed) {
          throw new Error(
            'Local file access is OFF for this extension. ' +
            (IS_FIREFOX
              ? 'Go to about:addons → SentenceTTS Reader → Permissions and enable "Allow access to file URLs". '
              : 'Go to the extension\'s details page (chrome://extensions) and enable "Allow access to file URLs". ') +
            'Then press Read again.'
          );
        }
        // Grant present but the direct fetch still failed — the reader falls
        // back to a file picker, so point the user at it.
        throw new Error('Local file blocked in this browser — use "Choose the PDF file…" below.');
      }
    throw new Error('Could not fetch the PDF: ' + String((e && e.message) || e));
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching PDF');
  return resp.arrayBuffer();
}

// ============================================================
// message router
// ============================================================

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'ttsr-gcloud-synthesize':
      gcloudSynthesize(msg.text, msg.voice, msg.rate, msg.pitch)
        .then((buf) => sendResponse({ ok: true, audio: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-gfree-synthesize':
      gfreeSynthesize(msg.text, msg.lang)
        .then((buf) => sendResponse({ ok: true, audio: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-piper-list-models':
      piperListModels()
        .then((models) => sendResponse({ ok: true, models }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), models: [] }));
      return true;

    case 'ttsr-piper-shutdown':
      // Fire-and-forget from content on stop/end: ask the native host to exit
      // so piper's RAM is freed now rather than on the idle timeout. Best
      // effort — if the host is already gone that's fine.
      piperSend({ cmd: 'shutdown' }, 2000).catch(() => {});
      sendResponse({ ok: true });
      return true;

    case 'ttsr-piper-cancel':
      // Fire-and-forget from content whenever the current sentence jumps
      // (skip / jump / click-to-jump). Drops queued-but-unstarted Piper
      // synthesis for superseded sentences and frees the host's RAM. Content
      // has already bumped its own `gen`, so the stale results it does consume
      // are discarded there; this message just stops the background from doing
      // that wasted work in the first place.
      piperCancel();
      sendResponse({ ok: true });
      return true;

    case 'ttsr-piper-synthesize':
      // Run through the single-flight queue so Piper synthesis (a fresh model
      // load per call in the native host) never stacks up — this is the main
      // lever against the "switching sentences reloads Piper and fills RAM"
      // crash. sendResponse for the message is called only when THIS queued
      // task completes. A task that was cancelled (ttsr-piper-cancel bumped the
      // watermark after enqueue) resolves `{stale}` and is dropped without
      // touching the host.
      piperEnqueue(() => piperSynthesize(msg.text, msg.model, msg.length_scale, msg.noise_scale))
        .then((buf) => {
          if (buf && buf.stale) { sendResponse({ ok: false, error: 'cancelled' }); return; }
          sendResponse({ ok: true, audio: buf });
        })
        .catch((err) => {
          const e = String((err && err.message) || err);
          // Log the full Piper error (verbatim stderr/traceback from the host)
          // to the background console so it can be copied and reported.
          console.error('[SentenceTTS][background][piper] synthesis failed:', e);
          console.error('[SentenceTTS][background][piper] text:', msg.text);
          sendResponse({ ok: false, error: e });
        });
      return true;

    case 'ttsr-gcloud-ping':
      getCloudKey()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-gcloud-list-voices':
      gcloudListVoices()
        .then((voices) => sendResponse({ ok: true, voices }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), voices: [] }));
      return true;

    case 'ttsr-pdf-fetch':
      fetchPdfRoute(msg.url, msg.originTabId)
        .then((buf) => sendResponse({ ok: true, data: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    default:
      return false;
  }
});
