// EPUB Merger — combine several EPUBs entirely offline, arrange the chapters, and
// export one merged book. Reuses parseEpub (read) and buildEpub (write).
import { parseEpub } from "./epubread.js";
import { buildEpub } from "./epub.js";

const $ = (id) => document.getElementById(id);

const M = { entries: [], images: new Map(), cover: null, seq: 0, coverUrl: null };
// entry: { id, title, xhtmlBody, srcNo, srcUrl, imgNames, source, include }

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
function numOf(e) {
  if (e.srcNo != null && e.srcNo !== "" && !isNaN(+e.srcNo)) return +e.srcNo;
  const m = /#\s*(\d+)/.exec(e.title) || /\bchapter\s*(\d+)/i.exec(e.title) || /^\s*(\d+)\b/.exec(e.title || "");
  return m ? +m[1] : Number.MAX_SAFE_INTEGER;
}
function keyOf(e) {
  if (e.srcUrl) return "u:" + e.srcUrl;
  if (e.srcNo != null && e.srcNo !== "") return "n:" + e.srcNo;
  return "t:" + norm(e.title);
}
function sanitize(s) {
  return (s || "novel").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "merged";
}
function setStatus(t) { $("mergeStatus").textContent = t; }

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setStatus(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  let added = 0, failed = 0;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const { chapters, images, meta, cover } = await parseEpub(buf, { nsPrefix: "m" + M.seq + "-" });
      M.seq++;
      for (const rec of images) M.images.set(rec.name, rec);
      for (const ch of chapters) {
        M.entries.push({
          id: "e" + Math.random().toString(36).slice(2, 9),
          title: ch.title, xhtmlBody: ch.xhtmlBody, srcNo: ch.srcNo, srcUrl: ch.srcUrl,
          imgNames: ch.imgNames || [], source: file.name, include: true,
        });
      }
      // Metadata + cover from the first file that has them.
      if (!$("mergeTitle").value && meta && meta.title) $("mergeTitle").value = meta.title;
      if (!$("mergeAuthor").value && meta && meta.author) $("mergeAuthor").value = meta.author;
      if (meta && meta.language && $("mergeLang").value === "en") $("mergeLang").value = meta.language;
      if (!M.cover && cover) setCover(cover);
      added++;
    } catch (e) {
      console.error("merge add failed", file.name, e);
      failed++;
    }
  }
  dedupe(true);
  render();
  const info = failed ? ` (${failed} could not be read)` : "";
  setStatus(`${M.entries.length} chapters from ${added} file${added === 1 ? "" : "s"}${info}. Arrange, then Export.`);
}

function setCover(cover) {
  M.cover = cover;
  if (M.coverUrl) URL.revokeObjectURL(M.coverUrl);
  M.coverUrl = URL.createObjectURL(new Blob([cover.data], { type: cover.mime || "image/jpeg" }));
  const img = $("mergeCoverPreview");
  img.src = M.coverUrl; img.classList.remove("hidden");
  $("mergeCoverInfo").textContent = "from first file";
}

// Untick later duplicates (same identity). Returns how many were unticked.
function dedupe(silent) {
  const seen = new Set();
  let n = 0;
  for (const e of M.entries) {
    const k = keyOf(e);
    if (seen.has(k)) { if (e.include) { e.include = false; n++; } }
    else seen.add(k);
  }
  if (!silent) { render(); setStatus(n ? `Un-ticked ${n} duplicate chapter${n === 1 ? "" : "s"}.` : "No duplicates found."); }
  return n;
}

function sortByNumber() {
  M.entries.sort((a, b) => numOf(a) - numOf(b));
  render();
  setStatus("Sorted by chapter number.");
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= M.entries.length) return;
  const [row] = M.entries.splice(i, 1);
  M.entries.splice(j, 0, row);
  render();
}
function removeAt(i) { M.entries.splice(i, 1); render(); }

// ---- drag & drop reorder (from the handle) ----
let dragFrom = -1;
function onDragStart(e) { dragFrom = +e.currentTarget.closest(".item").dataset.i; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (_) {} }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("dragover"); }
function onDragLeave(e) { e.currentTarget.classList.remove("dragover"); }
function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("dragover");
  const to = +e.currentTarget.dataset.i;
  if (dragFrom < 0 || to < 0 || dragFrom === to) return;
  const [row] = M.entries.splice(dragFrom, 1);
  M.entries.splice(to, 0, row);
  dragFrom = -1;
  render();
}

function render() {
  const list = $("mergeList");
  list.innerHTML = "";
  const seen = new Set();
  M.entries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "item";
    row.dataset.i = i;
    const k = keyOf(e);
    const isDupe = seen.has(k); seen.add(k);
    if (isDupe) row.classList.add("dupe");
    row.innerHTML =
      `<span class="merge-handle" draggable="true" title="Drag to reorder">⠿</span>` +
      `<span class="inc"><input type="checkbox" data-i="${i}" ${e.include ? "checked" : ""}></span>` +
      `<span class="ttl">${escapeHtml(e.title || "Chapter " + (i + 1))}<span class="merge-src">${escapeHtml(e.source || "")}</span></span>` +
      `<span class="row-actions">` +
      `<button class="merge-move" data-act="up" title="Move up">▲</button>` +
      `<button class="merge-move" data-act="down" title="Move down">▼</button>` +
      `<button class="merge-del" title="Remove">✕</button>` +
      `</span>`;
    list.appendChild(row);
  });
  // wire per-row controls
  list.querySelectorAll(".merge-handle").forEach((h) => {
    h.addEventListener("dragstart", onDragStart);
  });
  list.querySelectorAll(".item").forEach((row) => {
    row.addEventListener("dragover", onDragOver);
    row.addEventListener("dragleave", onDragLeave);
    row.addEventListener("drop", onDrop);
  });
  list.querySelectorAll('.inc input').forEach((cb) => cb.addEventListener("change", (ev) => {
    M.entries[+ev.target.dataset.i].include = ev.target.checked; updateInfo();
  }));
  list.querySelectorAll(".merge-move").forEach((b) => b.addEventListener("click", (ev) => {
    const i = +ev.target.closest(".item").dataset.i;
    move(i, ev.target.dataset.act === "up" ? -1 : 1);
  }));
  list.querySelectorAll(".merge-del").forEach((b) => b.addEventListener("click", (ev) => {
    removeAt(+ev.target.closest(".item").dataset.i);
  }));
  updateInfo();
}

function updateInfo() {
  const total = M.entries.length;
  const inc = M.entries.filter((e) => e.include).length;
  $("mergeCount").textContent = String(total);
  $("mergeSelInfo").textContent = total ? `${inc}/${total} included` : "";
  const has = total > 0;
  ["mergeSort", "mergeDedupe", "mergeClear"].forEach((id) => $(id).classList.toggle("hidden", !has));
  $("mergeExport").disabled = !inc;
  $("mergeQuick").disabled = !inc;
}

// Save a Blob as a file. Uses chrome.downloads where it exists (desktop Chrome/Edge);
// on Android browsers (Quetta, Kiwi, Lemur…) that API is often missing or fails, so fall
// back to a plain <a download> click, which hands the file to the browser's own downloader.
export function saveFile(blob, name, saveAs) {
  const url = URL.createObjectURL(blob);
  const cleanup = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  const anchorSave = () => {
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    cleanup();
  };
  if (!chrome.downloads || typeof chrome.downloads.download !== "function") { anchorSave(); return; }
  try {
    chrome.downloads.download({ url, filename: name, saveAs: !!saveAs }, (id) => {
      if (chrome.runtime.lastError || id === undefined) anchorSave(); else cleanup();
    });
  } catch (_) { anchorSave(); }
}
function saveBlob(blob, name, saveAs) { saveFile(blob, name, saveAs); }

function exportMerged(saveAs) {
  const included = M.entries.filter((e) => e.include);
  if (!included.length) { setStatus("Tick at least one chapter to export."); return; }
  const used = new Set();
  included.forEach((e) => (e.imgNames || []).forEach((n) => used.add(n)));
  const images = [...M.images.values()].filter((r) => used.has(r.name));
  const title = $("mergeTitle").value.trim() || "Merged";
  const meta = {
    title, author: $("mergeAuthor").value.trim() || "Unknown",
    language: $("mergeLang").value.trim() || "en",
    cover: M.cover, includeCover: true, includeTitlePage: true, idSeed: title || null,
  };
  const chapters = included.map((e) => ({ title: e.title, xhtmlBody: e.xhtmlBody, srcNo: e.srcNo, srcUrl: e.srcUrl }));
  setStatus(`Building merged EPUB — ${chapters.length} chapters…`);
  try {
    const blob = buildEpub(meta, chapters, images);
    saveBlob(blob, sanitize(title) + ".epub", saveAs);
    setStatus(`Exported ${chapters.length} chapters${saveAs ? " (choose where to save)" : " to Downloads"}.`);
  } catch (e) {
    console.error("merge export failed", e);
    setStatus("Export failed: " + e.message);
  }
}

function clearAll() {
  M.entries = []; M.images = new Map(); M.cover = null; M.seq = 0;
  if (M.coverUrl) { URL.revokeObjectURL(M.coverUrl); M.coverUrl = null; }
  $("mergeCoverPreview").classList.add("hidden"); $("mergeCoverPreview").removeAttribute("src");
  $("mergeCoverInfo").textContent = "from first file";
  render();
  setStatus("Cleared. Add EPUB files to begin.");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function initMerge() {
  $("mergeAdd").addEventListener("click", () => $("mergeFiles").click());
  $("mergeFiles").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("mergeSort").addEventListener("click", sortByNumber);
  $("mergeDedupe").addEventListener("click", () => dedupe(false));
  $("mergeClear").addEventListener("click", clearAll);
  $("mergeExport").addEventListener("click", () => exportMerged(true));
  $("mergeQuick").addEventListener("click", () => exportMerged(false));
  updateInfo();
}
