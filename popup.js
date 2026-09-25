import { pickAdapter, adapterById } from "./adapters/registry.js";
import { buildEpub } from "./epub.js";
import { parseEpub } from "./epubread.js";
import { initMerge } from "./mergeview.js";
import { initRead, readerStop, openLive, readerReload } from "./readerview.js";
import { translateAll } from "./adapters/translate.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a hard timeout so a stalled request can never hang the whole build
async function fetchT(url, opts = {}, ms = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

const S = {
  adapter: null,
  meta: null,
  chapters: [],
  service: null,
  // pack run state (resumable across CAPTCHA)
  queue: [],
  qpos: 0,
  results: {},        // index -> {title, blocks}
  imgCache: {},       // url -> {name, id, mime, data}
  imgN: 0,
  running: false,
  lastBlob: null,     // the last built EPUB, awaiting the Download button
  lastName: null,
  prefService: null,  // remembered translation mode from last session
  failed: new Set(),  // indices whose fetch failed (stubbed) — retryable
  cancel: false,      // Stop button pressed
  runId: 0,           // bumped to supersede an in-flight run (e.g. switching novels)
  counts: {},         // url -> chapter count at last pack (for "new since" detection)
  newFrom: null,      // index from which chapters are "new" this analyse
  currentUrl: null,   // url of the analysed novel
  startChapterNo: null,// chapter number from the URL the extension was opened on
  startEpisodeId: null,// kakuyomu episode id from the opened URL (for Read-aloud start)
  startService: null, // ?service= from the opened URL (web / webplus / ai)
  origTitles: null,   // cached original chapter titles (for the JP↔EN titles toggle)
  enTitles: null,     // cached English-translated chapter titles
  titlesEn: false,    // list currently showing translated titles?
  imported: new Set(),// site indices whose content came from an imported EPUB (reused)
  importStash: {},    // site index -> {title, xhtmlBody, imgNames} for reversible re-fetch
  importImgs: null,   // Map(imageName -> record) from the last import
};

// ---------- persistence (settings + resume) ----------
const store = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null;

function savePrefs() {
  try {
    store && store.set({ prefs: {
      service: S.service,
      lang: ($("language").value || "").trim(),
      autoClose: $("capAutoClose") ? $("capAutoClose").checked : true,
      parallel: $("parallel") ? $("parallel").checked : false,
      includeTitlePage: $("includeTitlePage") ? $("includeTitlePage").checked : true,
      theme: document.documentElement.getAttribute("data-theme") || "dark",
    }});
  } catch (e) { /* ignore */ }
}

// Canonical novel URL for de-duping the recent list: drop ?query (…?tab=toc,
// ?service=…) and #hash, and collapse a wtr-lab chapter URL to its novel page.
function canonUrl(u) {
  try {
    const url = new URL(u);
    url.hash = ""; url.search = "";
    url.pathname = url.pathname.replace(/\/chapter-\d+\/?$/i, "").replace(/\/+$/, "") || "/";
    return url.toString();
  } catch (e) { return String(u || "").split(/[?#]/)[0].replace(/\/+$/, ""); }
}
// Collapse duplicate recents (same novel via different query strings), newest kept.
function dedupeRecent(list) {
  const seen = new Set(), out = [];
  for (const r of (list || [])) {
    if (!r || !r.url) continue;
    const k = canonUrl(r.url);
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...r, url: k });
  }
  return out;
}

// Recent novels list (newest first, capped).
function addRecent(url, title) {
  if (!store || !url) return;
  const cu = canonUrl(url);
  try {
    store.get("recent", (o) => {
      let list = (o && Array.isArray(o.recent)) ? o.recent : [];
      list = list.filter((r) => r && canonUrl(r.url) !== cu);
      list.unshift({ url: cu, title: title || cu, ts: Date.now() });
      list = dedupeRecent(list).slice(0, 8);
      store.set({ recent: list });
      renderRecent(list);
    });
  } catch (e) { /* ignore */ }
}
// Remove a single recent novel by url.
function removeRecent(url) {
  if (!store || !url) return;
  const cu = canonUrl(url);
  try {
    store.get("recent", (o) => {
      let list = (o && Array.isArray(o.recent)) ? o.recent : [];
      list = list.filter((r) => r && canonUrl(r.url) !== cu);
      store.set({ recent: list });
      renderRecent(list);
    });
  } catch (e) { /* ignore */ }
}
// Open/close the recent dropdown panel.
function setRecentOpen(open) {
  const list = $("recentList"), tog = $("recentToggle");
  if (!list || !tog) return;
  list.classList.toggle("hidden", !open);
  tog.classList.toggle("open", open);
  tog.setAttribute("aria-expanded", open ? "true" : "false");
}
function renderRecent(list) {
  const wrap = $("recentList");
  if (!wrap) return;
  wrap.innerHTML = "";
  (list || []).forEach((r) => {
    const item = document.createElement("div");
    item.className = "recent-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent-open";
    open.textContent = r.title || r.url;
    open.title = r.url;
    open.addEventListener("click", () => { setRecentOpen(false); $("url").value = r.url; analyse(); });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "recent-remove";
    rm.textContent = "×";
    rm.title = "Remove from recent";
    rm.setAttribute("aria-label", "Remove from recent");
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeRecent(r.url); });
    item.appendChild(open);
    item.appendChild(rm);
    wrap.appendChild(item);
  });
  const n = (list && list.length) || 0;
  const lbl = document.querySelector(".recent-toggle-label");
  if (lbl) lbl.textContent = n ? `Recent novels (${n})` : "Recent novels…";
  const row = $("recentRow");
  if (row) row.classList.toggle("hidden", !n);
  if (!n) setRecentOpen(false);
}

// Persist enough to continue a pack after a reload. Chapter results hold text +
// image URLs (not bytes), so they serialise cleanly; images are re-fetched at
// build time. Kept small by storing only what a resume needs.
function saveResume() {
  // Imported chapters carry image bytes that live only in memory (S.imgCache),
  // so a cross-reload resume couldn't rebuild them — skip persisting in that case
  // to avoid ever producing a book with missing images. In-session CAPTCHA
  // continuation still works (it uses in-memory state, not this store).
  if (S.imported.size) return;
  try {
    store && store.set({ resume: {
      url: $("url").value, service: S.service,
      title: $("title").value, author: $("author").value, language: $("language").value,
      filename: $("filename").value, cover: $("cover").value,
      selected: S.queue.map((q) => q.index),
      results: S.results, qpos: S.qpos, total: S.queue.length, ts: Date.now(),
    }});
  } catch (e) { /* ignore (e.g. quota) */ }
}
function clearResume() { try { store && store.remove("resume"); } catch (e) {} }

function setStatus(t) { $("status").textContent = t; }
function setBar(frac) { $("bar").style.width = Math.round(frac * 100) + "%"; }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function extFromMime(m) {
  if (/png/.test(m)) return "png";
  if (/webp/.test(m)) return "webp";
  if (/gif/.test(m)) return "gif";
  if (/svg/.test(m)) return "svg";
  return "jpg";
}
function sanitizeName(s) {
  return (s || "novel").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "novel";
}
function updateCoverPreview() {
  const img = $("coverPreview");
  if (!img) return;
  const u = ($("cover").value || "").trim();
  if (u) { img.src = u; img.classList.remove("hidden"); }
  else { img.removeAttribute("src"); img.classList.add("hidden"); }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  const btn = $("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
}

// Top-level mode switcher: novel | merge | read.
let currentMode = "novel";
function setMode(mode) {
  if (!["novel", "merge", "read"].includes(mode)) mode = "novel";
  if (mode !== "read" && currentMode === "read") { try { readerStop(); } catch (e) {} try { cancelReaderCaptcha(); } catch (e) {} }
  currentMode = mode;
  $("modeNovel").hidden = mode !== "novel";
  $("modeMerge").hidden = mode !== "merge";
  $("modeRead").hidden = mode !== "read";
  document.querySelectorAll("#modeTabs .modetab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  try { store && store.set({ mode }); } catch (e) {}
}

// Per-chapter status dot in the list: '', 'loading', 'ok', 'fail', 'imp'
// (imported/reused), 'refetch' (imported but flagged to re-download).
function setRowStatus(idx, state) {
  const cb = document.querySelector(`#list .item input[data-i="${idx}"]`);
  if (!cb) return;
  const dot = cb.closest(".item").querySelector(".st");
  if (!dot) return;
  dot.className = "st" + (state ? " " + state : "");
  dot.title = state === "imp" ? "Imported — click to re-fetch this chapter"
    : state === "refetch" ? "Will be re-fetched on the next Pack — click to keep the imported version"
    : "";
}
function resetRowDots() {
  for (const q of S.queue) {
    const i = q.index;
    const state = S.results[i]
      ? (S.failed.has(i) ? "fail" : (S.imported.has(i) ? "imp" : "ok"))
      : (i in S.importStash ? "refetch" : "");
    setRowStatus(i, state);
  }
}

// ---------- analyse ----------
async function analyse() {
  const url = $("url").value.trim();
  if (!url) { setStatus("Enter a URL first."); return; }
  $("analyse").disabled = true;
  setStatus("Analysing…");
  try {
    const ov = ($("adapter") && $("adapter").value) || "auto";
    S.adapter = ov === "auto" ? pickAdapter(url) : adapterById(ov, url);
    const meta = await S.adapter.getMeta(url);
    S.meta = meta;
    S.currentUrl = url;
    S.chapters = meta.chapters;
    $("title").value = meta.title || "";
    $("author").value = meta.author || "";
    $("language").value = meta.language || "en";
    $("filename").value = sanitizeName(meta.title);
    $("cover").value = meta.cover || "";
    updateCoverPreview();
    // fresh novel → supersede any in-flight run and clear all run UI
    S.runId++;
    S.running = false; S.cancel = false;
    stopResumePoll();
    hideCaptcha();
    setBar(0);
    S.queue = []; S.qpos = 0; S.results = {}; S.imgCache = {}; S.imgN = 0;
    S.lastBlob = null; S.lastName = null; S.failed = new Set();
    S.imported = new Set(); S.importStash = {}; S.importImgs = null;
    $("download").classList.add("hidden");
    $("update").classList.add("hidden");
    $("retryFailed").classList.add("hidden");
    $("stop").classList.add("hidden");
    renderModes(S.adapter.options());
    renderRange();
    renderList();
    if ($("importInfo")) $("importInfo").textContent = "";
    if ($("refetchAll")) $("refetchAll").classList.add("hidden");
    // JP↔EN chapter-title toggle: offer it for non-English sources.
    S.origTitles = null; S.enTitles = null; S.titlesEn = false;
    if ($("translateTitles")) {
      const nonEn = meta.origLang && meta.origLang !== "en";
      $("translateTitles").classList.toggle("hidden", !nonEn);
      $("translateTitles").textContent = "🌐 Translate titles";
      $("translateTitles").disabled = false;
    }
    $("pack").disabled = false;
    $("reverse").classList.remove("hidden");
    addRecent(url, meta.title);
    // new-chapter detection vs. the count at last pack of this novel
    const prev = S.counts[url];
    if (prev != null && S.chapters.length > prev) {
      S.newFrom = prev; // 0-based: chapters from this index on are new
      $("selNew").classList.remove("hidden");
      setStatus(`Loaded ${S.chapters.length} chapters — ${S.chapters.length - prev} new since last pack. “Select new” to grab just those.`);
    } else {
      S.newFrom = null;
      $("selNew").classList.add("hidden");
      setStatus(`Loaded ${S.chapters.length} chapters via "${S.adapter.label}" adapter.`);
    }
  } catch (e) {
    console.error(e);
    setStatus("Analyse failed: " + e.message);
  } finally {
    $("analyse").disabled = false;
  }
}

function renderModes(opts) {
  const row = $("modeRow"), box = $("modes");
  box.innerHTML = "";
  if (!opts || !opts.services || !opts.services.length) {
    row.classList.add("hidden"); S.service = null; return;
  }
  row.classList.remove("hidden");
  // Service preference order: the ?service= from the opened chapter URL, then the
  // mode remembered from last session, then the adapter's default.
  const has = (id) => id && opts.services.some((s) => s.id === id);
  S.service = has(S.startService) ? S.startService
    : (has(S.prefService) ? S.prefService : (opts.defaultService || opts.services[0].id));
  for (const s of opts.services) {
    const id = "mode_" + s.id;
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="radio" name="mode" value="${s.id}" ${s.id === S.service ? "checked" : ""} id="${id}"><span>${s.label}</span>`;
    box.appendChild(lbl);
  }
  box.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener("change", (e) => { S.service = e.target.value; savePrefs(); })
  );
}

function renderRange() {
  const first = $("first"), last = $("last");
  first.innerHTML = ""; last.innerHTML = "";
  S.chapters.forEach((c, i) => {
    const t = c.title || `Chapter ${i + 1}`;
    first.appendChild(new Option(t, i));
    last.appendChild(new Option(t, i));
  });
  first.value = "0";
  last.value = String(S.chapters.length - 1);
  $("count").textContent = String(S.chapters.length);
  const applyRange = () => {
    const a = +first.value, b = +last.value;
    document.querySelectorAll(".item input").forEach((cb) => {
      const i = +cb.dataset.i; cb.checked = i >= Math.min(a, b) && i <= Math.max(a, b);
    });
    updateSelInfo();
  };
  first.onchange = applyRange;
  last.onchange = applyRange;
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";
  S.chapters.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<span class="inc"><input type="checkbox" data-i="${i}" checked></span><span class="ttl"><span class="st"></span>${escapeHtml(c.title || "Chapter " + (i + 1))}</span>`;
    list.appendChild(row);
  });
  if ($("filter")) $("filter").value = "";
  updateSelInfo();
}
function selectedIndices() {
  return Array.from(document.querySelectorAll(".item input:checked")).map((cb) => +cb.dataset.i);
}

// Flip chapter order (useful for generic TOCs listed newest-first). Resets any
// in-progress run since results are keyed by the old indices.
function reverseChapters() {
  if (!S.chapters.length) return;
  S.chapters.reverse();
  S.queue = []; S.qpos = 0; S.results = {}; S.imgCache = {}; S.imgN = 0; S.failed = new Set();
  S.imported = new Set(); S.importStash = {}; S.importImgs = null;
  if ($("importInfo")) $("importInfo").textContent = "";
  if ($("refetchAll")) $("refetchAll").classList.add("hidden");
  $("download").classList.add("hidden");
  $("update").classList.add("hidden");
  $("retryFailed").classList.add("hidden");
  S.origTitles = null; S.enTitles = null; S.titlesEn = false;
  if ($("translateTitles")) $("translateTitles").textContent = "🌐 Translate titles";
  renderRange();
  renderList();
  setStatus(`Reversed — ${S.chapters.length} chapters.`);
}

// In-place swap of the displayed chapter titles (preserves checkboxes, dots, filter).
function applyTitleDisplay() {
  document.querySelectorAll("#list .item").forEach((row) => {
    const cb = row.querySelector("input"); if (!cb) return;
    const i = +cb.dataset.i;
    const ttl = row.querySelector(".ttl"); if (!ttl) return;
    const dot = ttl.querySelector(".st");
    ttl.textContent = "";
    if (dot) ttl.appendChild(dot);
    ttl.appendChild(document.createTextNode(S.chapters[i] ? (S.chapters[i].title || "Chapter " + (i + 1)) : ""));
  });
  [$("first"), $("last")].forEach((sel) => {
    if (!sel) return;
    Array.from(sel.options).forEach((o) => { const i = +o.value; if (S.chapters[i]) o.textContent = S.chapters[i].title || `Chapter ${i + 1}`; });
  });
}

// Toggle the chapter LIST between original and English-translated titles (kakuyomu etc.).
async function toggleTranslateTitles() {
  if (!S.chapters.length) return;
  const btn = $("translateTitles");
  if (!S.origTitles) S.origTitles = S.chapters.map((c) => c.title);
  if (S.titlesEn) {
    S.chapters.forEach((c, i) => { c.title = S.origTitles[i]; });
    S.titlesEn = false; btn.textContent = "🌐 Translate titles";
  } else {
    if (!S.enTitles) {
      btn.disabled = true; btn.textContent = "Translating…";
      try { S.enTitles = await translateAll(S.origTitles, "en", "auto"); }
      catch (e) { console.warn("title translate failed", e); setStatus("Title translation failed."); btn.disabled = false; btn.textContent = "🌐 Translate titles"; return; }
      btn.disabled = false;
    }
    S.chapters.forEach((c, i) => { c.title = S.enTitles[i] || S.origTitles[i]; });
    S.titlesEn = true; btn.textContent = "🇯🇵 Show original";
  }
  applyTitleDisplay();
}

// ---------- chapter filter ----------
// Titles that are side stories / extras rather than the main run.
const EXTRA_RE = /\b(extra|extras|side[\s-]?story|sidestory|omake|bonus|interlude|afterword|ss)\b|番外|外传|外傳/i;

function chapterTitleAt(i) { return (S.chapters[i] && S.chapters[i].title) || ""; }

// Live-hide rows whose title doesn't contain the filter text (view only —
// checkbox state, which drives packing, is left untouched).
function filterRows() {
  const q = ($("filter").value || "").trim().toLowerCase();
  document.querySelectorAll("#list .item").forEach((row) => {
    const i = +row.querySelector("input").dataset.i;
    const match = !q || chapterTitleAt(i).toLowerCase().includes(q);
    row.classList.toggle("hidden", !match);
  });
  updateSelInfo();
}

// Check/uncheck every row currently visible under the filter.
function setChecksForShown(state) {
  document.querySelectorAll("#list .item").forEach((row) => {
    if (!row.classList.contains("hidden")) row.querySelector("input").checked = state;
  });
  updateSelInfo();
}

function excludeExtras() {
  let n = 0;
  document.querySelectorAll("#list .item input").forEach((cb) => {
    if (EXTRA_RE.test(chapterTitleAt(+cb.dataset.i))) { cb.checked = false; n++; }
  });
  setStatus(n ? `Excluded ${n} extra/side chapter${n === 1 ? "" : "s"}.` : "No extra/side chapters found.");
  updateSelInfo();
}

function updateSelInfo() {
  const el = $("selInfo");
  if (!el) return;
  const rows = document.querySelectorAll("#list .item");
  let shown = 0, sel = 0;
  rows.forEach((r) => {
    if (!r.classList.contains("hidden")) shown++;
    if (r.querySelector("input").checked) sel++;
  });
  el.textContent = rows.length ? `${shown} shown · ${sel}/${rows.length} selected` : "";
}

// ---------- images ----------
async function fetchImage(url) {
  if (S.imgCache[url]) return S.imgCache[url];
  const res = await fetchT(url, { credentials: "include" });
  if (!res.ok) throw new Error("image HTTP " + res.status);
  const blob = await res.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || "image/jpeg";
  const ext = extFromMime(mime);
  S.imgN++;
  const rec = { name: `images/img${S.imgN}.${ext}`, id: `img${S.imgN}`, mime, data: buf };
  S.imgCache[url] = rec;
  return rec;
}

async function chapterToXhtml(chapter) {
  // Imported chapters already carry finished XHTML (and their images are preloaded
  // into S.imgCache), so pass the body straight through — no re-render, no fetch.
  if (typeof chapter.xhtmlBody === "string") return chapter.xhtmlBody;
  let html = "";
  for (const b of chapter.blocks) {
    if (b.type === "text") {
      html += `<p>${escapeHtml(b.text)}</p>\n`;
    } else if (b.type === "image" && b.url) {
      try {
        const rec = await fetchImage(b.url);
        html += `<img src="${rec.name}" alt=""/>\n`;
      } catch (e) {
        console.warn("image failed", b.url, e);
      }
    }
  }
  return html;
}

// ---------- read aloud (live TTS reader off the site) ----------
// Provider for the reader: fetch a chapter's content on demand, reusing the pack
// pipeline (adapter.getChapter → blocks → XHTML, images into S.imgCache).
async function fetchChapterAsXhtml(index) {
  if (!S.results[index]) S.results[index] = await fetchChapterWithCaptcha(index);
  const res = S.results[index];
  const xhtmlBody = await chapterToXhtml(res);
  if (!xhtmlBody || !xhtmlBody.trim()) { // gated / empty (e.g. AI wall) → don't cache it
    delete S.results[index];
    const e = new Error("gated"); e.name = "GateError"; throw e;
  }
  return { title: res.title, xhtmlBody, images: Object.values(S.imgCache) };
}

async function getChapterForReader(index) {
  try {
    return await fetchChapterAsXhtml(index);
  } catch (e) {
    // AI is guest-limited to ~10 chapters. Rather than dead-end, fall back to the
    // site's free, unlimited Web+ translation and keep reading seamlessly.
    const gated = e.name === "GateError" || /registration|guest|10 chapters|limit/i.test(e.message || "");
    if (S.service === "ai" && gated) {
      S.service = "webplus"; savePrefs();
      syncServiceSelectors("webplus");
      delete S.results[index]; S.imgCache = {}; S.imgN = 0; // drop the AI-empty attempt
      const out = await fetchChapterAsXhtml(index);
      out.notice = "AI is free only for the first ~10 chapters (guests) — switched to Web+ to keep reading. Sign in to wtr-lab for AI.";
      return out;
    }
    throw e;
  }
}

// Reflect the active service in both the reader and novel-mode selectors.
function syncServiceSelectors(id) {
  const r = document.querySelector(`#readServiceSeg input[value="${id}"]`); if (r) r.checked = true;
  const n = document.querySelector(`#modes input[value="${id}"]`); if (n) n.checked = true;
}

// A friendlier explanation when the current service can't serve a chapter.
function serviceHint() {
  return S.service === "ai"
    ? "AI translation is free only for the first ~10 chapters on wtr-lab (guests). Switch to Web or Web+ above to keep reading."
    : null;
}

// Fetch a chapter, transparently handling a Turnstile/CAPTCHA block: warn the user,
// open the chapter's page to solve, auto-retry until it clears, then close that tab
// and return focus to the reader. Decoupled from the pack queue.
let readerCaptcha = null;
function cancelReaderCaptcha() { if (readerCaptcha) { readerCaptcha.cancel(); readerCaptcha = null; } }
function fetchChapterWithCaptcha(index) {
  const chapter = S.chapters[index];
  const opts = () => ({ service: S.service, lang: $("language").value.trim() || "en" });
  return new Promise((resolve, reject) => {
    let timer = null, tries = 0, cancelled = false, capTabId = null, blocked = false;
    const hideBar = () => $("readCaptcha").classList.add("hidden");
    const openTab = () => {
      let url = chapter && chapter.url;
      if (!url) return;
      // Point at the exact chapter AND current translation service, so solving the
      // CAPTCHA clears it for what we're actually fetching (e.g. Web+ ch 22).
      if (S.adapter && S.adapter.id === "wtrlab") url += (url.includes("?") ? "&" : "?") + "service=" + encodeURIComponent(S.service || "web");
      chrome.tabs.create({ url, active: true }, (t) => { capTabId = t ? t.id : null; });
    };
    const closeAndReturn = () => {
      if (capTabId != null) { chrome.tabs.remove(capTabId, () => void chrome.runtime.lastError); capTabId = null; }
      if (toolTabId != null) { chrome.tabs.update(toolTabId, { active: true }, () => void chrome.runtime.lastError); if (toolWinId != null) chrome.windows.update(toolWinId, { focused: true }, () => void chrome.runtime.lastError); }
    };
    const done = () => { if (timer) clearTimeout(timer); timer = null; hideBar(); if (readerCaptcha && readerCaptcha.p === resolve) readerCaptcha = null; };
    const cancel = () => { cancelled = true; done(); const e = new Error("Loading cancelled."); e.name = "CancelledError"; reject(e); };
    readerCaptcha = { cancel, p: resolve };
    $("readCaptchaOpen").onclick = openTab;
    $("readCaptchaCancel").onclick = cancel;
    const attempt = async () => {
      if (cancelled) return;
      tries++;
      try {
        const res = await S.adapter.getChapter(chapter, opts());
        done();
        if (blocked) closeAndReturn(); // solved → tidy the CAPTCHA tab and refocus the reader
        resolve(res);
      } catch (e) {
        if (cancelled) return;
        if (e.name === "CaptchaError") {
          if (!blocked) { blocked = true; openTab(); } // first block: warn + open the page
          $("readCaptchaMsg").textContent = `⚠ Hit a CAPTCHA on chapter ${chapter.no || (index + 1)} (${S.service}) — your click did register. Solve it in the opened tab; reading resumes automatically… (${tries})`;
          $("readCaptcha").classList.remove("hidden");
          timer = setTimeout(attempt, 3000);
        } else { done(); reject(new Error(serviceHint() || e.message || "Couldn't load this chapter.")); }
      }
    };
    attempt();
  });
}

// Build the reader's Web / Web+ / AI selector (wtr-lab). Changing it re-fetches.
function renderReadService() {
  const wrap = $("readService"), seg = $("readServiceSeg");
  const opts = S.adapter && S.adapter.options ? S.adapter.options() : null;
  if (!opts || !opts.services || !opts.services.length) { wrap.classList.add("hidden"); return; }
  seg.innerHTML = "";
  for (const s of opts.services) {
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="radio" name="rmode" value="${s.id}" ${s.id === S.service ? "checked" : ""}><span>${s.label}</span>`;
    seg.appendChild(lbl);
  }
  seg.querySelectorAll('input[name=rmode]').forEach((r) => r.addEventListener("change", (e) => {
    S.service = e.target.value; savePrefs();
    const nm = document.querySelector(`#modes input[value="${S.service}"]`); if (nm) nm.checked = true; // keep novel mode in sync
    cancelReaderCaptcha(); // stop waiting on a block from the old service
    S.results = {}; S.imgCache = {}; S.imgN = 0; // drop cached content for the old service
    readerReload();
  }));
  wrap.classList.remove("hidden");
}

async function readAloud() {
  if (!S.chapters.length) {
    const u = $("url").value.trim();
    if (!u) { setStatus("Load a novel URL first."); return; }
    if (!/^https?:\/\//i.test(u)) { setStatus("Open this on a novel chapter page first — the current page isn't a fetchable novel URL."); return; }
    await analyse();
    if (!S.chapters.length) return; // analyse failed / no chapters
  }
  const meta = {
    title: $("title").value.trim() || (S.meta && S.meta.title) || "Novel",
    author: $("author").value.trim() || (S.meta && S.meta.author) || "",
    language: $("language").value.trim() || "en",
  };
  // Start on the chapter/episode the extension was opened on, if we can find it.
  let startIndex = 0;
  if (S.startEpisodeId != null) { // kakuyomu: match by episode id
    const k = S.chapters.findIndex((c) => String(c.id) === String(S.startEpisodeId) || (c.url || "").includes("/episodes/" + S.startEpisodeId));
    if (k >= 0) startIndex = k;
  } else if (S.startChapterNo != null) {
    let k = S.chapters.findIndex((c) => c.no === S.startChapterNo);
    if (k < 0) k = S.chapters.findIndex((c) => { const m = /chapter-(\d+)/i.exec(c.url || ""); return m && +m[1] === S.startChapterNo; });
    if (k >= 0) startIndex = k;
  }
  setMode("read");
  renderReadService();
  openLive({
    meta, chapters: S.chapters,
    bookKey: S.currentUrl ? "u:" + S.currentUrl : null,
    provider: getChapterForReader, startIndex,
  });
}

// ---------- pack ----------
async function startPack() {
  const sel = selectedIndices();
  if (!sel.length) { setStatus("No chapters selected."); return; }
  S.queue = sel.map((i) => ({ index: i, chapter: S.chapters[i] }));
  S.qpos = 0;
  if (S.imported.size) {
    // Keep imported chapters (+ their images) so Pack only fetches the rest;
    // drop any previously-fetched (non-imported) content for a clean re-fetch.
    for (const k of Object.keys(S.results)) if (!S.imported.has(+k)) delete S.results[+k];
    for (const key of Object.keys(S.imgCache)) if (!S.imgCache[key].imported) delete S.imgCache[key];
  } else {
    S.results = {};
    S.imgCache = {};
    S.imgN = 0;
  }
  S.failed = new Set();
  S.cancel = false;
  stopResumePoll();
  await runPack();
}

// Re-fetch only the chapters that failed (were stubbed), keeping the full
// selection so the rebuilt EPUB still contains every chosen chapter.
async function retryFailed() {
  const n = S.failed.size;
  if (!n) return;
  for (const i of S.failed) delete S.results[i]; // drop stubs → they become "undone"
  S.failed = new Set();
  $("retryFailed").classList.add("hidden");
  setStatus(`Retrying ${n} failed chapter${n === 1 ? "" : "s"}…`);
  stopResumePoll();
  await runPack();
}

// Re-pack the CURRENT selection while reusing everything already fetched, so
// changing the range (e.g. 1–20 → 1–50) only downloads the new chapters.
async function updatePack() {
  const sel = selectedIndices();
  if (!sel.length) { setStatus("No chapters selected."); return; }
  S.queue = sel.map((i) => ({ index: i, chapter: S.chapters[i] }));
  S.qpos = 0;
  // keep S.results / S.imgCache / S.imgN so done chapters aren't re-fetched
  const have = sel.filter((i) => S.results[i]).length;
  setStatus(`Updating — reusing ${have} fetched, getting ${sel.length - have} new…`);
  stopResumePoll();
  await runPack();
}

// ---------- import an existing EPUB ----------
const normTitle = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
// A stable-ish key for a chapter: its embedded number ("#101", "Chapter 101",
// leading "101") if present, else the normalized title text.
function titleKey(title) {
  const m = /#\s*(\d+)/.exec(title) || /\bchapter\s*(\d+)/i.exec(title) || /^\s*(\d+)\b/.exec(title || "");
  return m ? "n:" + parseInt(m[1], 10) : "t:" + normTitle(title);
}

// Match imported chapters to the CURRENT site list by identity (source number/URL
// stamped at build time, else chapter-number/title), so the reuse survives
// inserts, reorders and renames. Returns importedIndex -> siteIndex (or -1).
function matchImportedToSite(imported) {
  const N = S.chapters.length;
  const taken = new Array(N).fill(false);
  const assign = new Array(imported.length).fill(-1);
  const byUrl = new Map(), byNo = new Map(), byKey = new Map();
  S.chapters.forEach((c, i) => {
    if (c.url) byUrl.set(c.url, i);
    if (c.no != null) byNo.set(String(c.no), i);
    const k = titleKey(c.title);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const take = (i) => { if (i != null && i >= 0 && !taken[i]) { taken[i] = true; return i; } return -1; };
  let matched = 0;
  imported.forEach((ch, j) => {
    let idx = -1;
    if (ch.srcUrl && byUrl.has(ch.srcUrl)) idx = take(byUrl.get(ch.srcUrl));
    if (idx < 0 && ch.srcNo != null && byNo.has(String(ch.srcNo))) idx = take(byNo.get(String(ch.srcNo)));
    if (idx < 0) {
      const q = byKey.get(titleKey(ch.title));
      if (q) for (const cand of q) if (!taken[cand]) { idx = take(cand); break; }
    }
    assign[j] = idx;
    if (idx >= 0) matched++;
  });
  // Fallback: numberless site whose titles all changed → behave like a straight
  // positional import rather than re-fetching everything.
  if (matched === 0 && imported.length <= N) {
    imported.forEach((ch, j) => { if (!taken[j]) { assign[j] = j; taken[j] = true; } });
  }
  return assign;
}

// Reuse an imported chapter at site index i (content + its images).
function applyImported(i) {
  const st = S.importStash[i];
  if (!st) return;
  S.results[i] = { title: st.title, xhtmlBody: st.xhtmlBody };
  S.imported.add(i);
  S.failed.delete(i);
  if (S.importImgs) for (const name of st.imgNames) { const rec = S.importImgs.get(name); if (rec) S.imgCache[name] = rec; }
  setRowStatus(i, "imp");
}
// Mark an imported chapter to be re-fetched instead (e.g. the author edited it).
// Drops its content and any images no other imported chapter still needs.
function unapplyImported(i) {
  const st = S.importStash[i];
  if (!st) return;
  S.imported.delete(i);
  delete S.results[i];
  for (const name of st.imgNames) {
    let stillUsed = false;
    for (const j of S.imported) { const s = S.importStash[j]; if (s && s.imgNames.includes(name)) { stillUsed = true; break; } }
    if (!stillUsed) delete S.imgCache[name];
  }
  setRowStatus(i, "refetch");
}
// Flip every imported chapter between reuse and re-fetch in one click.
function refetchAllToggle() {
  const idxs = Object.keys(S.importStash).map(Number);
  if (!idxs.length || S.running) return;
  const anyApplied = idxs.some((i) => S.imported.has(i));
  if (anyApplied) {
    idxs.forEach((i) => { if (S.imported.has(i)) unapplyImported(i); });
    setStatus(`All ${idxs.length} imported chapters flagged to re-fetch on the next Pack.`);
  } else {
    idxs.forEach((i) => applyImported(i));
    setStatus(`All ${idxs.length} chapters restored from your import (won't be re-fetched).`);
  }
  updateRefetchAllLabel();
  updateSelInfo();
}
// Show/label the "Re-fetch all" toggle based on the current import state.
function updateRefetchAllLabel() {
  const b = $("refetchAll");
  if (!b) return;
  const idxs = Object.keys(S.importStash).map(Number);
  if (!idxs.length) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  b.textContent = idxs.some((i) => S.imported.has(i)) ? "↻ Re-fetch all" : "Keep all imported";
}

// Forget any prior import (content, images, stash).
function clearImport() {
  for (const k of Object.keys(S.results)) if (S.imported.has(+k)) delete S.results[+k];
  for (const key of Object.keys(S.imgCache)) if (S.imgCache[key] && S.imgCache[key].imported) delete S.imgCache[key];
  S.imported = new Set();
  S.importStash = {};
  S.importImgs = null;
}

// Import a previously-built .epub and reuse its chapters, so a later pack only
// fetches the newly-released (or manually re-flagged) ones. Chapters are matched
// to the site by identity — surviving inserts, reorders and renames — not by
// position. No re-download and no re-translation of the reused chapters.
async function importEpub(file) {
  if (!file) return;
  const info = $("importInfo");
  if (!S.chapters.length) { setStatus("Load & Analyse the novel first, then Import EPUB."); return; }
  if (S.running) { setStatus("Finish or stop the current pack before importing."); return; }
  setStatus(`Reading “${file.name}”…`);
  try {
    const buf = await file.arrayBuffer();
    const { chapters, images } = await parseEpub(buf);

    clearImport();
    S.importImgs = new Map(images.map((r) => [r.name, r]));
    const assign = matchImportedToSite(chapters);

    let placed = 0, orphan = 0, renamed = 0;
    chapters.forEach((ch, j) => {
      const i = assign[j];
      if (i < 0) { orphan++; return; }
      S.importStash[i] = { title: ch.title, xhtmlBody: ch.xhtmlBody, imgNames: ch.imgNames || [] };
      applyImported(i);
      if (normTitle(ch.title) && normTitle(S.chapters[i].title) && normTitle(ch.title) !== normTitle(S.chapters[i].title)) renamed++;
      placed++;
    });

    const toFetch = S.chapters.length - placed;
    let m = `Imported ${placed} chapter${placed === 1 ? "" : "s"} — ${toFetch} to fetch.`;
    if (orphan) m += ` ${orphan} not on the site any more (skipped).`;
    if (renamed) m += ` ${renamed} title${renamed === 1 ? "" : "s"} changed.`;
    m += ` Click “Pack EPUB” to build. Tip: click a green ● to re-fetch that chapter (e.g. if the author edited it).`;
    setStatus(m);
    if (info) info.textContent = `${placed} reused · ${toFetch} to fetch${orphan ? ` · ${orphan} skipped` : ""}`;
    updateRefetchAllLabel();
  } catch (e) {
    console.error("import failed", e);
    setStatus("Import failed: " + e.message);
    if (info) info.textContent = "import failed";
  }
}

function packDone() {
  let d = 0;
  for (const q of S.queue) if (S.results[q.index]) d++;
  return d;
}
function firstUndonePos() {
  for (let k = 0; k < S.queue.length; k++) if (!S.results[S.queue[k].index]) return k;
  return S.queue.length;
}
function fmtEta(ms) {
  if (!isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s left`;
  return `~${Math.round(s / 60)} min left`;
}

async function runPack() {
  if (S.running) return;
  S.running = true;
  S.cancel = false;
  const myRun = ++S.runId;
  $("pack").disabled = true;
  $("download").classList.add("hidden");   // stale until the (re)build finishes
  $("retryFailed").classList.add("hidden");
  $("stop").classList.remove("hidden");
  hideCaptcha();
  resetRowDots();
  const conc = ($("parallel") && $("parallel").checked) ? 3 : 1;
  const delay = S.adapter.id === "wtrlab" ? 1200 : 400;
  const opts = { service: S.service, lang: $("language").value.trim() || "en" };
  const total = S.queue.length;

  let cursor = 0;             // next queue position to claim
  let paused = false;         // a worker hit a CAPTCHA
  let fetchedThisRun = 0;     // for ETA (only real fetches count)
  const startedAt = Date.now();

  const tick = () => {
    const done = packDone();
    setBar(total ? done / total : 0);
    let eta = "";
    if (fetchedThisRun > 0 && done < total) {
      const perItem = (Date.now() - startedAt) / fetchedThisRun; // wall time already reflects concurrency
      eta = " · " + fmtEta((total - done) * perItem);
    }
    setStatus(`Fetching ${done} / ${total}…${eta}`);
  };

  async function worker() {
    while (S.running && !paused && !S.cancel && S.runId === myRun) {
      // claim the next not-yet-fetched queue entry (synchronous → race-free)
      let claim = null;
      while (cursor < total) {
        const q = S.queue[cursor++];
        if (!S.results[q.index]) { claim = q; break; }
      }
      if (!claim) return;
      const idx = claim.index;
      setRowStatus(idx, "loading");
      try {
        const res = await S.adapter.getChapter(claim.chapter, opts);
        if (S.runId !== myRun) return; // superseded (user switched novels) — drop result
        S.results[idx] = res;
        S.failed.delete(idx);
        setRowStatus(idx, "ok");
      } catch (e) {
        if (S.runId !== myRun) return; // superseded — ignore
        if (e.name === "CaptchaError") { paused = true; setRowStatus(idx, ""); return; }
        console.error("chapter failed", idx, e);
        S.results[idx] = { title: (S.chapters[idx] && S.chapters[idx].title) || `Chapter ${idx + 1}`, blocks: [{ type: "text", text: "[Failed to load this chapter.]" }] };
        S.failed.add(idx);
        setRowStatus(idx, "fail");
      }
      fetchedThisRun++;
      tick();
      saveResume();
      await sleep(delay);
    }
  }

  try {
    tick();
    await Promise.all(Array.from({ length: conc }, () => worker()));
    if (S.runId !== myRun) return; // a newer analyse/run took over
    if (S.cancel) {
      S.running = false;
      $("pack").disabled = false;
      saveResume();
      const done = packDone();
      if (done > 0) $("update").classList.remove("hidden");
      setStatus(`Stopped at ${done} / ${total}. “Update EPUB” to build/continue, or Pack to restart.`);
      return;
    }
    if (paused) {
      S.running = false;
      S.qpos = firstUndonePos();
      saveResume();
      showCaptcha();
      setStatus(`Paused at chapter ${S.qpos + 1} (CAPTCHA).`);
      return;
    }
    await finishPack();
  } finally {
    if (S.runId === myRun) {
      $("stop").classList.add("hidden");
      if (S.running) { S.running = false; $("pack").disabled = false; }
    }
  }
}

async function finishPack() {
  setStatus("Building EPUB (images + packaging)…");
  setBar(1);
  // The cover IMAGE (the file's thumbnail) is always included when a cover URL
  // is present. The in-book front pages — the visible cover page plus the
  // title/author/synopsis page — are an opt-out via includeTitlePage.
  const includeCover = true;
  const includeTitlePage = $("includeTitlePage") ? $("includeTitlePage").checked : true;
  // cover
  let cover = null;
  const coverUrl = $("cover").value.trim();
  if (includeCover && coverUrl) {
    try {
      const res = await fetchT(coverUrl, { credentials: "include" });
      const blob = await res.blob();
      cover = { data: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "image/jpeg", ext: extFromMime(blob.type || "image/jpeg") };
    } catch (e) { console.warn("cover failed", e); }
  }
  // chapters in queue order, building xhtml (this also downloads inline images)
  const chapters = [];
  let done = 0;
  for (const { index } of S.queue) {
    const ch = S.results[index];
    done++;
    setStatus(`Packaging ${done} / ${S.queue.length} (images)…`);
    const body = await chapterToXhtml(ch);
    const src = S.chapters[index] || {};
    chapters.push({ title: ch.title, xhtmlBody: body, srcNo: src.no, srcUrl: src.url });
  }
  const images = Object.values(S.imgCache).map((r) => ({ id: r.id, name: r.name, mime: r.mime, data: r.data }));
  // Language tag: the field value as always, except a non-translated generic
  // download uses the detected source language — but only if the user hasn't
  // edited the field away from its auto-filled "en" (never touches translate
  // mode, which keeps "en" for both the tag and the translation target).
  let language = $("language").value.trim() || "en";
  if (S.service === "raw" && S.meta && S.meta.origLang && language === "en") {
    language = S.meta.origLang; // Original-mode download → tag with the source language
  }
  const meta = {
    title: $("title").value.trim() || "Untitled",
    author: $("author").value.trim() || "Unknown",
    language,
    description: (S.meta && S.meta.description) || "",
    subjects: (S.meta && S.meta.subjects) || [],
    cover,
    includeCover,
    includeTitlePage,
    idSeed: S.currentUrl || null,
  };
  const blob = buildEpub(meta, chapters, images);
  const fname = sanitizeName($("filename").value) + ".epub";
  // Don't auto-download — hold the file and let the user click Download.
  S.lastBlob = blob;
  S.lastName = fname;
  S.running = false;
  $("pack").disabled = false;
  $("stop").classList.add("hidden");
  $("download").classList.remove("hidden");
  $("update").classList.remove("hidden");
  clearResume(); // this run is complete
  // record the chapter count so a later analyse can flag newly-released chapters
  if (store && S.currentUrl) {
    S.counts[S.currentUrl] = S.chapters.length;
    try { store.set({ counts: S.counts }); } catch (e) {}
  }
  const failN = S.failed.size;
  if (failN) {
    $("retryFailed").textContent = `Retry ${failN} failed`;
    $("retryFailed").classList.remove("hidden");
    setStatus(`Ready — ${chapters.length} chapters, ${failN} failed. Download, or Retry failed.`);
  } else {
    $("retryFailed").classList.add("hidden");
    setStatus(`Ready — ${chapters.length} chapters, ${images.length} images. Click “Download EPUB”.`);
  }
}

function doDownload() {
  if (!S.lastBlob) { setStatus("Nothing packed yet — click Pack EPUB first."); return; }
  const objUrl = URL.createObjectURL(S.lastBlob);
  chrome.downloads.download({ url: objUrl, filename: S.lastName, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  });
  setStatus(`Downloading ${S.lastName}…`);
}

// Restore an interrupted pack saved before a reload, then continue it.
async function resumeFromSaved(saved) {
  $("resumeBar").classList.add("hidden");
  $("url").value = saved.url || "";
  setStatus("Restoring previous pack — re-analysing novel…");
  await analyse(); // rebuilds adapter state + chapter list (and clears run state)
  if (!S.chapters.length) { setStatus("Couldn't restore — analyse failed. Try again."); return; }
  // reapply the fields the user may have customised
  if (saved.title) $("title").value = saved.title;
  if (saved.author) $("author").value = saved.author;
  if (saved.language) $("language").value = saved.language;
  if (saved.filename) $("filename").value = saved.filename;
  if (saved.cover) { $("cover").value = saved.cover; updateCoverPreview(); }
  if (saved.service) {
    S.service = saved.service;
    const radio = document.querySelector(`input[name=mode][value="${saved.service}"]`);
    if (radio) radio.checked = true;
  }
  // restore the queue, the already-fetched chapters, and the selection
  S.queue = (saved.selected || []).map((i) => ({ index: i, chapter: S.chapters[i] })).filter((q) => q.chapter);
  S.results = saved.results || {};
  // Rebuild the failed set from restored stubs so Retry failed still works.
  S.failed = new Set();
  for (const k in S.results) {
    const r = S.results[k];
    if (r && r.blocks && r.blocks.length === 1 && r.blocks[0].type === "text" && /^\[Failed to load/.test(r.blocks[0].text || "")) S.failed.add(+k);
  }
  S.qpos = Math.min(saved.qpos || 0, S.queue.length);
  const selSet = new Set(saved.selected || []);
  document.querySelectorAll(".item input").forEach((cb) => { cb.checked = selSet.has(+cb.dataset.i); });
  setStatus(`Resuming — ${S.qpos}/${S.queue.length} chapters already fetched.`);
  await runPack();
}

// Load saved settings, and show the Resume banner if a pack was interrupted.
function loadPrefsAndResume() {
  return new Promise((resolve) => {
    if (!store) { resolve(); return; }
    try {
      store.get(["prefs", "resume", "recent", "counts", "mode"], (o) => {
        if (o && o.mode) setMode(o.mode);
        const p = o && o.prefs;
        if (p) {
          S.prefService = p.service || null;
          if (p.lang) $("language").value = p.lang;
          if (typeof p.autoClose === "boolean" && $("capAutoClose")) $("capAutoClose").checked = p.autoClose;
          if (typeof p.parallel === "boolean" && $("parallel")) $("parallel").checked = p.parallel;
          // Title-page pref, falling back to the old single frontMatter pref.
          const tp = typeof p.includeTitlePage === "boolean" ? p.includeTitlePage
                   : (typeof p.frontMatter === "boolean" ? p.frontMatter : true);
          if ($("includeTitlePage")) $("includeTitlePage").checked = tp;
          applyTheme(p.theme === "light" ? "light" : "dark");
        }
        if (o && Array.isArray(o.recent)) {
          const deduped = dedupeRecent(o.recent);
          if (deduped.length !== o.recent.length) { try { store.set({ recent: deduped }); } catch (e) {} }
          renderRecent(deduped);
        }
        if (o && o.counts && typeof o.counts === "object") S.counts = o.counts;
        const r = o && o.resume;
        const total = r && (r.total || (r.selected ? r.selected.length : 0));
        if (r && r.selected && r.selected.length && (r.qpos || 0) < total) {
          $("resumeMsg").textContent = `Unfinished pack: “${r.title || r.url}” — ${r.qpos || 0}/${total} chapters fetched.`;
          $("resumeBar").classList.remove("hidden");
          $("resumeBtn").onclick = () => resumeFromSaved(r);
          $("resumeDismiss").onclick = () => { $("resumeBar").classList.add("hidden"); clearResume(); };
        }
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

// ---------- captcha panel ----------
function showCaptcha() { $("captcha").classList.remove("hidden"); $("pack").disabled = true; }
function hideCaptcha() { $("captcha").classList.add("hidden"); }

// Auto-resume: after the user opens the chapter tab to solve the challenge, we
// quietly re-probe that same chapter every few seconds and continue the pack
// the instant it succeeds — no need to click Retry.
let resumeTimer = null;
let captchaTabId = null;              // the tab we opened for the user to solve
let toolTabId = null, toolWinId = null; // this tool's own tab, to return focus to
const RESUME_EVERY_MS = 3000;
const RESUME_MAX_TRIES = 80; // ~4 min, then fall back to the manual Retry button

function stopResumePoll() { if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; } }

// After the challenge is solved, optionally close the CAPTCHA tab and bring
// this tool's tab back to the front (controlled by the panel checkbox).
function closeCaptchaTabAndReturn() {
  const wantClose = (() => { const el = $("capAutoClose"); return el ? el.checked : false; })();
  if (wantClose && captchaTabId != null) {
    chrome.tabs.remove(captchaTabId, () => void chrome.runtime.lastError);
  }
  captchaTabId = null;
  if (wantClose && toolTabId != null) {
    chrome.tabs.update(toolTabId, { active: true }, () => void chrome.runtime.lastError);
    if (toolWinId != null) chrome.windows.update(toolWinId, { focused: true }, () => void chrome.runtime.lastError);
  }
}

function startResumePoll() {
  stopResumePoll();
  const opts = { service: S.service, lang: $("language").value.trim() || "en" };
  let tries = 0;
  const tick = async () => {
    const q = S.queue[S.qpos];
    if (!q || S.running) { stopResumePoll(); return; }
    tries++;
    try {
      S.results[q.index] = await S.adapter.getChapter(q.chapter, opts);
      // Solved — resume the build from where it paused.
      stopResumePoll();
      hideCaptcha();
      closeCaptchaTabAndReturn();
      runPack();
    } catch (e) {
      if (e.name === "CaptchaError" && tries < RESUME_MAX_TRIES) {
        setStatus(`Waiting for you to solve the CAPTCHA in the opened tab… (auto-resumes, ${tries})`);
        resumeTimer = setTimeout(tick, RESUME_EVERY_MS);
      } else if (e.name === "CaptchaError") {
        stopResumePoll();
        setStatus("Still blocked — solve it in the tab, then click Retry.");
      } else {
        stopResumePoll();
        setStatus("Retry failed: " + e.message + " — click Retry.");
      }
    }
  };
  setStatus("Waiting for you to solve the CAPTCHA in the opened tab… (auto-resumes)");
  resumeTimer = setTimeout(tick, RESUME_EVERY_MS);
}
function captchaUrl() {
  // Open a real page on the site so the user can clear the challenge; the
  // resulting Cloudflare cookie then applies to our subsequent fetches. Point at
  // the stalled chapter AND the current translation service, so solving it clears
  // the challenge for exactly what the packer is fetching (e.g. Web+ ch 12).
  const q = S.queue[S.qpos];
  let url = (q && q.chapter && q.chapter.url) ? q.chapter.url : "";
  if (!url && S.adapter && S.adapter.id === "wtrlab" && q && q.chapter && q.chapter.no) {
    const root = ($("url").value || "").trim().replace(/\/chapter-\d+\/?$/i, "").replace(/\/+$/, "");
    url = `${root}/chapter-${q.chapter.no}`;
  }
  if (!url) url = ($("url").value || "").trim();
  if (url && S.adapter && S.adapter.id === "wtrlab") url += (url.includes("?") ? "&" : "?") + "service=" + encodeURIComponent(S.service || "web");
  return url;
}

// ---------- wire up ----------
async function init() {
  // Remember our own tab so we can return focus here after a CAPTCHA solve.
  chrome.tabs.getCurrent((t) => { if (t) { toolTabId = t.id; toolWinId = t.windowId; } });

  // Hosts we auto-analyse on when the extension is opened from one of their pages.
  const AUTO_HOSTS = ["wtr-lab.com", "genesistudio.com", "kakuyomu.jp"];
  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  let autoAnalyse = false;
  if (src) {
    let u = src;
    try {
      const host = new URL(src).hostname;
      if (AUTO_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
        autoAnalyse = true;
        // wtr-lab: normalise a chapter reader URL back to the novel page, and
        // remember which chapter + translation service were open so "Read aloud"
        // can start there with the same service.
        if (host.endsWith("wtr-lab.com")) {
          const cm = /\/chapter-(\d+)/i.exec(src);
          if (cm) S.startChapterNo = +cm[1];
          const svc = new URL(src).searchParams.get("service");
          if (svc) S.startService = svc;
          u = src.replace(/\/chapter-\d+\/?(?:[?#].*)?$/i, "");
        }
        // kakuyomu: remember the opened episode id so Read-aloud starts on it.
        if (host.endsWith("kakuyomu.jp")) {
          const em = /\/episodes\/(\d+)/.exec(src);
          if (em) S.startEpisodeId = em[1];
        }
      }
    } catch {}
    $("url").value = u;
  }

  $("analyse").addEventListener("click", analyse);
  $("url").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); analyse(); } });
  document.addEventListener("keydown", (e) => {
    // Enter anywhere outside a field, when a built file is ready → download
    if (e.key !== "Enter" || $("download").classList.contains("hidden")) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (!/INPUT|SELECT|TEXTAREA|BUTTON/.test(tag)) { e.preventDefault(); doDownload(); }
  });
  if ($("readAloud")) $("readAloud").addEventListener("click", readAloud);
  $("pack").addEventListener("click", startPack);
  $("stop").addEventListener("click", () => { S.cancel = true; setStatus("Stopping…"); });
  $("update").addEventListener("click", updatePack);
  if ($("importEpub") && $("epubFile")) {
    $("importEpub").addEventListener("click", () => $("epubFile").click());
    $("epubFile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      importEpub(f);
      e.target.value = ""; // allow re-importing the same file
    });
  }
  if ($("refetchAll")) $("refetchAll").addEventListener("click", refetchAllToggle);
  $("retryFailed").addEventListener("click", retryFailed);
  $("download").addEventListener("click", doDownload);
  $("themeToggle").addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(now); savePrefs();
  });
  $("selNew").addEventListener("click", () => {
    if (S.newFrom == null) return;
    document.querySelectorAll("#list .item input").forEach((cb) => { cb.checked = (+cb.dataset.i) >= S.newFrom; });
    updateSelInfo();
  });
  if ($("recentToggle")) $("recentToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const list = $("recentList");
    setRecentOpen(list ? list.classList.contains("hidden") : true);
  });
  document.addEventListener("click", (e) => {
    if (!(e.target.closest && e.target.closest(".recent-dd"))) setRecentOpen(false);
  });
  if ($("recentClear")) $("recentClear").addEventListener("click", () => {
    try { store && store.set({ recent: [] }); } catch (e) { /* ignore */ }
    setRecentOpen(false);
    renderRecent([]);
  });
  $("parallel").addEventListener("change", savePrefs);
  if ($("includeTitlePage")) $("includeTitlePage").addEventListener("change", savePrefs);
  $("cover").addEventListener("input", updateCoverPreview);
  $("language").addEventListener("change", savePrefs);
  const cac = $("capAutoClose"); if (cac) cac.addEventListener("change", savePrefs);
  const cp = $("coverPreview");
  if (cp) {
    cp.onerror = () => cp.classList.add("hidden");
    cp.addEventListener("click", () => cp.classList.toggle("zoomed")); // click to enlarge/shrink
  }
  $("selAll").addEventListener("click", () => { document.querySelectorAll(".item input").forEach((c) => (c.checked = true)); updateSelInfo(); });
  $("selNone").addEventListener("click", () => { document.querySelectorAll(".item input").forEach((c) => (c.checked = false)); updateSelInfo(); });
  $("reverse").addEventListener("click", reverseChapters);
  if ($("translateTitles")) $("translateTitles").addEventListener("click", toggleTranslateTitles);
  $("filter").addEventListener("input", filterRows);
  $("filterCheck").addEventListener("click", () => setChecksForShown(true));
  $("filterUncheck").addEventListener("click", () => setChecksForShown(false));
  $("excludeExtras").addEventListener("click", excludeExtras);
  $("list").addEventListener("change", updateSelInfo);
  // Click an imported chapter's status dot to toggle reuse ↔ re-fetch.
  $("list").addEventListener("click", (e) => {
    const dot = e.target.closest && e.target.closest(".st");
    if (!dot) return;
    const cb = dot.closest(".item") && dot.closest(".item").querySelector("input");
    if (!cb) return;
    const i = +cb.dataset.i;
    if (S.running || !(i in S.importStash)) return; // only togglable while idle, imported only
    if (S.imported.has(i)) { unapplyImported(i); setStatus(`Chapter ${i + 1} will be re-fetched on the next Pack.`); }
    else { applyImported(i); setStatus(`Chapter ${i + 1} restored from your import (won't be re-fetched).`); }
    updateRefetchAllLabel();
    updateSelInfo();
  });

  $("capOpen").addEventListener("click", () => {
    const u = captchaUrl();
    if (u) chrome.tabs.create({ url: u }, (tab) => { captchaTabId = tab ? tab.id : null; });
    startResumePoll();
  });
  $("capCopy").addEventListener("click", () => { const u = captchaUrl(); if (u) navigator.clipboard.writeText(u); setStatus("CAPTCHA link copied."); });
  $("capRetry").addEventListener("click", () => { stopResumePoll(); hideCaptcha(); runPack(); });

  // mode tabs + the two offline modes
  document.querySelectorAll("#modeTabs .modetab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  initMerge();
  initRead();

  // Load saved settings + any interrupted pack before auto-analysing.
  await loadPrefsAndResume();

  // Opened the extension while on wtr-lab → force novel mode and analyse right away.
  if (autoAnalyse) { setMode("novel"); analyse(); }
}
init();
