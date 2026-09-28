# Changelog

## 1.16.1 — 2026-09-29

### Fixed
- **Page zoom now works on full-width / mobile pages (e.g. comic sites on the tablet).** It
  previously used CSS `zoom` on the page body, which is a no-op when the content fills the width
  — the body just re-expands to fill the viewport, so zoom-out did nothing on comic readers like
  asurascans (it only appeared to work on desktop, where the site's own layout is a fixed centred
  column). Page zoom now constrains the body's width and centres it instead: zoom-out shrinks the
  page and centres it with equal margins on both sides (like a webtoon column in the middle of the
  screen), zoom-in grows it for panning, and it reflows correctly so long webtoons don't get a
  huge blank scroll area. Any leftover CSS-zoom from older versions is cleared automatically.

## 1.16.0 — 2026-09-29

### Added
- **Move the expanded Web Reader panel.** You can now drag the floating 🌐 panel by its
  "Web Reader" header, not just the collapsed bubble. Collapse/Close still work (drag ignores
  button clicks).

### Fixed
- **Translation shrugs off transient failures.** The free Google endpoint intermittently returns
  `HTTP 502/503` and the network sometimes drops the request (`Failed to fetch`). Every batch now
  retries up to 3× with exponential backoff + jitter before giving up, so a blip no longer fails
  the whole page or an auto-translated chapter. Real errors (4xx) still fail fast. Applies to all
  engines (Google / DeepL / OpenAI).
- **Panel no longer overflows the screen edge.** Opening the panel while the bubble sat near the
  right/bottom edge let it run off-screen. The widget now clamps itself fully into view when it
  expands and on window resize/rotate, using its live size so the wide panel reserves the room the
  small bubble doesn't.
- **No more error spam after an extension update.** When the extension is reloaded while a page
  stays open, the old content script's context is dead; the auto-translate observer used to log
  "Extension was updated — reload this page…" on every DOM mutation. It now stops watching after
  the first such failure (reload the page to use the Web Reader again).

## 1.15.0 — 2026-09-28

### Added
- **Freely resize any web page.** Many reader/manga sites disable pinch-to-zoom
  (`user-scalable=no` in their viewport), so oversized cover art and pages can't be shrunk on a
  phone/tablet. The on-page content script now re-enables native pinch-zoom on every site (only
  editing an existing viewport tag, never adding one, so desktop layouts are untouched). Toggle
  it in the extension's **Web Reader** tab → "Allow pinch-zoom on every page" (on by default).
- **Per-site page zoom.** The floating 🌐 widget's panel gains a **Page zoom** row (− / % / + /
  ⟲) that scales the page (via CSS zoom on the page body, so the widget itself isn't scaled) and
  remembers the level per website.

### Fixed
- **On-site Read-aloud no longer auto-resumes when you switch back to the tab** — matching the
  in-extension reader fix from 1.14.0. Hiding the tab still stops speech (no background
  interleaving); returning keeps your place and waits for Play.

## 1.14.0 — 2026-09-28

### Fixed
- **Read-EPUB mini player no longer vanishes / skates around while scrolling.** The floating
  text-to-speech player was tied to "immersive" mode, so every scroll-down slid it off-screen
  (and on mobile a tall player animated across the page). The player now stays put while you
  read — only the top chapter bar hides. Use its ▾ button to collapse it if you want it smaller.
- **Packaging can't silently drop a required file again (the 1.13.0 outage).** `pack-zip.sh`
  now verifies that every relative `import` in the bundled JavaScript actually ships in the
  zip and fails the build (naming the missing file) if not. 1.13.0 shipped with `selftest.js`
  missing, which aborted the whole popup module and left every button dead.

### Added
- **Self-test runs on load.** The offline self-test now runs automatically when the popup
  opens; if anything fails, a red banner appears (with a Details link to the full report) so a
  broken build announces itself instead of misbehaving silently.
- **Chapter fetches retry transient failures.** A timeout or flaky network error on a chapter
  is now retried with a short exponential backoff before it's marked failed, so a brief hiccup
  mid-book no longer stubs chapters. (CAPTCHAs still pause and auto-resume as before.)
- **Built EPUBs are sanity-checked before download.** After packing, the file is re-opened and
  its chapter count + metadata verified; a mismatch warns you (you can still download) instead
  of handing over a broken book.
- **Library backup — Export / Import.** The Library tab can export your whole shelf and
  settings (recent novels, packed counts, reading progress, follows, glossaries + presets,
  reader and translation prefs) to one JSON file, and merge it back on another device.
- **Library "Check for new".** One button checks every library novel for newly released
  chapters, badges the ones with updates, and gives each an **⟳ Update** button that opens the
  novel with the new chapters pre-selected — click Pack (or Import your previous EPUB to merge).
- **Glossary presets + import/export.** Save a set of name/term fixes as a named preset and
  apply it to any novel, so a series' terms carry between its books; export/import all
  glossaries and presets as JSON.
- **Reader: voice pitch + sleep timer.** The text-to-speech player gains a Pitch control and a
  Sleep timer (5 / 15 / 30 / 60 min or "end of chapter") that stops reading automatically.

## 1.13.0 — 2026-09-28

### Added
- **Built-in Self-test (no more manual testing every release).** A new **🧪 Self-test**
  button in the footer (with the version number) runs the real pipelines on synthetic
  data and reports pass/fail: EPUB build → re-read round-trip, special-character XML
  escaping, cover/inline image byte preservation, deterministic book id, adapter
  auto-detection (wtr-lab / Kakuyomu / generic), adapter options, glossary replacement
  (longest-match-wins), and HTML-entity decoding. All checks are offline; an optional
  tick-box adds a live Google-translation check. Run it after any change to catch
  regressions before shipping.

## 1.12.5 — 2026-09-28

### Fixed
- **First/Last chapter pickers line up cleanly on tablets/phones.** The range row could wrap
  so the "Last" label was stranded at the end of the first line while its dropdown dropped to
  the next — each label now stays glued to its own dropdown, and the two pickers sit side by
  side when there's room or stack as whole units when there isn't.

## 1.12.4 — 2026-09-28

### Fixed
- **Read-aloud no longer jumbles across browser tabs (mobile).** Android has one shared
  text-to-speech engine, so a background tab that kept speaking interleaved its paragraphs
  with the tab you were actually reading. Each reader now stops speaking when its tab is
  hidden and resumes from the same spot when you return, so only the tab you're looking at
  reads.
- **"Translate page" now translates menus that open later (e.g. Kakuyomu's 目次 on mobile).**
  On phones the table-of-contents drawer is built only when you open it — after the one-time
  translation pass — so its episode titles stayed Japanese (they translated fine on desktop,
  where the list is always present). Translation now also catches text added after the first
  pass (drawers, next-chapter navigation, lazy lists).

## 1.12.3 — 2026-09-28

### Fixed
- **Read-aloud now speaks the chapter title (Kakuyomu).** Kakuyomu renders the episode
  title outside the body container, so on-page Read-aloud skipped it and started at the
  first line of prose; the title is now collected as the first spoken block. The clean
  Reader overlay also resets to the title on every chapter change, so pressing Play no
  longer resumes past it with a stale line index.

## 1.12.2 — 2026-09-27

### Fixed
- **Reader toolbar stays reachable while scrolling (mobile).** The ☰ / Aa / Prev / Next bar
  now pins to the top of the screen once you scroll past it, instead of relying on CSS
  sticky (which some Android browsers ignore). It still tucks away while you scroll down
  and comes back when you scroll up a little or tap the page.
- **Mode tabs no longer run off the screen on phones.** Swipe the tab row sideways to reach
  Web Reader and Library.

## 1.12.1 — 2026-09-27

### Fixed
- **Works on Android browsers (Quetta, Kiwi-style).** The background worker no longer
  crashes when the browser lacks alarms, notifications or offscreen documents; those
  features just switch off quietly. **Download EPUB** and the Merger's export fall back to
  a normal browser download when `chrome.downloads` is missing or fails, and returning to
  the tool tab after a CAPTCHA no longer throws where there are no browser windows.

## 1.11.1 — 2026-09-26

### Changed
- **Mobile-friendly reader.** Fixed the reading view overflowing on phones. Contents is
  now a **☰ hamburger → left slide-in drawer** (on mobile and desktop), freeing the full
  width for text. **Immersive reading:** scrolling into the text hides the top bar and the
  floating player; scrolling up — or **tapping the page** — brings them back. TTS
  auto-follow scrolling no longer flickers the controls.

## 1.11 — 2026-09-25

### Added
- **Three modes, switchable from the top:** **Novel to EPUB** (the original), **EPUB
  Merger**, and **Read EPUB**. The last-used mode is remembered.
- **“Read this novel aloud” button (Novel mode).** Open the extension on a chapter and,
  instead of packing an EPUB, jump straight into the reader with text-to-speech. It
  starts on the chapter you opened and fetches each chapter on demand as you read/listen
  — no full download needed. Reuses the reader’s TTS, follow/highlight, and voice
  controls. Picks up the **`?service=`** from the opened URL, shows a **Web / Web+ / AI**
  selector in the reader (wtr-lab) that re-fetches on change, and handles a **CAPTCHA**
  inline — a clear **“⚠ Hit a CAPTCHA”** warning appears (so you know your Next click
  registered), it opens the page, and once solved it **auto-closes that tab, returns to
  the reader, and continues**. Next/Prev no longer desync when a chapter fails to load,
  and if AI translation hits wtr-lab’s ~10-chapter guest limit it says so and points you
  to the Web / Web+ selector.
- **EPUB Merger (fully offline).** Combine EPUBs you already have — no network, no data
  used. Add two or more files, see one combined chapter list, and arrange it: **drag** to
  reorder (or ▲/▼), **Sort by number**, **De-dupe** overlaps, tick/untick to include or
  exclude, and ✕ to remove. Title/author/language and the cover are prefilled from the
  first file and editable. Export **Save As…** (choose where — you can overwrite an
  original) or **Quick download** to your Downloads folder. Reuses the same builder as
  the novel packer, and unique per-file image namespaces keep illustrations correct.
- **Read EPUB (offline reader) with text-to-speech.** Open any `.epub` from your device
  and read it in a clean, full-page reader: pick chapters from the contents list, images
  and all. **Text-to-speech** uses Chrome’s built-in voices (works offline): **Play/
  Pause** (or Space), **Stop**, **⏮/⏭ line**, a **voice** picker and a **speed** slider,
  and **click any line to start speaking from there**. Defaults to the **Google US
  English** voice when the device has it (falling back to another US-English / English
  voice otherwise); your own voice pick is remembered. The controls live in a **floating,
  draggable player** that stays put while you scroll and **collapses to a mini bar**
  (tap to expand). Toggle **Follow while speaking** (auto-scroll to the spoken line) and
  **Highlight line** independently. **Resume memory** remembers your place per book —
  reopen a file and it offers *“Resume: Chapter 9 · line 50”* with **Continue** or
  **Start over**. Player position, voice, speed and toggles are all remembered.

## 1.10 — 2026-09-25

### Added
- **Import an existing EPUB and fetch only the new chapters.** Already have, say,
  chapters 1–100 saved as an EPUB? After you **Load & Analyse** the novel, click
  **⬆ Import EPUB…** and pick that file. Its chapters are read back in and reused, so
  clicking **Pack EPUB** downloads only the newly-released chapters (e.g. 101–105) and
  builds one combined book — no re-fetching (and no re-downloading the data) of the
  chapters you already have. Because the book identity is stable (see 1.9), your reader
  replaces the old book instead of duplicating it. Reads the extension’s own EPUBs
  directly; other EPUBs are handled best-effort (store + deflate, via the browser’s
  native decompression — no added dependencies).
- **Robust matching that survives inserts, reorders and renames.** Each chapter is now
  stamped with its source identity (chapter number + URL) when built, and re-import
  matches by that identity rather than by position — so a chapter inserted or moved in
  the middle, or an old chapter whose title changed, still lines up correctly. Chapters
  no longer on the site are skipped; genuinely new ones are fetched.
- **Re-fetch old chapters an author has revised.** Because a silent edit to an old
  chapter’s text can’t be detected from the table of contents, you can force a refresh:
  click a chapter’s green ● to re-download just that one, or use **↻ Re-fetch all** to
  re-download every imported chapter. Both are reversible until you Pack.

## 1.9.1 — 2026-09-25

### Added
- **Manage the Recent novels dropdown.** Recent novels are now a collapsible dropdown
  (with a count). Open it and click one to load it, or use its **×** to remove that
  single entry. A **Clear** button empties the whole list.

### Changed
- **File cover thumbnail is always included; one toggle now controls the in-book front
  pages.** The file’s cover image (the thumbnail your reader/OS shows for the `.epub`) is
  always embedded whenever a cover URL is present — no checkbox needed. A single
  **Include cover & title page** option (on by default) controls the *in-book* front
  matter: the visible cover page the book opens on plus the title/author/synopsis page.
  Untick it to drop those inside-the-book pages while still keeping the file thumbnail.
  Existing saved preferences carry over.

## 1.9 — 2026-09-25

### Changed
- **Stable book identity across rebuilds.** The EPUB’s `dc:identifier` is now derived
  deterministically from the novel URL instead of a random UUID each build, so
  re-downloading after new chapters (**Update EPUB**) replaces the book in your reader
  instead of creating a duplicate. Falls back to a random id when no URL is available.
- **Correct language tag on non-translated generic downloads.** The Generic adapter now
  detects the source language (`<html lang>` / `og:locale` / `content-language`) and tags
  “Original”-mode EPUBs with it (e.g. `ko`, `zh`) for better e-reader font/hyphenation.
  Translation (→ English) is untouched — still tagged `en` — and a language you type
  yourself always wins.

## 1.8 — 2026-09-25

### Added
- **“Include cover & title page” option** (Options row, on by default). Untick it
  to build a chapters-only EPUB with no cover page and no title/synopsis page —
  handy when grabbing a single chapter. The choice is remembered between sessions.
  Default is unchanged, so existing behaviour is preserved unless you turn it off.

## 1.7.2 — 2026-09-23

### Added
- Auto-analyse also on **genesistudio.com** when you open the extension there
  (host list is easy to extend).


## 1.7.1 — 2026-09-23

### Fixed
- **Switching novels no longer shows the previous pack's progress.** Analysing (or
  picking a Recent) now resets the progress bar and buttons, and supersedes any
  in-flight run via a run-id guard so stale results/UI can't leak in.
- **Generic cover** prefers a real cover image over an OG-card generator endpoint
  (e.g. `/api/og/…`); falls back to `link[rel=image_src]` / `twitter:image`.

## 1.7 — 2026-09-23

### Added
- **Full experience on other sites.** The generic extractor now feeds the same
  workflow as wtr-lab (filter, exclude extras, status dots, retry, stop, update,
  resume, new-chapter detection, EPUB polish).
- **Adapter dropdown** — Auto-detect (default), or force wtr-lab / Generic.
- **Smarter generic chapter list** — dedupes links, keeps the real table of
  contents, extracts chapter numbers and **sorts ascending** (fixes newest-first
  sites), and reports a count for new-chapter detection.
- **Generic translation** — Original, or **Translate → English** (auto source
  language), sharing wtr-lab's translation engine.
- **Cloudflare handling for generic sites** — pauses on a challenge and
  auto-resumes, same as wtr-lab.
- **Reverse** button — flip chapter order when a site lists newest-first.

### Changed
- Better generic content extraction (link-density penalty, more lazy-image
  attributes) and metadata (description, genres).
- Translation helpers moved to a shared `adapters/translate.js` (no behaviour
  change for wtr-lab).

## 1.6 — 2026-09-23

### Added
- **Stop button** — halt a running pack; already-fetched chapters are kept, so
  Update continues from there.
- **Extension icons** — a proper download glyph in the toolbar and extensions
  page (generated by `scripts/make-icons.py`).
- **Per-chapter status dots** — pending / loading / ✓ done / ✗ failed next to each
  chapter row.
- **Light / dark theme toggle** (🌙/☀️ in the header, remembered).
- **New-chapter detection** — on re-analyse, shows "N new since last pack" and a
  **Select new** button to grab only the new chapters.
- **Richer EPUB** — a title page (title/author/synopsis), plus `dc:description`
  and `dc:subject` (genres) metadata.
- **Distribution kit** — expanded README and `scripts/pack-zip.sh` to build a
  shareable `dist/novel-to-epub-<version>.zip`.

### Fixed
- Options label no longer wraps into a narrow column (v1.5.1).

## 1.5 — 2026-09-23

### Added
- **Retry failed chapters.** A chapter that errors is stubbed as before, but the
  count is now surfaced and a **Retry failed** button re-fetches only those,
  keeping the rest — a hiccup mid-run no longer quietly corrupts the book.
- **Recent novels.** The last 8 analysed novels appear in a dropdown; pick one to
  reload it without re-pasting the URL.
- **Progress ETA.** The status shows "Fetching 40 / 170 · ~3 min left".
- **Keyboard shortcuts.** Enter in the URL box runs Analyse; Enter elsewhere (once
  a file is built) triggers Download.
- **Faster parallel fetch** (opt-in). Fetches a few chapters at once for long
  runs — off by default because it triggers more CAPTCHAs.

### Changed
- **Cleaner titles/metadata.** Unresolved glossary placeholders like
  `%{Soul Land|RG91bHVv}` are reduced to their display text in the title,
  author, filename, and chapter names.
- **Nicer EPUB output.** Shared stylesheet with justified text and hyphenation, a
  proper cover page so the book opens on the cover, and tidier chapter markup.

## 1.4 — 2026-09-23

### Added
- **Chapter filter.** A filter box live-filters the list by title; **Check
  matches / Uncheck matches** bulk-toggle whatever is shown, and **Exclude
  extras** unchecks side stories in one click (extra, side story, omake, bonus,
  interlude, afterword, 番外, 外传, SS). A live "X shown · Y/Z selected" counter
  keeps the tally. Filtering only affects the view — your checkboxes still decide
  what gets packed.

### Changed
- **Calmer palette.** Replaced the bright violet/green and glow effects with a
  muted slate-blue accent, a soft sage Pack button, flat fills, and gentler
  shadows — easier on the eyes.

## 1.3.1 — 2026-09-23

### Fixed
- **Uniform Source alignment.** All fields now use one label column and share the
  same left/right edges. Previously the Title/Author/Language/Filename grid used
  narrower labels than the URL/Cover rows, so their boxes started at a different
  x. Single-column layout removes the mismatch; narrow widths wrap cleanly.

## 1.3 — 2026-09-23

### Changed
- **Modern UI redesign.** New header/brand bar, elevated cards with section
  headings, a segmented Web / Web+ / AI control, gradient primary/accent buttons,
  a sleeker progress bar, a chapter count pill, and a cleaner chapter list with
  hover rows and a custom scrollbar.
- **Fixed overflow & alignment.** Long titles/filenames now ellipsis inside their
  fields instead of spilling out; the status line wraps; labels and inputs align
  on a uniform grid; layout reflows cleanly at narrow widths.

## 1.2.1 — 2026-09-23

### Changed
- **Update now truly continues** instead of appearing to restart. Already-fetched
  chapters are reused instantly — no re-fetch, no 1.2s delay each. So 1–6 → 1–10
  only fetches 7–10, and shrinking 1–10 → 1–5 just rebuilds with 1–5 (no re-pack).
- **Cover preview zoom.** Hover the thumbnail to pop it out larger; click it to
  lock a big view (click again to shrink).

## 1.2 — 2026-09-23

### Added
- **Download button.** Packing no longer downloads automatically — it builds the
  EPUB and shows a **⬇ Download EPUB** button so you choose when to save.
- **Update button.** After a pack, change the range (e.g. 1–20 → 1–50) and click
  **Update EPUB**; it reuses everything already fetched and only downloads the
  new chapters, then rebuilds.
- **Remembers your settings.** Your translation mode (Web / Web+ / AI), language,
  and the "close CAPTCHA tab" checkbox are saved and restored next time.
- **Cover thumbnail.** A small preview of the cover image appears next to the URL.
- **Resume an interrupted pack.** If a big pack is cut off (reload/close), a
  Resume banner offers to restore progress and continue where it left off.

### Fixed
- **"Open CAPTCHA page" always opens the stalled chapter.** Each chapter now
  carries its real reader URL, so the button no longer falls back to the novel
  homepage.

## 1.1 — 2026-09-23

Quality-of-life pass focused on the wtr-lab CAPTCHA flow.

### Added
- **Real chapter titles in the list.** The tool now shows the actual titles from
  the Table of Contents (e.g. "#170 ending") instead of a generic "Chapter 170",
  read from the novel page data. Falls back to generic numbering if titles can't
  be found.
- **Auto-analyse on wtr-lab.** Clicking the extension while on a wtr-lab page now
  fills the URL and analyses the novel automatically — the chapter list is ready
  without pressing "Load and Analyse". Works from a chapter page too (the URL is
  normalized back to the novel page first).
- **Auto-resume after a CAPTCHA.** After you open the challenge page, the tool
  quietly re-checks the stalled chapter every few seconds and continues the
  moment it's solved — no more clicking **Retry**. (Retry stays as a manual
  fallback; it gives up after ~4 min so a forgotten tab can't loop forever.)
- **"Close the CAPTCHA tab and return here" checkbox** in the CAPTCHA panel
  (on by default). When the challenge is solved, the tab the extension opened is
  closed and this tool's tab is brought back to the front. Only ever closes the
  tab the extension itself opened.

### Changed
- **Open CAPTCHA page** now targets the exact stalled chapter's reader page
  (`…/novel/id/slug/chapter-N`) instead of the novel homepage, so the challenge
  appears immediately — no need to hand-pick a chapter to trigger it.

### Notes
- No new permissions. Progress is still kept across a CAPTCHA pause.
