import { pickAdapter } from "./adapters/registry.js";
import { buildEpub } from "./epub.js";

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
    }});
  } catch (e) { /* ignore */ }
}

// Recent novels list (newest first, capped).
function addRecent(url, title) {
  if (!store || !url) return;
  try {
    store.get("recent", (o) => {
      let list = (o && Array.isArray(o.recent)) ? o.recent : [];
      list = list.filter((r) => r && r.url !== url);
      list.unshift({ url, title: title || url, ts: Date.now() });
      list = list.slice(0, 8);
      store.set({ recent: list });
      renderRecent(list);
    });
  } catch (e) { /* ignore */ }
}
function renderRecent(list) {
  const sel = $("recent");
  if (!sel) return;
  sel.innerHTML = '<option value="">Recent novels…</option>';
  (list || []).forEach((r) => {
    const o = document.createElement("option");
    o.value = r.url; o.textContent = r.title || r.url;
    sel.appendChild(o);
  });
  const row = $("recentRow");
  if (row) row.classList.toggle("hidden", !(list && list.length));
}

// Persist enough to continue a pack after a reload. Chapter results hold text +
// image URLs (not bytes), so they serialise cleanly; images are re-fetched at
// build time. Kept small by storing only what a resume needs.
function saveResume() {
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

// ---------- analyse ----------
async function analyse() {
  const url = $("url").value.trim();
  if (!url) { setStatus("Enter a URL first."); return; }
  $("analyse").disabled = true;
  setStatus("Analysing…");
  try {
    S.adapter = pickAdapter(url);
    const meta = await S.adapter.getMeta(url);
    S.meta = meta;
    S.chapters = meta.chapters;
    $("title").value = meta.title || "";
    $("author").value = meta.author || "";
    $("language").value = meta.language || "en";
    $("filename").value = sanitizeName(meta.title);
    $("cover").value = meta.cover || "";
    updateCoverPreview();
    // fresh novel → drop any previous run + built file
    S.queue = []; S.qpos = 0; S.results = {}; S.imgCache = {}; S.imgN = 0;
    S.lastBlob = null; S.lastName = null; S.failed = new Set();
    $("download").classList.add("hidden");
    $("update").classList.add("hidden");
    $("retryFailed").classList.add("hidden");
    renderModes(S.adapter.options());
    renderRange();
    renderList();
    $("pack").disabled = false;
    addRecent(url, meta.title);
    setStatus(`Loaded ${S.chapters.length} chapters via "${S.adapter.label}" adapter.`);
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
  // Prefer the mode remembered from last session, if this adapter offers it.
  S.service = (S.prefService && opts.services.some((s) => s.id === S.prefService))
    ? S.prefService : (opts.defaultService || opts.services[0].id);
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
    row.innerHTML = `<span class="inc"><input type="checkbox" data-i="${i}" checked></span><span class="ttl">${escapeHtml(c.title || "Chapter " + (i + 1))}</span>`;
    list.appendChild(row);
  });
  if ($("filter")) $("filter").value = "";
  updateSelInfo();
}
function selectedIndices() {
  return Array.from(document.querySelectorAll(".item input:checked")).map((cb) => +cb.dataset.i);
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

// ---------- pack ----------
async function startPack() {
  const sel = selectedIndices();
  if (!sel.length) { setStatus("No chapters selected."); return; }
  S.queue = sel.map((i) => ({ index: i, chapter: S.chapters[i] }));
  S.qpos = 0;
  S.results = {};
  S.imgCache = {};
  S.imgN = 0;
  S.failed = new Set();
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
  $("pack").disabled = true;
  $("download").classList.add("hidden");   // stale until the (re)build finishes
  $("retryFailed").classList.add("hidden");
  hideCaptcha();
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
    while (S.running && !paused) {
      // claim the next not-yet-fetched queue entry (synchronous → race-free)
      let claim = null;
      while (cursor < total) {
        const q = S.queue[cursor++];
        if (!S.results[q.index]) { claim = q; break; }
      }
      if (!claim) return;
      const idx = claim.index;
      try {
        S.results[idx] = await S.adapter.getChapter(claim.chapter, opts);
        S.failed.delete(idx);
      } catch (e) {
        if (e.name === "CaptchaError") { paused = true; return; }
        console.error("chapter failed", idx, e);
        S.results[idx] = { title: (S.chapters[idx] && S.chapters[idx].title) || `Chapter ${idx + 1}`, blocks: [{ type: "text", text: "[Failed to load this chapter.]" }] };
        S.failed.add(idx);
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
    if (S.running) { S.running = false; $("pack").disabled = false; }
  }
}

async function finishPack() {
  setStatus("Building EPUB (images + packaging)…");
  setBar(1);
  // cover
  let cover = null;
  const coverUrl = $("cover").value.trim();
  if (coverUrl) {
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
    chapters.push({ title: ch.title, xhtmlBody: body });
  }
  const images = Object.values(S.imgCache).map((r) => ({ id: r.id, name: r.name, mime: r.mime, data: r.data }));
  const meta = {
    title: $("title").value.trim() || "Untitled",
    author: $("author").value.trim() || "Unknown",
    language: $("language").value.trim() || "en",
    cover,
  };
  const blob = buildEpub(meta, chapters, images);
  const fname = sanitizeName($("filename").value) + ".epub";
  // Don't auto-download — hold the file and let the user click Download.
  S.lastBlob = blob;
  S.lastName = fname;
  S.running = false;
  $("pack").disabled = false;
  $("download").classList.remove("hidden");
  $("update").classList.remove("hidden");
  clearResume(); // this run is complete
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
      store.get(["prefs", "resume", "recent"], (o) => {
        const p = o && o.prefs;
        if (p) {
          S.prefService = p.service || null;
          if (p.lang) $("language").value = p.lang;
          if (typeof p.autoClose === "boolean" && $("capAutoClose")) $("capAutoClose").checked = p.autoClose;
          if (typeof p.parallel === "boolean" && $("parallel")) $("parallel").checked = p.parallel;
        }
        if (o && Array.isArray(o.recent)) renderRecent(o.recent);
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
  // resulting Cloudflare cookie then applies to our subsequent fetches.
  const q = S.queue[S.qpos];
  if (q && q.chapter && q.chapter.url) return q.chapter.url; // generic adapter
  // wtr-lab: the novel homepage does NOT trigger the challenge, so point
  // straight at the stalled chapter's reader page (…/novel/id/slug/chapter-N).
  // That makes the CAPTCHA appear immediately — no need to hand-pick a chapter.
  const base = ($("url").value || "").trim();
  if (S.adapter && S.adapter.id === "wtrlab" && q && q.chapter && q.chapter.no) {
    const root = base.replace(/\/chapter-\d+\/?$/i, "").replace(/\/+$/, "");
    return `${root}/chapter-${q.chapter.no}`;
  }
  return base;
}

// ---------- wire up ----------
async function init() {
  // Remember our own tab so we can return focus here after a CAPTCHA solve.
  chrome.tabs.getCurrent((t) => { if (t) { toolTabId = t.id; toolWinId = t.windowId; } });

  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  let autoWtr = false;
  if (src) {
    let u = src;
    try {
      if (new URL(src).hostname.endsWith("wtr-lab.com")) {
        // Normalize a chapter reader URL back to the novel page, and remember
        // to auto-analyse it so opening the extension on the site just works.
        u = src.replace(/\/chapter-\d+\/?(?:[?#].*)?$/i, "");
        autoWtr = true;
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
  $("pack").addEventListener("click", startPack);
  $("update").addEventListener("click", updatePack);
  $("retryFailed").addEventListener("click", retryFailed);
  $("download").addEventListener("click", doDownload);
  $("recent").addEventListener("change", (e) => {
    const v = e.target.value; if (!v) return;
    $("url").value = v; e.target.value = ""; analyse();
  });
  $("parallel").addEventListener("change", savePrefs);
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
  $("filter").addEventListener("input", filterRows);
  $("filterCheck").addEventListener("click", () => setChecksForShown(true));
  $("filterUncheck").addEventListener("click", () => setChecksForShown(false));
  $("excludeExtras").addEventListener("click", excludeExtras);
  $("list").addEventListener("change", updateSelInfo);

  $("capOpen").addEventListener("click", () => {
    const u = captchaUrl();
    if (u) chrome.tabs.create({ url: u }, (tab) => { captchaTabId = tab ? tab.id : null; });
    startResumePoll();
  });
  $("capCopy").addEventListener("click", () => { const u = captchaUrl(); if (u) navigator.clipboard.writeText(u); setStatus("CAPTCHA link copied."); });
  $("capRetry").addEventListener("click", () => { stopResumePoll(); hideCaptcha(); runPack(); });

  // Load saved settings + any interrupted pack before auto-analysing.
  await loadPrefsAndResume();

  // Opened the extension while on wtr-lab → load & analyse the novel right away.
  if (autoWtr) analyse();
}
init();
