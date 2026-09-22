# Changelog

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
