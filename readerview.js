// Read EPUB — an offline reader with text-to-speech and per-book resume memory.
// Uses parseEpub to unzip locally; nothing is fetched.
import { parseEpub } from "./epubread.js";
import { translateAll } from "./adapters/translate.js";

const $ = (id) => document.getElementById(id);
const store = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null;
const synth = window.speechSynthesis;

const R = {
  book: null, bookKey: null,
  imgUrls: new Map(), coverUrl: null,
  chapter: 0, segEls: [], segIndex: 0,
  speaking: false, paused: false,
  rate: 1, voice: null, userVoice: null, voices: [], utters: [], chunks: [], chunkQueue: 0, spokenUpto: -1, token: 0,
  sentPause: 250, pauseTimer: null, // ms of silence between paragraphs (user-adjustable)
  saveTimer: null,
  follow: true, hl: true, readSymbols: true, collapsed: false, pos: null,
  provider: null,   // live mode: (index) => Promise<{title, xhtmlBody, images}>
  loading: false,   // a chapter fetch is in flight (guards rapid Next/Prev)
  tocReversed: false, // Contents list shown newest-first (357→1)
  tocTranslated: false, tocTitlesEn: null, // Contents titles translated to English
  autoNext: true, // auto-advance to the next chapter when TTS finishes one
  immersive: false, // chrome (top bar + player) hidden while reading
  lastY: 0,         // last scroll position (for hide/show direction)
  progScroll: 0,    // timestamp of a programmatic scroll (TTS follow) to ignore
  // display prefs (font / size / line-height / reading theme) — all local, no network
  theme: "default", customBg: "#ffffff", customFg: "#111111",
  fontKey: "", importedFont: null, // importedFont: { name, dataUrl } from "Import font file…"
  fontSize: 17, lineHeight: 1.75, width: 700, paraGap: 0.9,
  justify: true, bold: false,
};

// Preset reading themes ({bg,fg}); `default` inherits the app theme, `custom` uses the
// two color pickers. Trivially extendable — just add a row. Font presets map to local /
// system font stacks (no web fonts, so nothing to load or maintain); the custom-font box
// accepts any font installed on the device.
const THEMES = {
  default: { bg: null, fg: null },
  white:   { bg: "#ffffff", fg: "#1a1a1a" },
  sepia:   { bg: "#f4ecd8", fg: "#5b4636" },
  cream:   { bg: "#faf3e0", fg: "#46402f" },
  blue:    { bg: "#dbe6f0", fg: "#1c2a38" },
  rose:    { bg: "#f7e6ea", fg: "#4a2b30" },
  mint:    { bg: "#e2efe4", fg: "#22352a" },
  grey:    { bg: "#2a2c31", fg: "#d4d6da" },
  black:   { bg: "#000000", fg: "#c8c8c8" },
};
const THEME_ORDER = ["default", "white", "sepia", "cream", "blue", "rose", "mint", "grey", "black", "custom"];
const FONT_STACKS = {
  "": "",
  serif: 'Georgia, "Times New Roman", "Songti SC", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  rounded: '"Nunito", "Varela Round", "Segoe UI", system-ui, sans-serif',
  reading: '"Lora", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", "Segoe Print", "Trebuchet MS", sans-serif',
};
// Quick presets shown at the top of the font dropdown (value → label).
const FONT_PRESETS = [["", "System default"], ["serif", "Serif"], ["sans", "Sans-serif"], ["rounded", "Rounded"], ["reading", "Reading (book)"], ["dyslexic", "Dyslexic-friendly"]];
// Common fonts most devices have; unavailable ones just fall back. Chosen from a list, not typed.
const NAMED_FONTS = ["Georgia", "Times New Roman", "Palatino Linotype", "Garamond", "Iowan Old Style", "Charter", "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI", "Calibri", "Courier New", "Comic Sans MS"];
const DISPLAY_DEFAULTS = { theme: "default", customBg: "#ffffff", customFg: "#111111", fontKey: "", importedFont: null, fontSize: 17, lineHeight: 1.75, width: 700, paraGap: 0.9, justify: true, bold: false };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
// Strip symbols/brackets/quotes some voices read aloud, keeping letters, numbers,
// whitespace and sentence punctuation (for pauses). Applied only to spoken text.
function stripSymbols(s) {
  try { return s.replace(/[^\p{L}\p{N}\s.,!?~…。！？、，〜〰～]/gu, " ").replace(/\s{2,}/g, " ").trim(); }
  catch (_) { return s.replace(/[^0-9A-Za-z\s.,!?~]/g, " ").replace(/\s{2,}/g, " ").trim(); }
}
function spokenText(t) { return (R.readSymbols === false ? stripSymbols(t) : t) || t; }
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

    R.tocTranslated = false; R.tocTitlesEn = null; updateTocTranslateBtn();
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
  const order = R.book.chapters.map((_, i) => i);
  if (R.tocReversed) order.reverse();
  order.forEach((i) => {
    const ch = R.book.chapters[i];
    const row = document.createElement("div");
    row.className = "item" + (i === R.chapter ? " current" : "");
    row.dataset.i = i;
    const title = (R.tocTranslated && R.tocTitlesEn && R.tocTitlesEn[i]) ? R.tocTitlesEn[i] : (ch.title || "Chapter " + (i + 1));
    row.innerHTML = `<span class="ttl">${escapeHtml(title)}</span>`;
    row.addEventListener("click", () => { closeDrawer(); loadChapter(i, 0, false); });
    toc.appendChild(row);
  });
}

// Reflect the toc-translate toggle's label/state on its button.
function updateTocTranslateBtn() {
  const btn = $("readTocTranslate");
  if (!btn) return;
  btn.classList.toggle("active", !!R.tocTranslated);
  btn.textContent = R.tocTranslated ? "✓ Translated" : "🌐 Translate";
}
// Toggle: translate all Contents titles to English (fetched once, then cached).
async function translateToc() {
  if (!R.book || !R.book.chapters.length) return;
  if (R.tocTitlesEn) { R.tocTranslated = !R.tocTranslated; updateTocTranslateBtn(); renderToc(); return; }
  const btn = $("readTocTranslate");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    R.tocTitlesEn = await translateAll(R.book.chapters.map((c) => c.title || ""), "en", "auto");
    R.tocTranslated = true;
  } catch (e) { setStatus("Couldn't translate the titles."); }
  if (btn) btn.disabled = false;
  updateTocTranslateBtn();
  renderToc();
}

// ---- Contents drawer + immersive chrome ----
function openDrawer() { $("readDrawer").classList.add("open"); $("readBackdrop").classList.add("open"); }
function closeDrawer() { $("readDrawer").classList.remove("open"); $("readBackdrop").classList.remove("open"); }
function setImmersive(on) {
  R.immersive = on;
  $("modeRead").classList.toggle("immersive", on);
}
// Keep the chapter toolbar on screen while reading. position: sticky alone isn't
// reliable on some Android browsers, so once the bar's normal spot scrolls above the
// viewport we switch it to position: fixed (aligned to the reading card) and hold its
// space with a spacer so the text doesn't jump.
function updateNavPin() {
  const bar = $("readNavbar"), spacer = $("readNavSpacer"), card = $("readBodyCard");
  if (!bar || !spacer || !card) return;
  const unpin = () => {
    if (!bar.classList.contains("pinned")) return;
    bar.classList.remove("pinned");
    bar.style.left = bar.style.width = "";
    spacer.style.height = "0px";
  };
  if ($("modeRead").hidden || card.classList.contains("hidden")) { unpin(); return; }
  const s = spacer.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const h = bar.offsetHeight;
  // pin while the bar's home is above the top AND the card still extends below it
  if (s.top < 0 && c.bottom > h + 8) {
    if (!bar.classList.contains("pinned")) {
      spacer.style.height = (h + 6) + "px"; // bar height + its -4px/10px margins
      bar.classList.add("pinned");
    }
    bar.style.left = Math.round(c.left + 1) + "px";
    bar.style.width = Math.round(c.width - 2) + "px";
  } else unpin();
}
// Programmatic scroll (e.g. TTS follow) shouldn't toggle the chrome.
function markProgScroll() { R.progScroll = Date.now(); }
function onReaderScroll() {
  if (Date.now() - R.progScroll < 700) { R.lastY = window.scrollY; return; }
  const y = window.scrollY, dy = y - R.lastY;
  if (Math.abs(dy) < 8) return;
  if (dy > 0 && y > 60) { if (!R.immersive) setImmersive(true); }   // scrolling down → hide
  else if (dy < 0) { if (R.immersive) setImmersive(false); }         // scrolling up → show
  R.lastY = y;
}

// ---- render a chapter + build speakable segments ----
// One segment per PARAGRAPH (block) — TTS reads a whole paragraph as a unit and
// highlights it as a unit; the pause falls only at paragraph breaks.
function buildSegments(root) {
  const segs = [];
  root.querySelectorAll("p, h1, h2, h3, h4, li, blockquote").forEach((block) => {
    if (block.querySelector("img")) return; // keep image-bearing blocks intact
    const text = block.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    block.textContent = "";
    const span = document.createElement("span");
    span.className = "seg";
    span.dataset.seg = String(segs.length);
    span.textContent = text;
    block.appendChild(span);
    segs.push(span);
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
  // Prepend the chapter title so TTS always reads it first (skip if the body already
  // opens with it, to avoid saying the title twice).
  const titleText = (ch.title || "").replace(/\s+/g, " ").trim();
  if (titleText) {
    const fb = wrap.querySelector("p, h1, h2, h3, h4, h5, h6, li, blockquote");
    const fbText = fb ? (fb.textContent || "").replace(/\s+/g, " ").trim() : "";
    const dup = fbText && (fbText === titleText || fbText.startsWith(titleText) || titleText.startsWith(fbText));
    if (!dup) { const h = document.createElement("h2"); h.className = "chap-title"; h.textContent = titleText; wrap.insertBefore(h, wrap.firstChild); }
  }
  R.segEls = buildSegments(wrap);
  R.chunks = []; // rebuilt lazily by speakFrom for this chapter
  $("readChapTitle").textContent = ch.title || ("Chapter " + (i + 1));
  // highlight active TOC row
  $("readToc").querySelectorAll(".item").forEach((r) => r.classList.toggle("current", +r.dataset.i === i));

  setImmersive(false); R.lastY = 0; // new chapter → show controls
  R.segIndex = Math.min(Math.max(0, seg || 0), Math.max(0, R.segEls.length - 1));
  highlight(R.segIndex, !speak);
  saveProgressSoon();
  if (speak) speakFrom(R.segIndex); else { window.scrollTo(0, 0); }
}

function highlight(i, scroll) {
  R.segEls.forEach((el, k) => el.classList.toggle("speaking", R.hl && k === i));
  const el = R.segEls[i];
  if (el && R.follow && scroll !== false) { markProgScroll(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  const now = $("ttsNow");
  if (now && R.segEls.length) now.textContent = `Ch ${R.chapter + 1} · line ${i + 1}`;
}

// ---- text-to-speech ----
// Read-aloud pacing: speak ONE paragraph per utterance and leave a short,
// natural, adjustable pause between paragraphs (R.sentPause ms). A long paragraph is
// hard-split into pieces (same segIndex) spoken back-to-back so only real paragraph
// breaks get a pause. (Kept identical in webwidget.js.)
const MAX_CHUNK = 500;          // chars: hard-split an over-long paragraph
// The gap between paragraphs is R.sentPause (ms), adjustable from the player.

// One chunk per paragraph segment; an over-long paragraph becomes several chunks that
// share its `gi` (segIndex) so the pause fires only when `gi` actually changes.
function buildChunks() {
  R.chunks = [];
  R.segEls.forEach((el, gi) => {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    if (text.length <= MAX_CHUNK) { R.chunks.push({ gi, text }); return; }
    let s = text;
    while (s.length > MAX_CHUNK) {
      let cut = s.lastIndexOf(" ", MAX_CHUNK); if (cut <= 0) cut = MAX_CHUNK;
      R.chunks.push({ gi, text: s.slice(0, cut).trim() });
      s = s.slice(cut).trim();
    }
    if (s) R.chunks.push({ gi, text: s });
  });
}
function chunkForSeg(i) {
  for (let c = 0; c < R.chunks.length; c++) if (R.chunks[c].gi >= i) return c;
  return 0;
}
// End of a chapter's TTS: auto-advance to the next chapter when enabled, else stop.
function advanceChapterOrStop() {
  const more = R.chapter < R.book.chapters.length - 1;
  if (R.autoNext !== false && more) loadChapter(R.chapter + 1, 0, true);
  else { stopTts(); setStatus(more ? "Finished the chapter." : "Finished the book."); }
}
// Pause (ms) inserted only at a paragraph boundary; 0 within one long paragraph's pieces.
function gapBetween(a, b) {
  return R.chunks[b].gi !== R.chunks[a].gi ? (R.sentPause || 0) : 0;
}
function speakFrom(i) {
  synth.cancel();
  if (R.pauseTimer) { clearTimeout(R.pauseTimer); R.pauseTimer = null; }
  R.utters = [];
  if (i >= R.segEls.length) { advanceChapterOrStop(); return; } // end of chapter
  if (i < 0) i = 0;
  if (!R.chunks.length) buildChunks();
  R.segIndex = i; R.speaking = true; R.paused = false;
  R.spokenUpto = -1;
  const t = ++R.token;
  highlight(i); saveProgressSoon();
  playChunk(chunkForSeg(i), t);
  updatePlayBtn();
}
// Speak one chunk. To hide the voice's start-up latency (remote voices such as
// "Google US English" buffer before each utterance, which was heard as a silent gap
// at every paragraph even with the gap set to 0), we PIPELINE: while a chunk plays we
// queue the next one whenever the gap to it is 0, so the engine pre-buffers it and
// playback is gapless. A real paragraph gap (R.sentPause > 0) is honoured with a timer.
function playChunk(c, t) {
  if (t !== R.token || c >= R.chunks.length || c <= R.spokenUpto) return; // guard double-speak
  R.spokenUpto = c;
  const chunk = R.chunks[c];
  if (!chunk || !chunk.text) return;
  const u = new SpeechSynthesisUtterance(spokenText(chunk.text));
  u.rate = R.rate;
  if (R.voice) { u.voice = R.voice; u.lang = R.voice.lang; }
  u.onstart = () => {
    if (t !== R.token) return;
    if (chunk.gi !== R.segIndex) { R.segIndex = chunk.gi; highlight(chunk.gi); saveProgressSoon(); }
    const nx = c + 1;
    if (nx < R.chunks.length && gapBetween(c, nx) === 0) playChunk(nx, t); // pre-buffer next → gapless
  };
  u.onend = () => {
    if (t !== R.token || R.paused) return;
    const nx = c + 1;
    if (nx >= R.chunks.length) { if (c === R.chunks.length - 1) advanceChapterOrStop(); return; }
    const gap = gapBetween(c, nx);
    if (gap > 0) R.pauseTimer = setTimeout(() => { R.pauseTimer = null; if (t === R.token && !R.paused) playChunk(nx, t); }, gap);
    // gap === 0 → the next chunk was already pipelined in onstart; nothing to do here.
  };
  u.onerror = () => { if (t !== R.token) return; const nx = c + 1; if (nx < R.chunks.length) playChunk(nx, t); };
  R.utters.push(u); // hold refs so utterances aren't garbage-collected mid-speech
  synth.speak(u);
}
function togglePlay() {
  if (!R.book) return;
  if (!R.speaking) { speakFrom(R.segIndex || 0); return; }
  if (R.paused) {
    R.paused = false;
    if (synth.paused) synth.resume();
    else if (!synth.speaking) speakFrom(R.segIndex); // resumed during an inter-paragraph gap
  } else {
    R.paused = true;
    synth.pause();
  }
  updatePlayBtn();
}
function stopTts() {
  R.token++;
  R.speaking = false; R.paused = false;
  R.utters = []; R.chunkQueue = 0; R.spokenUpto = -1;
  if (R.pauseTimer) { clearTimeout(R.pauseTimer); R.pauseTimer = null; }
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

// ---- reader Display (font / size / line-height / theme) ----
function setVar(name, val) {
  const el = $("modeRead"); if (!el) return;
  if (val === "" || val == null) el.style.removeProperty(name);
  else el.style.setProperty(name, val);
}
// Resolve a font-dropdown choice to a CSS font-family value. Choices are: "" (system),
// a FONT_STACKS preset key, "named:<Family>" for a common font, or "imported" for a font
// the user imported from a file.
function fontCssFor(choice) {
  if (!choice) return "";
  if (FONT_STACKS[choice] != null) return FONT_STACKS[choice];
  if (choice === "imported") return (R.importedFont && R.importedFont.name) ? `"${R.importedFont.name}", serif` : "";
  if (choice.indexOf("named:") === 0) return `"${choice.slice(6)}", system-ui, sans-serif`;
  return "";
}
// (Re)build the font <select> from presets + common fonts + any imported font.
function buildFontSelect() {
  const sel = $("readFontSelect"); if (!sel) return;
  sel.innerHTML = "";
  const optGroup = (label) => { const g = document.createElement("optgroup"); g.label = label; sel.appendChild(g); return g; };
  const add = (parent, value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; parent.appendChild(o); };
  const g1 = optGroup("Presets");
  FONT_PRESETS.forEach(([v, l]) => add(g1, v, l));
  const g2 = optGroup("Installed fonts");
  NAMED_FONTS.forEach((n) => add(g2, "named:" + n, n));
  if (R.importedFont && R.importedFont.name) {
    const g3 = optGroup("Imported");
    add(g3, "imported", R.importedFont.name + " (imported)");
  }
  sel.value = R.fontKey || "";
}
// Register an imported font with the document so it can be used by name. dataUrl persists
// in readerPrefs, so we re-register on load.
async function registerImportedFont(name, dataUrl) {
  try {
    if (!name || !dataUrl || typeof FontFace === "undefined") return false;
    const ff = new FontFace(name, `url(${dataUrl})`);
    await ff.load();
    document.fonts.add(ff);
    return true;
  } catch (e) { console.warn("font import/register failed", e); return false; }
}
// Import a local font file (.ttf/.otf/.woff/.woff2): register it and remember it.
function importFontFile(file) {
  if (!file) return;
  const name = (file.name || "Imported font").replace(/\.[^.]+$/, "").replace(/[^\w \-]/g, "").trim() || "Imported font";
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const ok = await registerImportedFont(name, dataUrl);
    if (!ok) { setStatus("Couldn't load that font file."); return; }
    R.importedFont = { name, dataUrl };
    R.fontKey = "imported";
    buildFontSelect();
    applyDisplay();
    saveReaderPrefs();
    setStatus(`Font “${name}” imported.`);
  };
  reader.onerror = () => setStatus("Couldn't read that font file.");
  reader.readAsDataURL(file);
}

// Push the current display prefs onto #modeRead as CSS variables (see popup.css).
function applyDisplay() {
  const root = $("modeRead"); if (!root) return;
  let bg = null, fg = null;
  if (R.theme === "custom") { bg = R.customBg; fg = R.customFg; }
  else { const t = THEMES[R.theme]; if (t && t.bg) { bg = t.bg; fg = t.fg; } }
  root.classList.toggle("reader-themed", !!bg);
  setVar("--reader-bg", bg || "");
  setVar("--reader-fg", fg || "");
  setVar("--reader-font", fontCssFor(R.fontKey) || "");
  setVar("--reader-size", (R.fontSize || 17) + "px");
  setVar("--reader-lh", String(R.lineHeight || 1.75));
  setVar("--reader-width", (R.width || 700) + "px");
  setVar("--reader-align", R.justify ? "justify" : "left");
  setVar("--reader-para-gap", (R.paraGap || 0.9) + "em");
  setVar("--reader-weight", R.bold ? "600" : "400");
  syncDisplayUI();
}
// Reflect state onto the panel's controls (active buttons, value labels, pickers).
function syncDisplayUI() {
  document.querySelectorAll("#readThemeRow .rd-swatch").forEach((b) => b.classList.toggle("active", b.dataset.theme === R.theme));
  const cc = $("readCustomColors"); if (cc) cc.classList.toggle("hidden", R.theme !== "custom");
  if ($("readBgColor")) $("readBgColor").value = R.customBg;
  if ($("readFgColor")) $("readFgColor").value = R.customFg;
  if ($("readFontSelect")) $("readFontSelect").value = R.fontKey || "";
  if ($("readSizeVal")) $("readSizeVal").textContent = String(R.fontSize);
  if ($("readLhVal")) $("readLhVal").textContent = Number(R.lineHeight).toFixed(2);
  if ($("readWidthVal")) $("readWidthVal").textContent = String(R.width);
  if ($("readGapVal")) $("readGapVal").textContent = Number(R.paraGap).toFixed(2);
  if ($("readJustify")) $("readJustify").checked = R.justify;
  if ($("readBold")) $("readBold").checked = R.bold;
}
function renderThemeSwatches() {
  const row = $("readThemeRow"); if (!row) return;
  row.innerHTML = "";
  THEME_ORDER.forEach((id) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "rd-swatch"; b.dataset.theme = id; b.textContent = "Aa";
    if (id === "custom") { b.textContent = "＋"; b.title = "Custom colors"; b.style.background = R.customBg; b.style.color = R.customFg; }
    else if (id === "default") { b.title = "Default (follows the app theme)"; b.style.background = "var(--card-2)"; b.style.color = "var(--fg)"; }
    else { const t = THEMES[id]; b.title = id.charAt(0).toUpperCase() + id.slice(1); b.style.background = t.bg; b.style.color = t.fg; }
    b.addEventListener("click", () => { R.theme = id; applyDisplay(); saveReaderPrefs(); });
    row.appendChild(b);
  });
}
function openDisplay() { $("readDisplayPanel").classList.add("open"); $("readDisplayBackdrop").classList.add("open"); }
function closeDisplay() { $("readDisplayPanel").classList.remove("open"); $("readDisplayBackdrop").classList.remove("open"); }

// ---- reader UI prefs (player position, toggles, voice, rate) ----
function saveReaderPrefs() {
  if (!store) return;
  try { store.set({ readerPrefs: {
    follow: R.follow, hl: R.hl, readSymbols: R.readSymbols, autoNext: R.autoNext, rate: R.rate, sentPause: R.sentPause, voiceName: R.userVoice, pos: R.pos, collapsed: R.collapsed, tocReversed: R.tocReversed,
    theme: R.theme, customBg: R.customBg, customFg: R.customFg, fontKey: R.fontKey, importedFont: R.importedFont,
    fontSize: R.fontSize, lineHeight: R.lineHeight, width: R.width, paraGap: R.paraGap, justify: R.justify, bold: R.bold,
  } }); } catch (_) {}
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

  R.tocTranslated = false; R.tocTitlesEn = null; updateTocTranslateBtn();
  renderToc();
  $("ttsPlayer").classList.remove("hidden");
  $("readBodyCard").classList.remove("hidden");
  loadVoices();

  const start = (typeof startIndex === "number" && startIndex >= 0 && startIndex < chapters.length) ? startIndex : 0;
  setStatus(`${chapters.length} chapters — reading from chapter ${start + 1}.`);
  // Offer to resume where you left off (same as file mode). Saved progress that's
  // further along than the opened chapter shows a Continue banner; otherwise start here.
  getProgress(R.bookKey).then((prog) => {
    if (prog && (prog.chapterIndex > start || (prog.chapterIndex === start && prog.segIndex > 0))) {
      $("readResumeMsg").textContent = `Resume: ${prog.title || "Chapter " + (prog.chapterIndex + 1)} · line ${prog.segIndex + 1}`;
      $("readResume").classList.remove("hidden");
      $("readResumeBtn").onclick = () => { $("readResume").classList.add("hidden"); loadChapter(prog.chapterIndex, prog.segIndex, false); };
      $("readResumeStart").onclick = () => { $("readResume").classList.add("hidden"); loadChapter(start, 0, false); };
    } else {
      loadChapter(start, 0, false);
    }
  }).catch(() => loadChapter(start, 0, false));
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
export function readerStop() { stopTts(); saveProgress(); closeDrawer(); closeDisplay(); setImmersive(false); }

export function initRead() {
  $("readOpen").addEventListener("click", () => $("readFile").click());
  $("readFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; openFile(f); e.target.value = ""; });

  $("ttsPlay").addEventListener("click", togglePlay);
  $("ttsStop").addEventListener("click", stopTts);
  $("ttsPrev").addEventListener("click", () => stepLine(-1));
  $("ttsNext").addEventListener("click", () => stepLine(1));
  $("ttsVoice").addEventListener("change", (e) => { R.voice = R.voices[+e.target.value] || null; R.userVoice = R.voice && R.voice.name; saveReaderPrefs(); if (R.speaking) speakFrom(R.segIndex); });
  const applyRate = () => { let r = parseFloat($("ttsRate").value); if (!isFinite(r)) r = 1; if (r < 0.5) r = 0.5; if (r > 2) r = 2; R.rate = r; };
  $("ttsRate").addEventListener("input", applyRate);
  $("ttsRate").addEventListener("change", () => { applyRate(); $("ttsRate").value = R.rate.toFixed(1); saveReaderPrefs(); if (R.speaking) speakFrom(R.segIndex); }); // apply new rate from the current line
  if ($("ttsPause")) {
    // Number box in SECONDS; stored internally as ms. Takes effect at the next gap.
    const applyPause = () => { let s = parseFloat($("ttsPause").value); if (!isFinite(s) || s < 0) s = 0; if (s > 5) s = 5; R.sentPause = Math.round(s * 1000); };
    $("ttsPause").addEventListener("input", applyPause);
    $("ttsPause").addEventListener("change", () => { applyPause(); $("ttsPause").value = (R.sentPause / 1000).toFixed(2); saveReaderPrefs(); });
  }
  $("ttsFollow").addEventListener("change", (e) => { R.follow = e.target.checked; saveReaderPrefs(); if (R.follow) highlight(R.segIndex); });
  $("ttsHighlight").addEventListener("change", (e) => { R.hl = e.target.checked; highlight(R.segIndex, false); saveReaderPrefs(); });
  if ($("ttsSymbols")) $("ttsSymbols").addEventListener("change", (e) => { R.readSymbols = e.target.checked; saveReaderPrefs(); if (R.speaking) speakFrom(R.segIndex); });
  if ($("ttsAutoNext")) $("ttsAutoNext").addEventListener("change", (e) => { R.autoNext = e.target.checked; saveReaderPrefs(); });
  $("ttsCollapse").addEventListener("click", () => { R.collapsed = !R.collapsed; $("ttsPlayer").classList.toggle("collapsed", R.collapsed); $("ttsCollapse").textContent = R.collapsed ? "▸" : "▾"; saveReaderPrefs(); });
  initDrag();

  // restore saved player prefs
  if (store) try {
    store.get("readerPrefs", (o) => {
      const p = o && o.readerPrefs; if (!p) return;
      if (typeof p.follow === "boolean") { R.follow = p.follow; $("ttsFollow").checked = p.follow; }
      if (typeof p.hl === "boolean") { R.hl = p.hl; $("ttsHighlight").checked = p.hl; }
      if (typeof p.readSymbols === "boolean" && $("ttsSymbols")) { R.readSymbols = p.readSymbols; $("ttsSymbols").checked = p.readSymbols; }
      if (typeof p.autoNext === "boolean" && $("ttsAutoNext")) { R.autoNext = p.autoNext; $("ttsAutoNext").checked = p.autoNext; }
      if (typeof p.rate === "number") { R.rate = p.rate; $("ttsRate").value = p.rate.toFixed(1); }
      if (typeof p.sentPause === "number" && $("ttsPause")) { R.sentPause = p.sentPause; $("ttsPause").value = (p.sentPause / 1000).toFixed(2); }
      if (p.voiceName) R.userVoice = p.voiceName;
      if (p.pos) R.pos = p.pos;
      R.collapsed = !!p.collapsed;
      R.tocReversed = !!p.tocReversed;
      // display prefs
      const num = (v, d) => (typeof v === "number" && isFinite(v)) ? v : d;
      if (typeof p.theme === "string") R.theme = p.theme;
      if (typeof p.customBg === "string") R.customBg = p.customBg;
      if (typeof p.customFg === "string") R.customFg = p.customFg;
      if (typeof p.fontKey === "string") R.fontKey = p.fontKey;
      if (p.importedFont && p.importedFont.name && p.importedFont.dataUrl) {
        R.importedFont = p.importedFont;
        registerImportedFont(p.importedFont.name, p.importedFont.dataUrl).then(() => { buildFontSelect(); applyDisplay(); });
      }
      R.fontSize = num(p.fontSize, R.fontSize);
      R.lineHeight = num(p.lineHeight, R.lineHeight);
      R.width = num(p.width, R.width);
      R.paraGap = num(p.paraGap, R.paraGap);
      if (typeof p.justify === "boolean") R.justify = p.justify;
      if (typeof p.bold === "boolean") R.bold = p.bold;
      applyPlayerPos();
      renderThemeSwatches();
      buildFontSelect();
      applyDisplay();
    });
  } catch (_) {}

  $("readPrev").addEventListener("click", () => loadChapter(R.chapter - 1, 0, R.speaking));
  $("readNext").addEventListener("click", () => loadChapter(R.chapter + 1, 0, R.speaking));

  // Contents drawer (hamburger)
  $("readMenu").addEventListener("click", () => { $("readDrawer").classList.contains("open") ? closeDrawer() : openDrawer(); });
  $("readDrawerClose").addEventListener("click", closeDrawer);
  $("readBackdrop").addEventListener("click", closeDrawer);
  $("readTocReverse").addEventListener("click", () => { R.tocReversed = !R.tocReversed; renderToc(); saveReaderPrefs(); });
  if ($("readTocTranslate")) $("readTocTranslate").addEventListener("click", translateToc);

  // Display panel (font / size / line-height / reading theme) — all local, saved prefs.
  renderThemeSwatches();
  if ($("readDisplayBtn")) $("readDisplayBtn").addEventListener("click", () => { $("readDisplayPanel").classList.contains("open") ? closeDisplay() : openDisplay(); });
  if ($("readDisplayClose")) $("readDisplayClose").addEventListener("click", closeDisplay);
  if ($("readDisplayBackdrop")) $("readDisplayBackdrop").addEventListener("click", closeDisplay);
  buildFontSelect();
  if ($("readFontSelect")) $("readFontSelect").addEventListener("change", (e) => { R.fontKey = e.target.value; applyDisplay(); saveReaderPrefs(); });
  if ($("readFontImport")) $("readFontImport").addEventListener("click", () => { const f = $("readFontFile"); if (f) f.click(); });
  if ($("readFontFile")) $("readFontFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; importFontFile(f); e.target.value = ""; });
  if ($("readBgColor")) $("readBgColor").addEventListener("input", (e) => { R.customBg = e.target.value; R.theme = "custom"; applyDisplay(); saveReaderPrefs(); });
  if ($("readFgColor")) $("readFgColor").addEventListener("input", (e) => { R.customFg = e.target.value; R.theme = "custom"; applyDisplay(); saveReaderPrefs(); });
  const r2 = (v) => Math.round(v * 100) / 100;
  const step = (field, delta, lo, hi, round) => { R[field] = clamp(round(R[field] + delta), lo, hi); applyDisplay(); saveReaderPrefs(); };
  if ($("readSizeMinus")) $("readSizeMinus").addEventListener("click", () => step("fontSize", -1, 12, 32, Math.round));
  if ($("readSizePlus")) $("readSizePlus").addEventListener("click", () => step("fontSize", 1, 12, 32, Math.round));
  if ($("readLhMinus")) $("readLhMinus").addEventListener("click", () => step("lineHeight", -0.05, 1.2, 2.6, r2));
  if ($("readLhPlus")) $("readLhPlus").addEventListener("click", () => step("lineHeight", 0.05, 1.2, 2.6, r2));
  if ($("readWidthMinus")) $("readWidthMinus").addEventListener("click", () => step("width", -40, 480, 1200, Math.round));
  if ($("readWidthPlus")) $("readWidthPlus").addEventListener("click", () => step("width", 40, 480, 1200, Math.round));
  if ($("readGapMinus")) $("readGapMinus").addEventListener("click", () => step("paraGap", -0.1, 0, 2.5, r2));
  if ($("readGapPlus")) $("readGapPlus").addEventListener("click", () => step("paraGap", 0.1, 0, 2.5, r2));
  if ($("readJustify")) $("readJustify").addEventListener("change", (e) => { R.justify = e.target.checked; applyDisplay(); saveReaderPrefs(); });
  if ($("readBold")) $("readBold").addEventListener("change", (e) => { R.bold = e.target.checked; applyDisplay(); saveReaderPrefs(); });
  if ($("readDisplayReset")) $("readDisplayReset").addEventListener("click", () => { Object.assign(R, DISPLAY_DEFAULTS); renderThemeSwatches(); applyDisplay(); saveReaderPrefs(); });
  applyDisplay();

  // Tap the reading area: while immersed → reveal controls (no TTS start);
  // otherwise, tapping a line speaks from there.
  $("readContent").addEventListener("click", (e) => {
    if (R.immersive) { setImmersive(false); R.lastY = window.scrollY; return; }
    const seg = e.target.closest && e.target.closest(".seg");
    if (!seg) return;
    speakFrom(+seg.dataset.seg);
  });

  // Auto-hide chrome on scroll (down hides, up shows); ignores TTS-follow scrolls.
  window.addEventListener("scroll", () => { updateNavPin(); if (!$("modeRead").hidden) onReaderScroll(); }, { passive: true });
  // Re-dock the floating player when the viewport crosses the mobile/desktop threshold
  // (rotation, window resize, DevTools device mode) so it never ends up off-screen.
  window.addEventListener("resize", () => { try { applyPlayerPos(); } catch (_) {} updateNavPin(); });

  if (typeof synth !== "undefined" && synth) synth.onvoiceschanged = loadVoices;

  // keyboard: only while Read mode is visible and focus isn't on a control
  document.addEventListener("keydown", (e) => {
    if ($("modeRead").hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (e.key === "Escape") {
      if ($("readDisplayPanel") && $("readDisplayPanel").classList.contains("open")) { closeDisplay(); return; }
      if ($("readDrawer").classList.contains("open")) { closeDrawer(); return; }
    }
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); loadChapter(R.chapter - 1, 0, R.speaking); }
    else if (e.key === "ArrowRight") { e.preventDefault(); loadChapter(R.chapter + 1, 0, R.speaking); }
  });

  window.addEventListener("beforeunload", () => { try { synth.cancel(); } catch (_) {} saveProgress(); });
}
