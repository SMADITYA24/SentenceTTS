# Build Instructions for SentenceTTS Reader

## Overview

This extension uses **no bundler or minification**. The `background.js` file in the extension root is the exact same source as `background-src.js` in this directory. This is intentional — AMO requires a source-code package for any submission that includes minified/bundled code, but since we don't minify, the source package is simply a copy of the source files.

The same shared files also build a **Chrome/Chromium/Edge** variant (`MV3`,
`background.service_worker`). The only differences between the two builds are
the manifest and the Piper native-messaging host manifest. See *Chrome Build*
below.

## Files in this Package

| File | Purpose |
|------|---------|
| `background-src.js` | Unminified background script (identical to `../background.js`) |
| `manifest.chrome.json` | Manifest template for the Chrome/Edge build (`{{SPKI_B64}}` → generated `key`) |
| `chrome-key.pem` | **Private** RSA key that fixes the Chrome extension ID (excluded from all zips) |
| `build-chrome.js` | Assembles `../chrome-build/` + `sentencetts-reader-chrome.zip` |
| `package.json` | Metadata and build verification scripts |
| `BUILD.md` | This file |

## Verification Steps (Run by AMO Reviewers)

AMO reviewers will verify that the submitted extension matches this source:

```bash
# 1. Check syntax validity
node -c background-src.js

# 2. Compare with submitted extension's background.js
diff background-src.js ../background.js
# Should produce no output (files are identical)

# 3. Verify no eval/Function constructor usage
grep -n "eval\|Function(" background-src.js
# Should only match in comments or string literals

# 4. Verify CSP compliance
# manifest.json must have content_security_policy.extension_pages.script-src = 'self'
```

## Build Process

**There is no build process.** The extension is written in plain ES2020+ JavaScript that runs natively in Firefox's background page (MV3, `background.scripts` with module-type semantics).

If you ever add a build step (e.g., TypeScript, minification), update this document and `package.json` accordingly.

## Required Files for Submission

The submission ZIP must contain:

```
sentencetts-reader/
├── manifest.json
├── background.js          # ← identical to build-source/background-src.js
├── content.js
├── content.css
├── popup.html
├── popup.js
├── popup.css
├── pdfviewer.html         # bundled PDF reader page (loads a PDF, feeds it to content.js)
├── pdfviewer.js           # ESM (imports ./pdf/pdf.mjs)
├── pdf/
│   ├── pdf.mjs            # pdf.js library (unminified ESM build)
│   └── pdf.worker.mjs     # pdf.js worker (unminified ESM build)
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── build-source/          # ← THIS DIRECTORY (required by AMO)
    ├── background-src.js
    ├── package.json
    └── BUILD.md
```

## Creating the Submission ZIP

From the project root:

```bash
zip -r sentencetts-reader.zip \
  manifest.json \
  background.js \
  content.js \
  content.css \
  popup.html \
  popup.js \
  popup.css \
  pdfviewer.html \
  pdfviewer.js \
  pdf/ \
  icons/ \
  build-source/ \
  -x "build-source/chrome-key.pem" \
     "build-source/manifest.chrome.json" \
     "build-source/build-chrome.js"
```

**Do NOT include:**
- `README.md`
- `CLAUDE.md`
- `PIPER_SETUP.md`
- `PROJECT_STATUS.md`
- `.claude/` directory
- `piper-host/` directory (native messaging host is installed separately by user)
- Chrome-only build files: `build-source/chrome-key.pem`, `build-source/manifest.chrome.json`, `build-source/build-chrome.js` (private key + Chrome-specific artifacts — not part of the AMO source package)
- Any `.git/` or `node_modules/` directories

## Chrome Build

The shared files (`background.js`, `content.js`, `content.css`, `popup.*`, `pdfviewer.*`, `pdf/`, `icons/`) and the browser-adaptive `background.js` work in Chrome unchanged. Only the manifest differs. Build with:

```bash
node build-source/build-chrome.js
```

This:
1. Reads `build-source/chrome-key.pem` and computes the stable Chrome extension
   ID from it: **`b6ecf49b455c8c297c695d998f40d28a`** — the first 32 hex chars
   of SHA-256 over the public key's SPKI DER. The `key` field in the manifest
   bakes the public key in, so unpacked loads keep this ID across restarts and
   updates (and it is what the Piper `allowed_origins` must match).
2. Writes `chrome-build/manifest.json` (`background.service_worker`,
   CSP `worker-src 'self'` with no `blob:`, `minimum_chrome_version: "119"`,
   no `browser_specific_settings`).
3. Copies the shared files and packs **`sentencetts-reader-chrome.zip`** plus
   `chrome-build/install-piper-host.sh`.

### Chrome install

1. Load the extension unpacked: `chrome://extensions` → enable *Developer mode*
   → *Load unpacked* → select `chrome-build/`.
2. Piper (optional but supported): register the native host **before** starting
   Chrome (manifests are read at browser launch):
   ```bash
   chrome-build/install-piper-host.sh
   ```
   This installs `chrome-build/piper-host-manifest.json` (which uses
   `allowed_origins: ["chrome-extension://b6ecf49b455c8c297c695d998f40d28a/"]`)
   into the NativeMessagingHosts dirs of google-chrome, chromium and
   microsoft-edge. Fix its `path` if your clone lives elsewhere, then fully
   restart the browser.
3. Local `file://` PDFs: in the extension's Details page enable *Allow access to
   file URLs* (Chrome allows the extension to fetch `file://` PDFs when granted,
   unlike Firefox). If the fetch is still refused the reader falls back to its
   file picker.
4. Verify: popup → engine Piper → voice dropdown should list your `.onnx`
   models; reading on novelbuddy long pages, PDFs, and auto-refresh all behave
   like Firefox.

Version bumps must stay in sync across `manifest.json`,
`build-source/manifest.chrome.json`, and `build-source/package.json`.

## Version Bumping

1. Update `version` in `manifest.json`
2. Update `version` in `build-source/manifest.chrome.json`
3. Update `version` in `build-source/package.json`
4. Rebuild both zips (Firefox zip per *Creating the Submission ZIP*; Chrome zip via `node build-source/build-chrome.js`)

## Native Messaging Host

The Piper TTS engine requires a separately-installed native messaging host (`piper_host.py`). This is **not** bundled in the extension — users install it per `../PIPER_SETUP.md`. The extension only contains the client-side connection logic.

## CSP Notes

The manifest includes:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; worker-src 'self' blob:;"
}
```

This allows:
- Self-hosted scripts only (no inline scripts, no remote code)
- Blob workers (used by some libraries, reserved for future)
- No `eval()` or `new Function()` — verified by grep above

## Testing Before Submission

```bash
# 1. Load unpacked in Firefox (about:debugging)
# 2. Test all 4 engines on multiple sites:
#    - novelbuddy.me (primary target) — including a long chapter
#    - Substack, Wikipedia, Medium
# 3. Verify the on-page player appears at the bottom while reading and survives
#    closing the popup (Firefox closes popups on focus loss by design).
# 4. Verify auto-refresh resilience: reload the tab mid-read → playback resumes;
#    a tab left cached for hours does NOT auto-resume.
# 5. PDF: open a web-hosted .pdf → popup shows "Read this PDF" → reader opens and
#    plays with page-flip + transcript highlighting. Embedded PDFs too.
# 6. Verify no console errors in:
#    - Page DevTools (content.js)
#    - Background page inspector (background.js) — click "Inspect" in about:debugging
# 7. Verify pause/resume/stop/next/prev/click-to-jump
# 8. Verify settings persist across popup close/reopen
# 9. Verify SPA navigation works (Next.js routes)
```

## License

MIT — see individual files for any third-party licenses (none in source; Google TTS and Piper are external services/binaries).