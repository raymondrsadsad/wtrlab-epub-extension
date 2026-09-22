# Novel to EPUB (wtr-lab & more) — Edge extension

Turn a novel into an `.epub`. Full support for **wtr-lab.com** (choose **Web / Web+ / AI**,
illustrations embedded exactly as on the site) plus a **generic extractor** for other sites
(saves the site's own text as-is).

## Install in Microsoft Edge
1. Open `edge://extensions`.
2. Turn on **Developer mode** (bottom-left) if it isn't already.
3. Click **Load unpacked** and select this folder (`wtrlab-epub-extension`).
4. Pin it: click the toolbar puzzle-piece icon → pin **Novel to EPUB**.

## Use
1. Open a wtr-lab novel (or any novel/chapter page) in a tab.
2. Click the extension icon — a full page opens with the current URL pre-filled.
3. Click **Load and Analyse**.
4. (wtr-lab only) pick **Web / Web+ / AI**.
5. Tick the chapters you want (Select All, or set First/Last), then **Pack EPUB**.
6. The `.epub` saves to your Downloads folder — open it with your EPUBReader extension.

### CAPTCHA
wtr-lab may show a Cloudflare check after many requests. The extension pauses and shows
**Open CAPTCHA / Copy link / Retry**. Open the page, complete the check, come back and click
**Retry** — it resumes where it stopped (already-downloaded chapters are kept).

## Adding another site later
Drop a new `adapters/<site>.js` that exports `create()` (implementing `matches`, `getMeta`,
`options`, `getChapter` like `adapters/wtrlab.js`), then register it in `adapters/registry.js`.
No other files need to change.

## Notes
- Web/Web+ translate the raw text via Google (same as the site); Web+ also applies the novel's
  glossary. AI uses the site's stored translation with its glossary placeholders resolved.
- Nothing here bypasses the site's CAPTCHA; it only pauses for you to solve it.
