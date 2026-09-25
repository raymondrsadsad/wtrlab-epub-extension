// Read EPUB — an offline reader with text-to-speech and per-book resume memory.
// Uses parseEpub to unzip locally; nothing is fetched.
import { parseEpub } from "./epubread.js";

const $ = (id) => document.getElementById(id);
const store = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null;
const synth = window.speechSynthesis;

const R = {
  book: null, bookKey: null,
  imgUrls: new Map(), coverUrl: null,
  chapter: 0, segEls: [], segIndex: 0,
  speaking: false, paused: false,
  rate: 1, voice: null, userVoice: null, voices: [], utter: null, token: 0,
  saveTimer: null,
  follow: true, hl: true, collapsed: false, pos: null,
  provider: null,   // live mode: (index) => Promise<{title, xhtmlBody, images}>
  loading: false,   // a chapter fetch is in flight (guards rapid Next/Prev)
};

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
function setStatus(t) { $("readStatus").textContent = t; }
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- open a file ----
async function openFile(file) {
  if (!file) return;
  stopTts();
  setStatus(`Reading “${file.name}”…`);
  try {
    const buf = await file.arrayBuffer();
    const { chapters, images, meta, cover } = await parseEpub(buf);
    // free previous blob urls
    for (const u of R.imgUrls.values()) URL.revokeObjectURL(u);
    R.imgUrls.clear();
    if (R.coverUrl) { URL.revokeObjectURL(R.coverUrl); R.coverUrl = null; }

    R.book = { chapters, images, meta: meta || {}, cover };
    R.provider = null; // file mode: all content is already in-hand
    R.bookKey = (meta && meta.identifier) || ("t:" + norm((meta && meta.title) + "|" + (meta && meta.author)));
    for (const rec of images) R.imgUrls.set(rec.name, URL.createObjectURL(new Blob([rec.data], { type: rec.mime || "image/jpeg" })));

    // header
    $("readTitle").textContent = (meta && meta.title) || file.name;
    $("readAuthor").textContent = (meta && meta.author) || "";
    if (cover) {
      R.coverUrl = URL.createObjectURL(new Blob([cover.data], { type: cover.mime || "image/jpeg" }));
      const c = $("readCover"); c.src = R.coverUrl; c.classList.remove("hidden");
    } else $("readCover").classList.add("hidden");
    // file mode: no live-only controls
    $("readService").classList.add("hidden");
    $("readCaptcha").classList.add("hidden");

    renderToc();
    $("ttsPlayer").classList.remove("hidden");
    $("readBodyCard").classList.remove("hidden");
    loadVoices();
    setStatus(`${chapters.length} chapters loaded.`);

    // resume?
    const prog = await getProgress(R.bookKey);
    if (prog && (prog.chapterIndex > 0 || prog.segIndex > 0)) {
      $("readResumeMsg").textContent = `Resume: ${prog.title || "Chapter " + (prog.chapterIndex + 1)} · line ${prog.segIndex + 1}`;
      $("readResume").classList.remove("hidden");
      $("readResumeBtn").onclick = () => { $("readResume").classList.add("hidden"); loadChapter(prog.chapterIndex, prog.segIndex, false); };
      $("readResumeStart").onclick = () => { $("readResume").classList.add("hidden"); loadChapter(0, 0, false); };
    } else {
      $("readResume").classList.add("hidden");
      loadChapter(0, 0, false);
    }
  } catch (e) {
    console.error("read open failed", e);
    setStatus("Could not open: " + e.message);
  }
}

function renderToc() {
  const toc = $("readToc");
  toc.innerHTML = "";
  R.book.chapters.forEach((ch, i) => {
    const row = document.createElement("div");
    row.className = "item";
    row.dataset.i = i;
    row.innerHTML = `<span class="ttl">${escapeHtml(ch.title || "Chapter " + (i + 1))}</span>`;
    row.addEventListener("click", () => loadChapter(i, 0, false));
    toc.appendChild(row);
  });
}

// ---- render a chapter + build speakable segments ----
function splitSentences(t) {
  const parts = t.match(/[^.!?。！？…]+[.!?。！？…]*\s*/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : (t ? [t.trim()] : []);
}
function buildSegments(root) {
  const segs = [];
  root.querySelectorAll("p, h1, h2, h3, h4, li, blockquote").forEach((block) => {
    if (block.querySelector("img")) return; // keep image-bearing blocks intact
    const text = block.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    block.textContent = "";
    splitSentences(text).forEach((sent) => {
      const span = document.createElement("span");
      span.className = "seg";
      span.dataset.seg = String(segs.length);
      span.textContent = sent + " ";
      block.appendChild(span);
      segs.push(span);
    });
  });
  return segs;
}

// Live source (reading a novel straight from the site): fetch a chapter's content
// on demand the first time it's shown, then cache it on the chapter object.
async function ensureChapter(i) {
  const ch = R.book.chapters[i];
  if (ch.xhtmlBody != null) return;      // already loaded (file mode always has it)
  if (!R.provider) { ch.xhtmlBody = ""; return; }
  setStatus(`Fetching chapter ${i + 1}…`);
  const got = await R.provider(i);
  ch.xhtmlBody = got.xhtmlBody || "";
  if (got.title) ch.title = got.title;
  if (got.images) for (const rec of got.images) {
    if (!R.imgUrls.has(rec.name)) R.imgUrls.set(rec.name, URL.createObjectURL(new Blob([rec.data], { type: rec.mime || "image/jpeg" })));
  }
  setStatus(got.notice || ""); // provider may report e.g. an AI→Web+ fallback
}

async function loadChapter(i, seg, speak) {
  if (!R.book || i < 0 || i >= R.book.chapters.length) return;
  if (R.loading) { setStatus("Still loading the previous chapter…"); return; } // ignore rapid clicks
  R.loading = true;
  try {
    try {
      await ensureChapter(i);
    } catch (e) {
      console.error(e);
      // Stay on the current chapter (don't advance R.chapter) so Next/Prev stay in sync.
      if (e.name === "CancelledError") setStatus("Loading cancelled.");
      else setStatus("⚠ " + (e.message || "Could not load this chapter."));
      return;
    }
    await renderLoaded(i, seg, speak);
  } finally {
    R.loading = false;
  }
}

async function renderLoaded(i, seg, speak) {
  R.chapter = i; // commit only after a successful load
  const ch = R.book.chapters[i];
  const wrap = $("readContent");
  wrap.innerHTML = ch.xhtmlBody || "";
  wrap.querySelectorAll("img").forEach((img) => {
    const url = R.imgUrls.get(img.getAttribute("src"));
    if (url) img.src = url; else img.removeAttribute("src");
    img.removeAttribute("srcset");
  });
  R.segEls = buildSegments(wrap);
  $("readChapTitle").textContent = ch.title || ("Chapter " + (i + 1));
  // highlight active TOC row
  $("readToc").querySelectorAll(".item").forEach((r) => r.classList.toggle("current", +r.dataset.i === i));

  R.segIndex = Math.min(Math.max(0, seg || 0), Math.max(0, R.segEls.length - 1));
  highlight(R.segIndex, !speak);
  saveProgressSoon();
  if (speak) speakFrom(R.segIndex); else { wrap.scrollTop = 0; }
}

function highlight(i, scroll) {
  R.segEls.forEach((el, k) => el.classList.toggle("speaking", R.hl && k === i));
  const el = R.segEls[i];
  if (el && R.follow && scroll !== false) el.scrollIntoView({ block: "center", behavior: "smooth" });
  const now = $("ttsNow");
  if (now && R.segEls.length) now.textContent = `Ch ${R.chapter + 1} · line ${i + 1}`;
}

// ---- text-to-speech ----
function speakFrom(i) {
  synth.cancel();
  if (i >= R.segEls.length) { // end of chapter → next chapter, or finish
    if (R.chapter < R.book.chapters.length - 1) loadChapter(R.chapter + 1, 0, true);
    else { stopTts(); setStatus("Finished the book."); }
    return;
  }
  if (i < 0) i = 0;
  R.segIndex = i; R.speaking = true; R.paused = false;
  highlight(i); saveProgressSoon();
  const myToken = ++R.token;
  const u = new SpeechSynthesisUtterance((R.segEls[i].textContent || "").trim());
  u.rate = R.rate;
  if (R.voice) { u.voice = R.voice; u.lang = R.voice.lang; }
  u.onend = () => { if (myToken !== R.token || !R.speaking || R.paused) return; speakFrom(R.segIndex + 1); };
  u.onerror = () => { if (myToken !== R.token || !R.speaking) return; speakFrom(R.segIndex + 1); };
  R.utter = u; // keep a reference so it isn't garbage-collected mid-speech
  synth.speak(u);
  updatePlayBtn();
}
function togglePlay() {
  if (!R.book) return;
  if (!R.speaking) { speakFrom(R.segIndex || 0); return; }
  if (R.paused) { synth.resume(); R.paused = false; }
  else { synth.pause(); R.paused = true; }
  updatePlayBtn();
}
function stopTts() {
  R.token++;
  R.speaking = false; R.paused = false;
  try { synth.cancel(); } catch (_) {}
  updatePlayBtn();
}
function stepLine(d) {
  if (!R.segEls.length) return;
  const target = R.segIndex + d;
  if (R.speaking) speakFrom(target);
  else { R.segIndex = Math.min(Math.max(0, target), R.segEls.length - 1); highlight(R.segIndex); saveProgressSoon(); }
}
function updatePlayBtn() {
  const b = $("ttsPlay");
  const playing = R.speaking && !R.paused;
  b.textContent = playing ? "⏸" : "▶";
  b.title = playing ? "Pause (Space)" : "Play (Space)";
}

// ---- voices ----
// Preferred out-of-the-box voice: Google US English (from "Speech recognition and
// synthesis from Google"). Voices are provided by the OS/browser and can't be bundled,
// so we pick it by name where present and fall back gracefully otherwise. This is a
// code default (not a saved setting), so it applies the same on every device.
const PREFERRED_VOICE = "Google US English";
function pickDefaultVoiceIndex(voices, bookLang) {
  const byName = (n) => voices.findIndex((v) => v.name === n);
  const lang = (bookLang || "").toLowerCase();
  const englishBook = !lang || lang.startsWith("en");
  const tryChain = [];
  if (englishBook) {
    tryChain.push(byName(PREFERRED_VOICE));
    tryChain.push(byName("Google US English Female"));
    tryChain.push(voices.findIndex((v) => /^google/i.test(v.name) && /en[-_]us/i.test(v.lang || "")));
    tryChain.push(voices.findIndex((v) => /en[-_]us/i.test(v.lang || "")));
    tryChain.push(voices.findIndex((v) => /^en([-_]|$)/i.test(v.lang || "")));
  } else {
    // Non-English book: prefer a voice in its language, else the preferred English one.
    tryChain.push(voices.findIndex((v) => (v.lang || "").toLowerCase().startsWith(lang)));
    tryChain.push(byName(PREFERRED_VOICE));
    tryChain.push(voices.findIndex((v) => /en[-_]us/i.test(v.lang || "")));
  }
  const idx = tryChain.find((i) => i >= 0);
  return idx == null ? 0 : idx;
}
function loadVoices() {
  const voices = synth.getVoices();
  R.voices = voices;
  const sel = $("ttsVoice");
  sel.innerHTML = "";
  voices.forEach((v, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  });
  if (voices.length) {
    let idx = -1;
    if (R.userVoice) idx = voices.findIndex((v) => v.name === R.userVoice); // explicit choice wins
    if (idx < 0) idx = pickDefaultVoiceIndex(voices, R.book && R.book.meta && R.book.meta.language);
    sel.value = String(idx); R.voice = voices[idx];
    $("ttsHint").innerHTML = "<em>Click any line to start speaking from there.</em>";
  } else {
    R.voice = null;
    $("ttsHint").innerHTML = "<em>No speech voices found on this system yet — reading works; speech may be unavailable.</em>";
  }
}

// ---- progress ----
function getProgress(key) {
  return new Promise((res) => {
    if (!store) return res(null);
    try { store.get("readProgress", (o) => res((o && o.readProgress && o.readProgress[key]) || null)); }
    catch (_) { res(null); }
  });
}
function saveProgressSoon() {
  if (R.saveTimer) clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(saveProgress, 600);
}
function saveProgress() {
  if (!store || !R.bookKey || !R.book) return;
  try {
    store.get("readProgress", (o) => {
      const map = (o && o.readProgress) || {};
      map[R.bookKey] = {
        chapterIndex: R.chapter, segIndex: R.segIndex,
        title: (R.book.chapters[R.chapter] && R.book.chapters[R.chapter].title) || `Chapter ${R.chapter + 1}`,
        updatedAt: Date.now(),
      };
      store.set({ readProgress: map });
    });
  } catch (_) { /* ignore */ }
}

// ---- reader UI prefs (player position, toggles, voice, rate) ----
function saveReaderPrefs() {
  if (!store) return;
  try { store.set({ readerPrefs: { follow: R.follow, hl: R.hl, rate: R.rate, voiceName: R.userVoice, pos: R.pos, collapsed: R.collapsed } }); } catch (_) {}
}
function applyPlayerPos() {
  const pl = $("ttsPlayer");
  // On narrow screens ignore any saved desktop position (it could be off-screen) and
  // let the CSS dock the player full-width at the bottom.
  if (window.innerWidth > 560 && R.pos && typeof R.pos.left === "number") {
    pl.style.right = "auto"; pl.style.bottom = "auto";
    pl.style.left = R.pos.left + "px"; pl.style.top = R.pos.top + "px";
  } else {
    pl.style.left = ""; pl.style.top = ""; pl.style.right = ""; pl.style.bottom = "";
  }
  pl.classList.toggle("collapsed", !!R.collapsed);
  $("ttsCollapse").textContent = R.collapsed ? "▸" : "▾";
}
function initDrag() {
  const bar = $("ttsDrag"), pl = $("ttsPlayer");
  let ox = 0, oy = 0, sx = 0, sy = 0, drag = false;
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return; // let the buttons work
    drag = true; pl.classList.add("dragging");
    const r = pl.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    pl.style.right = "auto"; pl.style.bottom = "auto"; pl.style.left = ox + "px"; pl.style.top = oy + "px";
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.max(4, Math.min(window.innerWidth - pl.offsetWidth - 4, nx));
    ny = Math.max(4, Math.min(window.innerHeight - pl.offsetHeight - 4, ny));
    pl.style.left = nx + "px"; pl.style.top = ny + "px";
    R.pos = { left: nx, top: ny };
  });
  const end = (e) => { if (!drag) return; drag = false; pl.classList.remove("dragging"); try { bar.releasePointerCapture(e.pointerId); } catch (_) {} saveReaderPrefs(); };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
}

// Open a "live" book — chapters fetched on demand from a provider (e.g. reading a
// novel straight from the site). `chapters` is [{title}], provider(i) returns the
// chapter's { title, xhtmlBody, images }. Starts on `startIndex` (the opened chapter).
export function openLive({ meta, chapters, bookKey, provider, startIndex }) {
  stopTts();
  for (const u of R.imgUrls.values()) URL.revokeObjectURL(u);
  R.imgUrls.clear();
  if (R.coverUrl) { URL.revokeObjectURL(R.coverUrl); R.coverUrl = null; }

  R.book = { chapters: chapters.map((c) => ({ title: c.title, xhtmlBody: null })), images: [], meta: meta || {}, cover: null };
  R.provider = provider;
  R.bookKey = bookKey || ("t:" + norm((meta && meta.title) || "live"));
  $("readTitle").textContent = (meta && meta.title) || "Reading";
  $("readAuthor").textContent = (meta && meta.author) || "";
  $("readCover").classList.add("hidden");
  $("readResume").classList.add("hidden");

  renderToc();
  $("ttsPlayer").classList.remove("hidden");
  $("readBodyCard").classList.remove("hidden");
  loadVoices();

  const start = (typeof startIndex === "number" && startIndex >= 0 && startIndex < chapters.length) ? startIndex : 0;
  setStatus(`${chapters.length} chapters — reading from chapter ${start + 1}.`);
  loadChapter(start, 0, false);
}

// Re-fetch the current (and future) chapters — used when the translation service
// changes. Only meaningful in live mode; drops cached content and reloads.
export function readerReload() {
  if (!R.book || !R.provider) return;
  stopTts();
  R.loading = false; // the caller (service change) already cancelled any pending fetch
  for (const u of R.imgUrls.values()) URL.revokeObjectURL(u);
  R.imgUrls.clear();
  R.book.chapters.forEach((c) => { c.xhtmlBody = null; });
  loadChapter(R.chapter, 0, false);
}

// Called by popup.js when the user leaves Read mode or closes the page.
export function readerStop() { stopTts(); saveProgress(); }

export function initRead() {
  $("readOpen").addEventListener("click", () => $("readFile").click());
  $("readFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; openFile(f); e.target.value = ""; });

  $("ttsPlay").addEventListener("click", togglePlay);
  $("ttsStop").addEventListener("click", stopTts);
  $("ttsPrev").addEventListener("click", () => stepLine(-1));
  $("ttsNext").addEventListener("click", () => stepLine(1));
  $("ttsVoice").addEventListener("change", (e) => { R.voice = R.voices[+e.target.value] || null; R.userVoice = R.voice && R.voice.name; saveReaderPrefs(); });
  $("ttsRate").addEventListener("input", (e) => { R.rate = +e.target.value; $("ttsRateVal").textContent = R.rate.toFixed(1) + "×"; saveReaderPrefs(); });
  $("ttsFollow").addEventListener("change", (e) => { R.follow = e.target.checked; saveReaderPrefs(); if (R.follow) highlight(R.segIndex); });
  $("ttsHighlight").addEventListener("change", (e) => { R.hl = e.target.checked; highlight(R.segIndex, false); saveReaderPrefs(); });
  $("ttsCollapse").addEventListener("click", () => { R.collapsed = !R.collapsed; $("ttsPlayer").classList.toggle("collapsed", R.collapsed); $("ttsCollapse").textContent = R.collapsed ? "▸" : "▾"; saveReaderPrefs(); });
  initDrag();

  // restore saved player prefs
  if (store) try {
    store.get("readerPrefs", (o) => {
      const p = o && o.readerPrefs; if (!p) return;
      if (typeof p.follow === "boolean") { R.follow = p.follow; $("ttsFollow").checked = p.follow; }
      if (typeof p.hl === "boolean") { R.hl = p.hl; $("ttsHighlight").checked = p.hl; }
      if (typeof p.rate === "number") { R.rate = p.rate; $("ttsRate").value = String(p.rate); $("ttsRateVal").textContent = p.rate.toFixed(1) + "×"; }
      if (p.voiceName) R.userVoice = p.voiceName;
      if (p.pos) R.pos = p.pos;
      R.collapsed = !!p.collapsed;
      applyPlayerPos();
    });
  } catch (_) {}

  $("readPrev").addEventListener("click", () => loadChapter(R.chapter - 1, 0, R.speaking));
  $("readNext").addEventListener("click", () => loadChapter(R.chapter + 1, 0, R.speaking));

  // click a line to speak from there
  $("readContent").addEventListener("click", (e) => {
    const seg = e.target.closest && e.target.closest(".seg");
    if (!seg) return;
    speakFrom(+seg.dataset.seg);
  });

  if (typeof synth !== "undefined" && synth) synth.onvoiceschanged = loadVoices;

  // keyboard: only while Read mode is visible and focus isn't on a control
  document.addEventListener("keydown", (e) => {
    if ($("modeRead").hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); loadChapter(R.chapter - 1, 0, R.speaking); }
    else if (e.key === "ArrowRight") { e.preventDefault(); loadChapter(R.chapter + 1, 0, R.speaking); }
  });

  window.addEventListener("beforeunload", () => { try { synth.cancel(); } catch (_) {} saveProgress(); });
}
