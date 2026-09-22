# Changelog

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
