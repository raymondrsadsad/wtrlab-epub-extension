# Novel to EPUB (wtr-lab & more)

Turn a web novel into a clean `.epub`. Full support for **wtr-lab.com** (choose
**Web / Web+ / AI**, illustrations embedded exactly as on the site) plus a
**generic extractor** for other sites.

## Install (Chrome or Edge)
1. Download/clone this folder.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right in Chrome, bottom-left in Edge).
4. Click **Load unpacked** and select this folder (`wtrlab-epub-extension`).
5. Pin it: toolbar puzzle-piece icon → pin **Novel to EPUB**.

## Use
1. Open a wtr-lab novel page and click the extension icon — it opens, fills the
   URL, and auto-analyses (works from a chapter page too).
2. (wtr-lab) pick **Web / Web+ / AI**.
3. Choose chapters — set **First/Last**, use the **filter** box, **Exclude
   extras**, or **Select new** (appears when new chapters released since your
   last pack).
4. **Pack EPUB** → **⬇ Download EPUB**. (Enter also works: in the URL box =
   Analyse; elsewhere once built = Download.)

### CAPTCHA
wtr-lab shows a Cloudflare check after many requests. The extension pauses and
shows **Open CAPTCHA page**. Open it, solve the check — it **auto-resumes** and
(optionally) closes the tab and returns here. Progress is always kept, and
survives a reload via the **Resume** banner.

### Handy buttons
- **Update EPUB** — re-pack after changing the range; reuses fetched chapters.
- **Retry failed** — re-fetch only chapters that errored.
- **Stop** — halt a run; keep what's fetched (Update to continue).
- **🌙 / ☀️** — light / dark theme toggle (remembered).
- **Options ▸ Faster parallel fetch** — quicker, but triggers more CAPTCHAs.

## Updating the extension
This is loaded unpacked, so it runs whatever files are in the folder. After
pulling changes (or receiving a new zip), go to `chrome://extensions` and click
the **↻ reload** icon on the card. To share a snapshot, run:

```
scripts/pack-zip.sh          # → dist/novel-to-epub-<version>.zip
```

Send that zip; the recipient unzips it and does **Load unpacked** on the folder.

## Adding another site later
Drop `adapters/<site>.js` exporting `create()` (implementing `matches`,
`getMeta`, `options`, `getChapter` like `adapters/wtrlab.js`) and register it in
`adapters/registry.js`. Regenerate icons with `python3 scripts/make-icons.py`.

## Notes
- Web/Web+ translate the raw text via Google (Web+ also applies the glossary);
  AI uses the site's stored translation with glossary placeholders resolved.
- Nothing here bypasses the CAPTCHA — it only pauses for you to solve it.
