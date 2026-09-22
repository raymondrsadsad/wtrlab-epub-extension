<!--
HOW TO USE THIS FILE
1. Create a folder named "screenshots" next to this file.
2. Save your screenshots into it with these names (or rename the ![...](path) lines):
     screenshots/main.png      - the Source panel after Load & Analyse
     screenshots/chapters.png  - the chapter list (filter + status dots)
     screenshots/captcha.png   - the CAPTCHA panel (optional)
     screenshots/epub.png      - the finished .epub open in a reader (optional)
3. Copy everything BELOW this comment as your post. On sites without image
   upload, drag the images in separately where the ![...] lines are.
-->

# 📖 Novel to EPUB — turn web novels into clean offline e-books

A browser extension that downloads a web novel and packages it into a polished
**EPUB** for any e-reader. Built for **wtr-lab** (Web / Web+ / AI translation,
exact illustrations) with a general extractor that brings the same workflow to
other novel sites.

![Load & Analyse a novel](screenshots/main.png)

## ✨ What it does
- **⚡ Fast parallel fetching** — pulls several chapters at once, so long novels
  download in a fraction of the time (toggle it on when you want speed)
- **One-click grab** — open it on a novel page and it auto-analyses the whole
  table of contents
- **Pick exactly what you want** — range select, title filter, one-tap
  **Exclude extras** (side stories / omake / 番外), or **Select new** to grab only
  chapters released since last time
- **Translation** — wtr-lab's Web / Web+ / AI modes with glossary, or
  **Translate → English** on other sites
- **Survives CAPTCHAs** — pauses on a Cloudflare check, then **auto-resumes** the
  moment you solve it (all progress kept)
- **Never lose a run** — Stop, Resume after a reload, Update a changed range
  without re-fetching, and Retry only the chapters that failed
- **Clean output** — proper EPUB 3 with cover page, title page, navigable TOC,
  justified text, embedded images, and metadata
- **Nice to use** — live progress + ETA, per-chapter status dots, recent-novels
  list, light / dark theme, download on your terms

![Pick chapters — filter, exclude extras, status dots](screenshots/chapters.png)

## 🔧 Install (Chrome / Edge)
1. Download the folder (or unzip the release)
2. Go to `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the folder
4. Pin it, open a novel, and hit **Load & Analyse**

## ⚙️ Add another site
Any site works through the built-in generic extractor; for a perfect fit you can
drop in a small per-site adapter.

> Note: it doesn't bypass any CAPTCHA — it just pauses for you to solve it, then
> continues. Parallel mode is faster but can trigger checks more often — the
> auto-resume handles that for you.
