// Web Reader — on-site floating widget (content script).
//
// Injected on every page. When enabled (via the extension's "Web Reader" tab), it
// shows a small draggable bubble that expands into a panel offering:
//   • Translate page  — swap the page's text to English in place (Show original restores)
//   • Read aloud      — speak the (translated) page, highlighting/following each paragraph
//   • Reader mode     — a clean, distraction-free reading overlay of the same content
//   • Open in Reader  — hand off to the extension's full reader (openLive) in a new tab
//
// Translation is routed through the service worker (background.js) because in MV3 a
// content script's fetch is bound by the host page's CORS/CSP.
(() => {
  "use strict";
  if (window.top !== window) return;             // top frame only
  if (window.__wrWidgetLoaded) return;
  window.__wrWidgetLoaded = true;
  const scheme = location.protocol;
  if (scheme !== "http:" && scheme !== "https:") return;

  // ---------- settings ----------
  const store = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null;

  // Glossary (term-lock): shared with the extension via chrome.storage "glossaries".
  // We import the SAME translate.js the adapters use, so setGlossary() also corrects
  // adapter-fetched chapter text; the generic page path applies it in requestTranslate.
  let _TX = null, _glossary = [];
  function glCanon(u) {
    try {
      const url = new URL(u); url.hash = ""; url.search = "";
      url.pathname = url.pathname.replace(/\/chapter-\d+\/?$/i, "").replace(/\/episodes\/\d+\/?$/i, "").replace(/\/+$/, "") || "/";
      return url.toString();
    } catch (_) { return String(u || "").split(/[?#]/)[0].replace(/\/+$/, ""); }
  }
  async function loadGlossary() {
    if (!store) return;
    try {
      if (!_TX) _TX = await import(chrome.runtime.getURL("adapters/translate.js"));
      const g = await new Promise((res) => { try { store.get("glossaries", (o) => res((o && o.glossaries) || {})); } catch (_) { res({}); } });
      const global = Array.isArray(g["*"]) ? g["*"] : [];
      const novel = Array.isArray(g[glCanon(location.href)]) ? g[glCanon(location.href)] : [];
      _glossary = global.concat(novel);
      if (_TX && _TX.setGlossary) _TX.setGlossary(_glossary);
    } catch (_) { /* ignore */ }
  }
  function applyGl(arr) { return (_TX && _glossary.length && _TX.applyGlossary) ? arr.map((t) => _TX.applyGlossary(t, _glossary)) : arr; }
  const LANGS = [
    ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
    ["pt", "Portuguese"], ["ru", "Russian"], ["ja", "Japanese"], ["ko", "Korean"],
    ["zh-CN", "Chinese"], ["id", "Indonesian"], ["vi", "Vietnamese"], ["ar", "Arabic"],
    ["hi", "Hindi"], ["tl", "Filipino"],
  ];
  const CFG = { enabled: false, autoTranslate: false, targetLang: "en", rate: 1, sentPause: 250, voiceName: "", follow: true, highlight: true, readSymbols: true, autoNext: true, pos: null, ttsCollapsed: false,
    // Reader-mode overlay display settings (font / size / line-height / theme + advanced).
    ovTheme: "default", ovBg: "#ffffff", ovFg: "#111111", ovFont: "", ovImportedFont: null, ovSize: 18, ovLh: 1.7,
    ovWidth: 720, ovGap: 1.1, ovJustify: false, ovBold: false };

  // ---------- reader-overlay display (font / size / line-height / theme) ----------
  const OV_THEMES = {
    default: { bg: null, fg: null }, white: { bg: "#ffffff", fg: "#1a1a1a" }, sepia: { bg: "#f4ecd8", fg: "#5b4636" },
    cream: { bg: "#faf3e0", fg: "#46402f" }, blue: { bg: "#dbe6f0", fg: "#1c2a38" }, rose: { bg: "#f7e6ea", fg: "#4a2b30" },
    mint: { bg: "#e2efe4", fg: "#22352a" }, grey: { bg: "#2a2c31", fg: "#d4d6da" }, black: { bg: "#000000", fg: "#c8c8c8" },
  };
  const OV_THEME_ORDER = ["default", "white", "sepia", "cream", "blue", "rose", "mint", "grey", "black", "custom"];
  const OV_FONT_STACKS = {
    "": "", serif: 'Georgia, "Times New Roman", serif', sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    rounded: '"Nunito", "Varela Round", "Segoe UI", system-ui, sans-serif', reading: '"Lora", "Iowan Old Style", Georgia, serif',
    dyslexic: '"OpenDyslexic", "Comic Sans MS", "Trebuchet MS", sans-serif',
  };
  const OV_FONT_PRESETS = [["", "System default"], ["serif", "Serif"], ["sans", "Sans-serif"], ["rounded", "Rounded"], ["reading", "Reading (book)"], ["dyslexic", "Dyslexic-friendly"]];
  const OV_NAMED_FONTS = ["Georgia", "Times New Roman", "Palatino Linotype", "Garamond", "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI", "Calibri", "Courier New", "Comic Sans MS"];
  function ovFontCss(choice) {
    if (!choice) return "";
    if (OV_FONT_STACKS[choice] != null) return OV_FONT_STACKS[choice];
    if (choice === "imported") return (CFG.ovImportedFont && CFG.ovImportedFont.name) ? `"${CFG.ovImportedFont.name}", serif` : "";
    if (choice.indexOf("named:") === 0) return `"${choice.slice(6)}", system-ui, sans-serif`;
    return "";
  }
  function applyOverlayDisplay() {
    if (!W.overlay) return;
    const s = W.overlay.style;
    const setv = (n, v) => { if (v == null || v === "") s.removeProperty(n); else s.setProperty(n, v); };
    let bg = null, fg = null;
    if (CFG.ovTheme === "custom") { bg = CFG.ovBg; fg = CFG.ovFg; }
    else { const t = OV_THEMES[CFG.ovTheme]; if (t && t.bg) { bg = t.bg; fg = t.fg; } }
    W.overlay.classList.toggle("wr-ov-themed", !!bg);
    setv("--wr-ov-bg", bg || ""); setv("--wr-ov-fg", fg || "");
    setv("--wr-ov-font", ovFontCss(CFG.ovFont) || "");
    setv("--wr-ov-size", (CFG.ovSize || 18) + "px");
    setv("--wr-ov-lh", String(CFG.ovLh || 1.7));
    setv("--wr-ov-width", (CFG.ovWidth || 720) + "px");
    setv("--wr-ov-gap", (CFG.ovGap != null ? CFG.ovGap : 1.1) + "em");
    setv("--wr-ov-align", CFG.ovJustify ? "justify" : "left");
    setv("--wr-ov-weight", CFG.ovBold ? "600" : "400");
  }
  async function registerOvFont(name, dataUrl) {
    try {
      if (!name || !dataUrl || typeof FontFace === "undefined") return false;
      const ff = new FontFace(name, `url(${dataUrl})`); await ff.load(); document.fonts.add(ff); return true;
    } catch (e) { console.warn("[WebReader] font import failed", e); return false; }
  }
  function buildOvFontSelect(sel) {
    if (!sel) return;
    sel.innerHTML = "";
    const grp = (label) => { const g = document.createElement("optgroup"); g.label = label; sel.appendChild(g); return g; };
    const add = (p, v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; p.appendChild(o); };
    const g1 = grp("Presets"); OV_FONT_PRESETS.forEach(([v, l]) => add(g1, v, l));
    const g2 = grp("Installed"); OV_NAMED_FONTS.forEach((n) => add(g2, "named:" + n, n));
    if (CFG.ovImportedFont && CFG.ovImportedFont.name) { const g3 = grp("Imported"); add(g3, "imported", CFG.ovImportedFont.name + " (imported)"); }
    sel.value = CFG.ovFont || "";
  }
  function syncOvDisplay() {
    const p = W.ovDisplay; if (!p) return;
    p.querySelectorAll(".wr-ovd-sw").forEach((b) => b.classList.toggle("wr-active", b.dataset.theme === CFG.ovTheme));
    p.querySelector(".wr-ovd-colors").classList.toggle("wr-hidden", CFG.ovTheme !== "custom");
    const bg = p.querySelector('[data-ovd="bg"]'), fg = p.querySelector('[data-ovd="fg"]');
    if (bg) bg.value = CFG.ovBg; if (fg) fg.value = CFG.ovFg;
    const fsel = p.querySelector(".wr-ovd-font"); if (fsel) fsel.value = CFG.ovFont || "";
    const sv = p.querySelector('[data-ovd="size-val"]'); if (sv) sv.textContent = String(CFG.ovSize || 18);
    const lv = p.querySelector('[data-ovd="lh-val"]'); if (lv) lv.textContent = Number(CFG.ovLh || 1.7).toFixed(2);
    const wv = p.querySelector('[data-ovd="w-val"]'); if (wv) wv.textContent = String(CFG.ovWidth || 720);
    const gv = p.querySelector('[data-ovd="g-val"]'); if (gv) gv.textContent = Number(CFG.ovGap != null ? CFG.ovGap : 1.1).toFixed(2);
    const jb = p.querySelector('[data-ovd="justify"]'); if (jb) jb.checked = !!CFG.ovJustify;
    const bb = p.querySelector('[data-ovd="bold"]'); if (bb) bb.checked = !!CFG.ovBold;
  }
  function importOvFont(file) {
    if (!file) return;
    const name = (file.name || "Imported").replace(/\.[^.]+$/, "").replace(/[^\w \-]/g, "").trim() || "Imported font";
    const reader = new FileReader();
    reader.onload = async () => {
      const ok = await registerOvFont(name, reader.result);
      if (!ok) { setStatus("Couldn't load that font file."); return; }
      CFG.ovImportedFont = { name, dataUrl: reader.result }; CFG.ovFont = "imported"; saveCfg();
      buildOvFontSelect(W.ovDisplay && W.ovDisplay.querySelector(".wr-ovd-font"));
      applyOverlayDisplay(); syncOvDisplay(); setStatus(`Font “${name}” imported.`);
    };
    reader.onerror = () => setStatus("Couldn't read that font file.");
    reader.readAsDataURL(file);
  }
  function toggleOvDisplay() { if (W.ovDisplay) W.ovDisplay.classList.toggle("wr-hidden"); }
  // Build the overlay's Display panel (font / size / line-height / theme) and wire it.
  function buildOvDisplay(ov) {
    const panel = el("div", "wr-ov-display wr-hidden");
    panel.innerHTML = `
      <div class="wr-ovd-row"><span class="wr-ovd-label">Theme</span><div class="wr-ovd-themes"></div></div>
      <div class="wr-ovd-row wr-ovd-colors wr-hidden"><label>Bg <input type="color" data-ovd="bg"></label><label>Text <input type="color" data-ovd="fg"></label></div>
      <div class="wr-ovd-row"><span class="wr-ovd-label">Font</span><select class="wr-ovd-font"></select></div>
      <div class="wr-ovd-row"><button class="wr-btn wr-sm" data-ovd="import">⬆ Import font…</button><input type="file" class="wr-ovd-file" accept=".ttf,.otf,.woff,.woff2" hidden></div>
      <div class="wr-ovd-row"><span class="wr-ovd-label">Size</span><button class="wr-btn wr-sm" data-ovd="size-">A−</button><span class="wr-ovd-val" data-ovd="size-val"></span><button class="wr-btn wr-sm" data-ovd="size+">A+</button></div>
      <div class="wr-ovd-row"><span class="wr-ovd-label">Line</span><button class="wr-btn wr-sm" data-ovd="lh-">−</button><span class="wr-ovd-val" data-ovd="lh-val"></span><button class="wr-btn wr-sm" data-ovd="lh+">+</button></div>
      <details class="wr-ovd-adv"><summary>Advanced</summary>
        <div class="wr-ovd-row"><span class="wr-ovd-label">Width</span><button class="wr-btn wr-sm" data-ovd="w-">−</button><span class="wr-ovd-val" data-ovd="w-val"></span><button class="wr-btn wr-sm" data-ovd="w+">+</button></div>
        <div class="wr-ovd-row"><span class="wr-ovd-label">Spacing</span><button class="wr-btn wr-sm" data-ovd="g-">−</button><span class="wr-ovd-val" data-ovd="g-val"></span><button class="wr-btn wr-sm" data-ovd="g+">+</button></div>
        <div class="wr-ovd-row"><label class="wr-ovd-check"><input type="checkbox" data-ovd="justify"> Justify</label><label class="wr-ovd-check"><input type="checkbox" data-ovd="bold"> Bolder</label></div>
      </details>`;
    ov.appendChild(panel);
    W.ovDisplay = panel;
    const themes = panel.querySelector(".wr-ovd-themes");
    OV_THEME_ORDER.forEach((id) => {
      const b = el("button", "wr-ovd-sw"); b.dataset.theme = id; b.textContent = id === "custom" ? "＋" : "Aa";
      if (id === "custom") { b.style.background = CFG.ovBg; b.style.color = CFG.ovFg; }
      else if (id === "default") { b.style.background = "#333"; b.style.color = "#eee"; }
      else { const t = OV_THEMES[id]; b.style.background = t.bg; b.style.color = t.fg; }
      b.addEventListener("click", () => { CFG.ovTheme = id; saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
      themes.appendChild(b);
    });
    buildOvFontSelect(panel.querySelector(".wr-ovd-font"));
    panel.querySelector(".wr-ovd-font").addEventListener("change", (e) => { CFG.ovFont = e.target.value; saveCfg(); applyOverlayDisplay(); });
    panel.querySelector('[data-ovd="bg"]').addEventListener("input", (e) => { CFG.ovBg = e.target.value; CFG.ovTheme = "custom"; saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="fg"]').addEventListener("input", (e) => { CFG.ovFg = e.target.value; CFG.ovTheme = "custom"; saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    const file = panel.querySelector(".wr-ovd-file");
    panel.querySelector('[data-ovd="import"]').addEventListener("click", () => file.click());
    file.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; importOvFont(f); e.target.value = ""; });
    const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v)), r2 = (v) => Math.round(v * 100) / 100;
    panel.querySelector('[data-ovd="size-"]').addEventListener("click", () => { CFG.ovSize = cl((CFG.ovSize || 18) - 1, 12, 34); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="size+"]').addEventListener("click", () => { CFG.ovSize = cl((CFG.ovSize || 18) + 1, 12, 34); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="lh-"]').addEventListener("click", () => { CFG.ovLh = cl(r2((CFG.ovLh || 1.7) - 0.05), 1.2, 2.6); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="lh+"]').addEventListener("click", () => { CFG.ovLh = cl(r2((CFG.ovLh || 1.7) + 0.05), 1.2, 2.6); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    const gap = () => (CFG.ovGap != null ? CFG.ovGap : 1.1);
    panel.querySelector('[data-ovd="w-"]').addEventListener("click", () => { CFG.ovWidth = cl((CFG.ovWidth || 720) - 40, 480, 1200); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="w+"]').addEventListener("click", () => { CFG.ovWidth = cl((CFG.ovWidth || 720) + 40, 480, 1200); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="g-"]').addEventListener("click", () => { CFG.ovGap = cl(r2(gap() - 0.1), 0, 2.5); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="g+"]').addEventListener("click", () => { CFG.ovGap = cl(r2(gap() + 0.1), 0, 2.5); saveCfg(); applyOverlayDisplay(); syncOvDisplay(); });
    panel.querySelector('[data-ovd="justify"]').addEventListener("change", (e) => { CFG.ovJustify = e.target.checked; saveCfg(); applyOverlayDisplay(); });
    panel.querySelector('[data-ovd="bold"]').addEventListener("change", (e) => { CFG.ovBold = e.target.checked; saveCfg(); applyOverlayDisplay(); });
    syncOvDisplay();
  }

  // Strip symbols/brackets/quotes/slashes some voices read aloud, keeping letters,
  // numbers, whitespace and sentence punctuation (for natural pauses). Used only on
  // the SPOKEN text — the on-screen text is untouched.
  function stripSymbols(s) {
    try { return s.replace(/[^\p{L}\p{N}\s.,!?~…。！？、，〜〰～]/gu, " ").replace(/\s{2,}/g, " ").trim(); }
    catch (_) { return s.replace(/[^0-9A-Za-z\s.,!?~]/g, " ").replace(/\s{2,}/g, " ").trim(); }
  }
  function spokenText(t) { return (CFG.readSymbols === false ? stripSymbols(t) : t) || t; }

  function loadCfg() {
    return new Promise((res) => {
      if (!store) return res(CFG);
      try {
        store.get("webWidget", (o) => {
          Object.assign(CFG, (o && o.webWidget) || {});
          res(CFG);
        });
      } catch (_) { res(CFG); }
    });
  }
  function saveCfg() { try { store && store.set({ webWidget: { ...CFG } }); } catch (_) {} }

  // ---------- state ----------
  const W = {
    root: null, mini: null, panel: null, overlay: null, statusEl: null,
    translated: false, showingOriginal: false, translating: false,
    txNodes: [],         // [{ node, orig, tr }] in-place translated text nodes (menu + prose)
    blocks: [],          // [{ el, text }] live-page blocks used for read-aloud + reader
    // tts
    synth: window.speechSynthesis || null,
    voices: [], voice: null, chunks: [], utters: [], token: 0,
    speaking: false, paused: false, blockIdx: 0, chunkQueue: 0, spokenUpto: -1, pauseTimer: null,
    ttsHost: null,       // where the highlight lives: "page" or "overlay"
    adapterUrl: null, adapterContent: undefined, // cached site-adapter chapter for this URL
    overlayNav: null,    // { prevUrl, nextUrl } for the reader overlay's chapter buttons
  };
  const MAX_CHUNK = 500;

  // ================================================================= DOM build
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  function build() {
    if (W.root) return;
    const root = el("div"); root.id = "wr-root";

    // collapsed = a small floating player (play/pause, prev, next, stop + open)
    const mini = el("div", "wr-mini");
    mini.innerHTML = `
      <span class="wr-mini-grip" title="Drag">⠿</span>
      <button class="wr-mini-btn wr-mini-play" data-tts="play" title="Play / Pause">▶</button>
      <button class="wr-mini-btn" data-tts="prev" title="Previous">⏮</button>
      <button class="wr-mini-btn" data-tts="next" title="Next">⏭</button>
      <button class="wr-mini-btn" data-tts="stop" title="Stop">■</button>
      <button class="wr-mini-btn wr-mini-open" title="Open Web Reader">🌐</button>`;

    // expanded panel
    const panel = el("div", "wr-panel wr-hidden");
    panel.innerHTML = `
      <div class="wr-head">
        <span class="wr-brand">🌐 Web Reader</span>
        <span class="wr-head-btns">
          <button class="wr-icon" data-act="collapse" title="Collapse to bubble">–</button>
          <button class="wr-icon" data-act="close" title="Collapse to bubble">✕</button>
        </span>
      </div>
      <div class="wr-actions">
        <button class="wr-btn wr-primary" data-act="translate">🌐 Translate page</button>
        <button class="wr-btn" data-act="original" disabled>Show original</button>
        <button class="wr-btn" data-act="read">🔊 Read aloud</button>
        <button class="wr-btn" data-act="reader">📖 Reader mode</button>
        <button class="wr-btn" data-act="openreader">📖 Open in Reader</button>
      </div>
      <div class="wr-settings">
        <label class="wr-field">Translate to
          <select class="wr-sel" data-act="lang"></select>
        </label>
        <label class="wr-check"><input type="checkbox" data-act="auto"> <span>Auto-translate new chapters</span></label>
      </div>
      <div class="wr-tts wr-hidden" data-tts="panel"></div>
      <div class="wr-status">Ready.</div>`;

    root.appendChild(mini);
    root.appendChild(panel);
    document.documentElement.appendChild(root);

    W.root = root; W.mini = mini; W.panel = panel;
    W.statusEl = panel.querySelector(".wr-status");

    // fill language select
    const sel = panel.querySelector('[data-act="lang"]');
    for (const [code, name] of LANGS) {
      const o = el("option"); o.value = code; o.textContent = name;
      if (code === CFG.targetLang) o.selected = true;
      sel.appendChild(o);
    }
    panel.querySelector('[data-act="auto"]').checked = !!CFG.autoTranslate;

    // events — mini player controls (share the TTS handlers)
    mini.querySelector('[data-tts="play"]').addEventListener("click", togglePlay);
    mini.querySelector('[data-tts="prev"]').addEventListener("click", () => stepLine(-1));
    mini.querySelector('[data-tts="next"]').addEventListener("click", () => stepLine(1));
    mini.querySelector('[data-tts="stop"]').addEventListener("click", () => { stopTts(); setStatus("Stopped."); });
    mini.querySelector('.wr-mini-open').addEventListener("click", (e) => { if (!W._dragged) togglePanel(true); });
    panel.addEventListener("click", onPanelClick);
    sel.addEventListener("change", (e) => { CFG.targetLang = e.target.value; saveCfg(); });
    panel.querySelector('[data-act="auto"]').addEventListener("change", (e) => { CFG.autoTranslate = e.target.checked; saveCfg(); });
    // Click a paragraph on the live page to read aloud from there (in-place mode).
    if (!W._pageClickBound) { document.addEventListener("click", onPageClickToRead, true); W._pageClickBound = true; }

    // Build the TTS controls (voice/speed/gap + tick options) up front so they're
    // always visible — not only after Read aloud starts.
    const pbar = panel.querySelector('[data-tts="panel"]');
    if (pbar) { pbar.innerHTML = ttsBarHtml(); wireTtsBar(pbar); pbar.dataset.wired = "1"; pbar.classList.remove("wr-hidden"); }

    initDrag(mini);
    applyPos();
  }

  // While reading the live page in place, a click on one of the read paragraphs
  // starts speaking from it — like clicking a line in the reader overlay.
  function onPageClickToRead(e) {
    if (W.ttsHost !== "page" || !W.blocks.length) return;
    const tgt = e.target;
    if (!tgt || !tgt.closest) return;
    if (tgt.closest("#wr-root")) return;                                   // widget clicks
    if (tgt.closest("a, button, input, select, textarea, [role=button], [contenteditable=true]")) return; // don't hijack controls
    try { if (window.getSelection && String(window.getSelection())) return; } catch (_) {} // let text selection be
    const i = W.blocks.findIndex((b) => b.el && b.el.contains && b.el.contains(tgt));
    if (i >= 0) speakFrom(i);
  }

  function applyPos() {
    if (!W.mini) return;
    if (CFG.pos && typeof CFG.pos.left === "number") {
      W.root.style.left = CFG.pos.left + "px"; W.root.style.top = CFG.pos.top + "px";
      W.root.style.right = "auto"; W.root.style.bottom = "auto";
    }
  }

  function initDrag(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false, moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest && e.target.closest("button")) return; // let the mini buttons work
      drag = true; moved = false; W._dragged = false;
      const r = W.root.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      let nx = ox + dx, ny = oy + dy;
      nx = Math.max(4, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(4, Math.min(window.innerHeight - 60, ny));
      W.root.style.left = nx + "px"; W.root.style.top = ny + "px";
      W.root.style.right = "auto"; W.root.style.bottom = "auto";
      CFG.pos = { left: nx, top: ny };
    });
    const end = (e) => { if (!drag) return; drag = false; try { handle.releasePointerCapture(e.pointerId); } catch (_) {} if (moved) { W._dragged = true; saveCfg(); setTimeout(() => (W._dragged = false), 0); } };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function togglePanel(show) {
    if (!W.panel) return;
    const open = show != null ? show : W.panel.classList.contains("wr-hidden");
    W.panel.classList.toggle("wr-hidden", !open);
    W.mini.classList.toggle("wr-hidden", open);
  }

  function setStatus(t) { if (W.statusEl) W.statusEl.textContent = t; }

  function onPanelClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "collapse" || act === "close") return togglePanel(false); // collapse to bubble (never disable from the page)
    if (act === "translate") return translatePage();
    if (act === "original") return toggleOriginal();
    if (act === "read") return startReadAloud("page");
    if (act === "reader") return openReaderOverlay();
    if (act === "openreader") return openInExtensionReader();
  }

  // ================================================================= content pick
  const BAD = /(^|\s|-|_)(nav|footer|header|comment|sidebar|menu|share|advert|ads?|related|recommend|breadcrumb|wr-root)(\s|$|-|_)/i;
  // Content wrappers that merely *borrow* a chrome word are not chrome. e.g. wtr-lab
  // wraps the chapter body in ".menu-target" (a right-click-menu target, not a menu);
  // matching it as a "menu" would hide the whole chapter from Read aloud / Reader mode.
  const NOT_BAD = /(^|\s|-|_)menu-target(\s|$)/i;
  function pickContent() {
    const cands = Array.from(document.querySelectorAll(
      "article, main, [class*=content], [class*=chapter], [id*=content], [id*=chapter], .entry-content, .post-content, .reading-content, .text-content, .js-episode-body, .widget-episodeBody, [class*=episode i]"
    ));
    if (document.body) cands.push(document.body);
    let best = null, bestScore = 0;
    for (const c of cands) {
      if (c.closest("#wr-root")) continue;
      const cls = (c.className || "") + " " + (c.id || "");
      if (BAD.test(cls) && !NOT_BAD.test(cls)) continue;
      const ps = c.querySelectorAll("p");
      let textLen = 0;
      ps.forEach((p) => (textLen += (p.textContent || "").trim().length));
      if (!ps.length) textLen = (c.textContent || "").trim().length * 0.2;
      const linkText = Array.from(c.querySelectorAll("a")).reduce((n, a) => n + (a.textContent || "").length, 0);
      const total = (c.textContent || "").length || 1;
      const score = textLen * (1 - Math.min(linkText / total, 0.95));
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best || document.body;
  }

  // Never translate the site's own chrome — nav, headers/footers, menus, toolbars and
  // anything clickable — so translating a page can't break the site's buttons/links.
  const SKIP_SEL = 'a, button, nav, header, footer, aside, form, select, label, ' +
    '[role="navigation"], [role="button"], [role="menu"], [role="menubar"], [role="toolbar"], [role="banner"], [role="tablist"], [contenteditable="true"], ' +
    '[class*="header" i], [class*="footer" i], [class*="nav" i], [class*="menu" i]:not([class*="menu-target" i]), [class*="toolbar" i], [class*="global" i], [class*="button" i], ' +
    '[id*="header" i], [id*="nav" i], [id*="footer" i], [id*="global" i]';

  // Collect translatable block elements (leaf-ish prose blocks) inside the container,
  // skipping interactive / navigation regions.
  function collectBlocks(container) {
    const out = [];
    const seen = new Set();
    const add = (n) => {
      if (n.closest("#wr-root")) return;
      if (/(script|style|nav|footer|header|aside)/i.test(n.tagName)) return;
      if (n.closest(SKIP_SEL)) return;             // inside site chrome → don't read the menu aloud
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length < 2) return;
      if (seen.has(n)) return;
      seen.add(n);
      out.push({ el: n, text: t });
    };
    container.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, dd").forEach(add);
    // Many readers (e.g. wtr-lab) render each paragraph as a <div>/<section>, not <p>.
    // If the tag scan found little prose, also collect "leaf" block containers — ones
    // whose text isn't split into child blocks — so those paragraphs get read too.
    if (out.length < 2) {
      container.querySelectorAll("div, section, article").forEach((n) => {
        if (seen.has(n)) return;
        // leaf-ish: contains no nested block that would (or already did) become a block
        if (n.querySelector("p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, div, section, article, ul, ol, table")) return;
        add(n);
      });
    }
    // Last resort: no block elements found and the container itself isn't chrome — treat
    // its own text as one block (only when it holds no links/buttons to break).
    if (!out.length && !container.closest(SKIP_SEL) && !container.querySelector("a, button")) {
      const t = (container.textContent || "").replace(/\s+/g, " ").trim();
      if (t) out.push({ el: container, text: t });
    }
    return out;
  }

  // ================================================================= translation
  function requestTranslate(texts, to, from) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts, to, from }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "Translation failed."));
          resolve(applyGl(resp.out || []));
        });
      } catch (e) { reject(e); }
    });
  }

  // Collect the page's visible TEXT NODES (menus, buttons, links AND prose). We only
  // ever change a text node's characters — never an element's structure — so buttons
  // and links keep their handlers and stay clickable while their labels turn English.
  const TX_SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG|CANVAS)$/;
  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest("#wr-root")) return NodeFilter.FILTER_REJECT;
        if (TX_SKIP_TAGS.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest("[contenteditable=true], [translate=no], .notranslate")) return NodeFilter.FILTER_REJECT;
        // Skip strings with no letters (pure numbers / punctuation / symbols).
        try { if (!/\p{L}/u.test(t)) return NodeFilter.FILTER_REJECT; } catch (_) { /* older engines: accept */ }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n; while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  async function translatePage() {
    if (W.translating) return;
    if (W.translated && !W.showingOriginal) { setStatus("Page already translated."); return; }
    W.translating = true;
    setStatus("Translating…");
    try {
      const nodes = collectTextNodes(document.body);
      if (!nodes.length) { setStatus("No readable text found on this page."); return; }
      // Preserve each node's leading/trailing whitespace; translate the trimmed core.
      const parts = nodes.map((node) => {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue) || ["", "", node.nodeValue, ""];
        return { node, lead: m[1], core: m[2], trail: m[3] };
      });
      const out = await requestTranslate(parts.map((p) => p.core), CFG.targetLang, "auto");
      W.txNodes = [];
      parts.forEach((p, i) => {
        const tr = out[i];
        if (tr == null) return;
        const trVal = p.lead + tr + p.trail;
        W.txNodes.push({ node: p.node, orig: p.node.nodeValue, tr: trVal });
        p.node.nodeValue = trVal;
      });
      W.translated = true; W.showingOriginal = false;
      const orig = W.panel.querySelector('[data-act="original"]');
      if (orig) { orig.disabled = false; orig.textContent = "Show original"; }
      setStatus(`Translated ${W.txNodes.length} items → ${langName(CFG.targetLang)}.`);
    } catch (e) {
      console.warn("[WebReader] translate failed", e);
      setStatus("⚠ " + (e.message || "Translation failed."));
    } finally {
      W.translating = false;
    }
  }

  function toggleOriginal() {
    const btn = W.panel.querySelector('[data-act="original"]');
    if (!W.txNodes || !W.txNodes.length) return;
    W.showingOriginal = !W.showingOriginal;
    for (const rec of W.txNodes) {
      if (!rec.node || !rec.node.isConnected) continue; // node may have been re-rendered away
      rec.node.nodeValue = W.showingOriginal ? rec.orig : rec.tr;
    }
    if (btn) btn.textContent = W.showingOriginal ? "Show translation" : "Show original";
    setStatus(W.showingOriginal ? "Showing original text." : "Showing translation.");
  }

  function langName(code) { const f = LANGS.find((l) => l[0] === code); return f ? f[1] : code; }

  // ================================================================= text-to-speech
  // Read-aloud pacing (identical to the main reader in readerview.js): speak ONE
  // PARAGRAPH per utterance and leave a short, natural pause between paragraphs
  // (CFG.sentPause ms, adjustable). A long paragraph is hard-split into pieces (same
  // `si`) spoken back-to-back; the paragraph block is highlighted/followed as it plays.
  // The gap between paragraphs is CFG.sentPause (ms), adjustable from the TTS controls.
  function buildChunks() {
    W.chunks = [];
    W.blocks.forEach((b, bi) => {
      const text = (b.text || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      // `si` mirrors the block index so the inter-chunk gap fires only between
      // paragraphs (pieces of one long paragraph share it and flow back-to-back).
      const si = bi;
      let s = text;
      if (s.length <= MAX_CHUNK) { W.chunks.push({ bi, si, text: s }); return; }
      while (s.length > MAX_CHUNK) {
        let cut = s.lastIndexOf(" ", MAX_CHUNK); if (cut <= 0) cut = MAX_CHUNK;
        W.chunks.push({ bi, si, text: s.slice(0, cut).trim() });
        s = s.slice(cut).trim();
      }
      if (s) W.chunks.push({ bi, si, text: s });
    });
  }
  function firstChunkOfBlock(bi) {
    for (let c = 0; c < W.chunks.length; c++) if (W.chunks[c].bi >= bi) return c;
    return 0;
  }
  function highlightBlock(bi, scroll) {
    const hlOn = CFG.highlight !== false;
    W.blocks.forEach((b, k) => { if (b.el) b.el.classList.toggle("wr-speaking", hlOn && k === bi); });
    const b = W.blocks[bi];
    if (b && b.el && scroll !== false && CFG.follow !== false) { try { b.el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }
  }
  // Pause (ms) inserted only at a paragraph boundary; 0 within one long paragraph's pieces.
  function gapBetween(a, b) {
    return W.chunks[b].si !== W.chunks[a].si ? (CFG.sentPause || 0) : 0;
  }
  function speakFrom(bi) {
    if (!W.synth) { setStatus("Speech synthesis isn't available in this browser."); return; }
    W.synth.cancel();
    if (W.pauseTimer) { clearTimeout(W.pauseTimer); W.pauseTimer = null; }
    W.utters = [];
    if (bi >= W.blocks.length) { onReadFinished(); return; }
    if (bi < 0) bi = 0;
    if (!W.chunks.length) buildChunks();
    if (!W.chunks.length) { setStatus("Nothing to read."); return; }
    W.blockIdx = bi; W.speaking = true; W.paused = false;
    W.spokenUpto = -1;
    const t = ++W.token;
    highlightBlock(bi);
    playChunk(firstChunkOfBlock(bi), t);
    updatePlayBtns();
  }
  // Speak one chunk with 1-ahead PIPELINING: while a chunk plays, queue the next one
  // whenever the gap to it is 0, so the engine pre-buffers it and playback is gapless —
  // otherwise a remote voice's start-up latency is heard as silence at every paragraph
  // even with the gap set to 0. A real paragraph gap (CFG.sentPause > 0) uses a timer.
  function playChunk(c, t) {
    if (t !== W.token || c >= W.chunks.length || c <= W.spokenUpto) return; // guard double-speak
    W.spokenUpto = c;
    const chunk = W.chunks[c];
    if (!chunk || !chunk.text) return;
    const u = new SpeechSynthesisUtterance(spokenText(chunk.text));
    u.rate = CFG.rate || 1;
    if (W.voice) { u.voice = W.voice; u.lang = W.voice.lang; }
    u.onstart = () => {
      if (t !== W.token) return;
      if (chunk.bi !== W.blockIdx) { W.blockIdx = chunk.bi; highlightBlock(chunk.bi); }
      const nx = c + 1;
      if (nx < W.chunks.length && gapBetween(c, nx) === 0) playChunk(nx, t); // pre-buffer next → gapless
    };
    u.onend = () => {
      if (t !== W.token || W.paused) return;
      const nx = c + 1;
      if (nx >= W.chunks.length) { if (c === W.chunks.length - 1) onReadFinished(); return; }
      const gap = gapBetween(c, nx);
      if (gap > 0) W.pauseTimer = setTimeout(() => { W.pauseTimer = null; if (t === W.token && !W.paused) playChunk(nx, t); }, gap);
      // gap === 0 → the next chunk was already pipelined in onstart; nothing to do here.
    };
    u.onerror = () => { if (t !== W.token) return; const nx = c + 1; if (nx < W.chunks.length) playChunk(nx, t); };
    W.utters.push(u);
    W.synth.speak(u);
  }
  function togglePlay() {
    if (!W.synth) return;
    if (!W.speaking) {
      if (!W.blocks.length && W.ttsHost !== "overlay") { startReadAloud(); return; } // Play = start reading the page
      speakFrom(W.blockIdx || 0); return;
    }
    if (W.paused) {
      W.paused = false;
      if (W.synth.paused) W.synth.resume();
      else if (!W.synth.speaking) speakFrom(W.blockIdx); // resumed during an inter-paragraph gap
    } else {
      W.paused = true;
      W.synth.pause();
    }
    updatePlayBtns();
  }
  function stopTts() {
    W.token++; W.speaking = false; W.paused = false; W.utters = []; W.chunkQueue = 0; W.spokenUpto = -1;
    if (W.pauseTimer) { clearTimeout(W.pauseTimer); W.pauseTimer = null; }
    try { W.synth && W.synth.cancel(); } catch (_) {}
    W.blocks.forEach((b) => b.el && b.el.classList.remove("wr-speaking"));
    updatePlayBtns();
  }
  function stepLine(d) {
    if (!W.blocks.length) return;
    const target = (W.blockIdx || 0) + d;
    if (W.speaking) speakFrom(target);
    else { W.blockIdx = Math.min(Math.max(0, target), W.blocks.length - 1); highlightBlock(W.blockIdx); }
  }

  // Voices
  const PREFERRED_VOICE = "Google US English";
  function pickVoiceIndex(voices) {
    const byName = (n) => voices.findIndex((v) => v.name === n);
    const chain = [
      byName(CFG.voiceName),
      byName(PREFERRED_VOICE),
      voices.findIndex((v) => /^google/i.test(v.name) && /en[-_]us/i.test(v.lang || "")),
      voices.findIndex((v) => /en[-_]us/i.test(v.lang || "")),
      voices.findIndex((v) => /^en([-_]|$)/i.test(v.lang || "")),
    ];
    const idx = chain.find((i) => i >= 0);
    return idx == null ? 0 : idx;
  }
  function loadVoices() {
    if (!W.synth) return;
    const voices = W.synth.getVoices();
    W.voices = voices;
    if (!voices.length) return;
    const idx = pickVoiceIndex(voices);
    W.voice = voices[idx];
    // populate any visible voice selects
    document.querySelectorAll("#wr-root select.wr-voice").forEach((sel) => {
      sel.innerHTML = "";
      voices.forEach((v, i) => { const o = el("option"); o.value = String(i); o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o); });
      sel.value = String(idx);
    });
  }

  // ---- TTS control bar (shared markup for panel + overlay) ----
  function ttsBarHtml() {
    return `
      <div class="wr-tts-row">
        <button class="wr-btn wr-primary wr-sm" data-tts="play">▶</button>
        <button class="wr-btn wr-sm" data-tts="stop">■</button>
        <button class="wr-btn wr-sm" data-tts="prev">⏮</button>
        <button class="wr-btn wr-sm" data-tts="next">⏭</button>
        <button class="wr-btn wr-sm wr-tts-toggle" data-tts="toggle" title="Show/hide settings">${CFG.ttsCollapsed ? "▸" : "▾"}</button>
      </div>
      <div class="wr-tts-more${CFG.ttsCollapsed ? " wr-hidden" : ""}">
        <label class="wr-field wr-block">Voice <select class="wr-sel wr-voice"></select></label>
        <label class="wr-field">Speed <input type="number" class="wr-rate" min="0.5" max="2" step="0.1" value="${(CFG.rate || 1).toFixed(1)}" title="Reading speed"> ×</label>
        <label class="wr-field">Paragraph gap <input type="number" class="wr-pause" min="0" max="5" step="0.05" value="${((CFG.sentPause || 0) / 1000).toFixed(2)}" title="Pause between paragraphs, in seconds"> s</label>
        <div class="wr-tts-checks">
          <label class="wr-check"><input type="checkbox" class="wr-follow" ${CFG.follow !== false ? "checked" : ""}> <span>Follow while speaking</span></label>
          <label class="wr-check"><input type="checkbox" class="wr-hl" ${CFG.highlight !== false ? "checked" : ""}> <span>Highlight line</span></label>
          <label class="wr-check"><input type="checkbox" class="wr-sym" ${CFG.readSymbols !== false ? "checked" : ""}> <span>Read symbols ( ) ; / &hellip;</span></label>
          <label class="wr-check"><input type="checkbox" class="wr-autonext" ${CFG.autoNext !== false ? "checked" : ""}> <span>Auto-play next chapter</span></label>
        </div>
      </div>`;
  }
  function wireTtsBar(bar) {
    bar.querySelector('[data-tts="play"]').addEventListener("click", togglePlay);
    bar.querySelector('[data-tts="stop"]').addEventListener("click", () => { stopTts(); setStatus("Stopped."); });
    bar.querySelector('[data-tts="prev"]').addEventListener("click", () => stepLine(-1));
    bar.querySelector('[data-tts="next"]').addEventListener("click", () => stepLine(1));
    const toggle = bar.querySelector('[data-tts="toggle"]'), more = bar.querySelector('.wr-tts-more');
    if (toggle && more) toggle.addEventListener("click", () => {
      const hide = !more.classList.contains("wr-hidden");
      more.classList.toggle("wr-hidden", hide);
      toggle.textContent = hide ? "▸" : "▾";
      CFG.ttsCollapsed = hide; saveCfg();
    });
    const rate = bar.querySelector(".wr-rate");
    if (rate) {
      const applyRate = () => { let r = parseFloat(rate.value); if (!isFinite(r)) r = 1; if (r < 0.5) r = 0.5; if (r > 2) r = 2; CFG.rate = r; };
      rate.addEventListener("input", () => { applyRate(); saveCfg(); });
      rate.addEventListener("change", () => { applyRate(); rate.value = CFG.rate.toFixed(1); saveCfg(); if (W.speaking) speakFrom(W.blockIdx); });
    }
    const pause = bar.querySelector(".wr-pause");
    if (pause) {
      // Number box in SECONDS; stored internally as ms. Takes effect at the next gap.
      const applyPause = () => { let s = parseFloat(pause.value); if (!isFinite(s) || s < 0) s = 0; if (s > 5) s = 5; CFG.sentPause = Math.round(s * 1000); };
      pause.addEventListener("input", () => { applyPause(); saveCfg(); });
      pause.addEventListener("change", () => { applyPause(); pause.value = (CFG.sentPause / 1000).toFixed(2); saveCfg(); });
    }
    const follow = bar.querySelector(".wr-follow");
    if (follow) follow.addEventListener("change", (e) => { CFG.follow = e.target.checked; saveCfg(); if (CFG.follow && W.speaking) highlightBlock(W.blockIdx); });
    const hl = bar.querySelector(".wr-hl");
    if (hl) hl.addEventListener("change", (e) => { CFG.highlight = e.target.checked; saveCfg(); highlightBlock(W.blockIdx, false); });
    const sym = bar.querySelector(".wr-sym");
    if (sym) sym.addEventListener("change", (e) => { CFG.readSymbols = e.target.checked; saveCfg(); if (W.speaking) speakFrom(W.blockIdx); });
    const autonext = bar.querySelector(".wr-autonext");
    if (autonext) autonext.addEventListener("change", (e) => { CFG.autoNext = e.target.checked; saveCfg(); });
    const voice = bar.querySelector(".wr-voice");
    voice.addEventListener("change", (e) => {
      const i = parseInt(e.target.value, 10);
      if (W.voices[i]) { W.voice = W.voices[i]; CFG.voiceName = W.voice.name; saveCfg(); if (W.speaking) speakFrom(W.blockIdx); }
    });
    loadVoices();
  }
  function updatePlayBtns() {
    const playing = W.speaking && !W.paused;
    document.querySelectorAll('#wr-root [data-tts="play"]').forEach((b) => { b.textContent = playing ? "⏸" : "▶"; });
  }

  // ---- Site adapters (Kakuyomu, wtr-lab, …) for clean chapter text ----
  // Runs the project's real adapter inside the widget. Its same-origin fetches (the
  // chapter/episode page, wtr-lab's API) work from a content script; its Google-
  // translate calls are relayed to the service worker via __WR_TX_VIA_SW. Returns
  // { title, items:[{text}|{image}] }, { toc:true } for a contents page, or null to
  // fall back to the generic on-page extractor.
  function normalizeAdapter(res) {
    if (!res || !Array.isArray(res.blocks)) return null;
    const items = [];
    for (const b of res.blocks) {
      if (b.type === "text" && b.text) items.push({ text: b.text });
      else if (b.type === "image" && b.url) items.push({ image: b.url });
    }
    if (!items.length) return null;
    return { title: (res.title || "").replace(/^#\s*/, "").trim(), items };
  }
  // Also loads the chapter list (getMeta) to find the current chapter's position, so
  // the reader can offer Prev/Next. `targetUrl` lets Prev/Next fetch a sibling chapter
  // without navigating the page. Adds content.nav = { prevUrl, nextUrl }.
  async function getAdapterContent(targetUrl) {
    const url = targetUrl || location.href;
    if (W.adapterUrl === url && W.adapterContent !== undefined) return W.adapterContent;
    W.adapterUrl = url;
    let content = null;
    try {
      globalThis.__WR_TX_VIA_SW = true; // adapters translate via the service worker
      const reg = await import(chrome.runtime.getURL("adapters/registry.js"));
      const adapter = reg.pickAdapter(url);
      if (!adapter || adapter.id === "generic") { W.adapterContent = null; return null; }
      const lang = CFG.targetLang || "en";
      let meta = null, curIndex = -1, chapter = null;
      if (adapter.id === "kakuyomu") {
        const em = /\/episodes\/(\d+)/.exec(url);
        if (!em) { W.adapterContent = { toc: true }; return W.adapterContent; }
        const wm = /\/works\/(\d+)/.exec(url);
        if (wm) { try { meta = await adapter.getMeta(`https://kakuyomu.jp/works/${wm[1]}`); } catch (_) {} }
        if (meta) curIndex = meta.chapters.findIndex((c) => String(c.id) === em[1] || (c.url || "").includes("/episodes/" + em[1]));
        chapter = curIndex >= 0 ? meta.chapters[curIndex] : { url, no: "", epTitle: "", title: "" };
        content = normalizeAdapter(await adapter.getChapter(chapter, { service: lang === "ja" ? "raw" : "en", lang }));
      } else if (adapter.id === "wtrlab") {
        const cm = /\/chapter-(\d+)/i.exec(url);
        if (!cm) { W.adapterContent = { toc: true }; return W.adapterContent; }
        // Strip the chapter segment (and wtr-lab's legacy "/old/" variant) to get the
        // novel page getMeta needs; otherwise ".../trial/old/chapter-2" would leave
        // ".../trial/old", getMeta would fail, and Reader-mode Prev/Next would be dead.
        const novelUrl = url.replace(/\/(?:old\/)?chapter-\d+\/?(?:[?#].*)?$/i, "");
        meta = await adapter.getMeta(novelUrl);      // sets the adapter's internal state
        const no = +cm[1];
        curIndex = meta.chapters.findIndex((c) => c.no === no);
        chapter = curIndex >= 0 ? meta.chapters[curIndex] : { no };
        // Match whatever tab the reader is on (?service=web|webplus|ai) so the overlay
        // text matches the page; default to Web+ when unspecified.
        let svc = "webplus";
        try { const p = (new URL(url).searchParams.get("service") || "").toLowerCase(); if (p === "web" || p === "ai") svc = p; } catch (_) {}
        content = normalizeAdapter(await adapter.getChapter(chapter, { service: svc, lang }));
      }
      if (content && meta && curIndex >= 0) {
        content.nav = {
          prevUrl: curIndex > 0 ? meta.chapters[curIndex - 1].url : null,
          nextUrl: curIndex < meta.chapters.length - 1 ? meta.chapters[curIndex + 1].url : null,
        };
      }
    } catch (e) {
      console.warn("[WebReader] adapter path failed — using generic extractor", e);
      content = null;
    }
    W.adapterContent = content;
    return content;
  }
  // Load a sibling chapter (from Prev/Next) into the open reader overlay.
  async function gotoChapter(url, autoplay) {
    if (!url) return;
    setStatus("Loading…");
    const c = await getAdapterContent(url);
    if (!c || c.toc || !c.items || !c.items.length) { setStatus("Couldn't load that chapter."); return; }
    buildOverlay(c.title || document.title, c.items, c.nav);
    if (autoplay) speakFrom(0);
  }

  // Site-specific in-place paragraph blocks (already-translated prose on the real page).
  // wtr-lab renders each line as <div class="wtr-line"> inside <div class="chapter-body">;
  // its infinite-scroll reader loads several chapters at once, in document = chapter order.
  // Returns [] on sites we don't recognise (→ the generic collector is used instead).
  function collectSiteBlocks() {
    const lines = document.querySelectorAll(".chapter-body .wtr-line, .wtr-line.pr-line-text");
    if (!lines.length) return [];
    const out = [], seen = new Set();
    lines.forEach((n) => {
      if (seen.has(n) || n.closest("#wr-root")) return;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      seen.add(n); out.push({ el: n, text: t });
    });
    return out;
  }
  // Start from the first paragraph at/after the current scroll position, so Read aloud
  // begins on the chapter you're actually looking at (infinite-scroll pages hold several).
  function firstVisibleBlock(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i] && blocks[i].el; if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > 60 && r.top < (window.innerHeight || 800)) return i;
    }
    return 0;
  }

  // Readable blocks for the CURRENT page, robust to any site: the known site fast-path
  // first, then the generic prose collector, then a last-resort split of the content
  // container's text. Reads whatever is on the page AS-IS (already-translated pages like
  // wtr-lab's English reader are read directly — no needless re-translation).
  function pageReadableBlocks() {
    let blocks = collectSiteBlocks();
    if (blocks.length) return blocks;
    const root = pickContent();
    blocks = collectBlocks(root)
      .map((b) => ({ el: b.el, text: (b.el.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter((b) => b.text);
    if (blocks.length) return blocks;
    // last resort: no recognisable block elements — split the container's text so Read
    // aloud / Reader mode still work (per-paragraph highlight just won't be available).
    const raw = ((root && root.innerText) || "").split(/\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 1);
    return raw.map((text) => ({ el: null, text }));
  }

  // ---- Read aloud: reads the live page IN PLACE, highlighting each paragraph on the real
  // page and following along. (Reader mode is the button that opens the clean overlay.) ----
  async function startReadAloud() {
    stopTts();
    // Read the page exactly as shown (in place, with on-page highlight). No forced
    // translation — if you want it translated, hit "Translate page" first.
    const blocks = pageReadableBlocks();
    if (!blocks.length) { setStatus("No readable text found on this page."); return; }
    W.blocks = blocks; W.ttsHost = "page"; W.chunks = [];
    W.blocks.forEach((b) => b.el && b.el.classList.add("wr-readable")); // cursor hint: click to read from here
    const bar = W.panel.querySelector('[data-tts="panel"]');
    if (bar && !bar.dataset.wired) { bar.innerHTML = ttsBarHtml(); wireTtsBar(bar); bar.dataset.wired = "1"; }
    if (bar) bar.classList.remove("wr-hidden");
    setStatus("Reading aloud… click any paragraph to jump there, or ■ to stop.");
    speakFrom(firstVisibleBlock(W.blocks));
  }

  // ================================================================= reader overlay
  async function openReaderOverlay() {
    setStatus("Loading…");
    let adapted = null;
    try { adapted = await getAdapterContent(); } catch (e) { console.warn("[WebReader] adapter failed", e); adapted = null; }
    if (adapted && adapted.toc) { setStatus("This is a contents page — open a chapter/episode to read it."); return; }
    if (adapted && adapted.items && adapted.items.length) { buildOverlay(adapted.title || document.title, adapted.items, adapted.nav); return; }
    // Fallback (adapter unavailable / unrecognised site): build the clean overlay from the
    // page's visible content as-is — no forced translation, so it can't hang or stay blank.
    const src = pageReadableBlocks();
    if (!src.length) { setStatus("No readable text to show in the reader."); return; }
    const title = (document.querySelector("h1, h2") || {}).textContent || document.title || "Reading";
    buildOverlay(title, src.map((b) => ({ text: b.text })));
  }

  // Render a clean reading overlay from items ([{text}|{image}]) and start the reader.
  // nav = { prevUrl, nextUrl } enables the Prev/Next chapter buttons (adapter sites).
  function buildOverlay(title, items, nav) {
    W.overlayNav = nav || null;
    if (W.overlay) W.overlay.remove();
    const ov = el("div", "wr-overlay");
    ov.innerHTML = `
      <div class="wr-ov-bar">
        <span class="wr-ov-title"></span>
        <span class="wr-head-btns">
          <button class="wr-btn wr-sm" data-ov="prev" title="Previous chapter">← Prev</button>
          <button class="wr-btn wr-sm" data-ov="next" title="Next chapter">Next →</button>
          <button class="wr-icon" data-ov="display" title="Display settings (font, size, theme)">Aa</button>
          <button class="wr-icon" data-ov="close" title="Close reader">✕</button>
        </span>
      </div>
      <div class="wr-ov-scroll"><article class="wr-ov-content"></article></div>
      <div class="wr-tts wr-ov-tts"></div>`;
    ov.querySelector(".wr-ov-title").textContent = (title || "Reading").replace(/\s+/g, " ").trim().slice(0, 120);
    const content = ov.querySelector(".wr-ov-content");
    const ovBlocks = []; // text paragraphs only (what the TTS steps through)
    // Read the chapter title first (unless the first item already is it).
    const tt = (title || "").replace(/\s+/g, " ").trim();
    const firstText = items[0] && items[0].text ? items[0].text.replace(/\s+/g, " ").trim() : "";
    if (tt && firstText !== tt) {
      const h = el("h2", "wr-ov-chaptitle"); h.textContent = tt;
      content.appendChild(h);
      ovBlocks.push({ el: h, text: tt });
    }
    for (const it of items) {
      if (it.image) { const img = el("img", "wr-ov-img"); img.src = it.image; img.alt = ""; content.appendChild(img); continue; }
      const p = el("p", "wr-ov-p"); p.textContent = it.text || "";
      if (!p.textContent.trim()) continue;
      content.appendChild(p);
      ovBlocks.push({ el: p, text: p.textContent });
    }
    W.root.appendChild(ov);
    W.overlay = ov;

    ov.querySelector('[data-ov="close"]').addEventListener("click", closeReaderOverlay);
    ov.querySelector('[data-ov="display"]').addEventListener("click", toggleOvDisplay);
    buildOvDisplay(ov);
    if (CFG.ovImportedFont && CFG.ovImportedFont.name && CFG.ovImportedFont.dataUrl) registerOvFont(CFG.ovImportedFont.name, CFG.ovImportedFont.dataUrl).then(applyOverlayDisplay);
    applyOverlayDisplay();
    const prevBtn = ov.querySelector('[data-ov="prev"]'), nextBtn = ov.querySelector('[data-ov="next"]');
    prevBtn.disabled = !(nav && nav.prevUrl); prevBtn.addEventListener("click", () => gotoChapter(nav && nav.prevUrl, W.speaking));
    nextBtn.disabled = !(nav && nav.nextUrl); nextBtn.addEventListener("click", () => gotoChapter(nav && nav.nextUrl, W.speaking));
    const bar = ov.querySelector(".wr-ov-tts");
    bar.innerHTML = ttsBarHtml(); wireTtsBar(bar);
    content.addEventListener("click", (e) => {
      const p = e.target.closest(".wr-ov-p"); if (!p) return;
      const i = ovBlocks.findIndex((x) => x.el === p); if (i >= 0) speakFrom(i);
    });

    stopTts();
    W.blocks = ovBlocks; W.ttsHost = "overlay"; W.chunks = [];
    ov.querySelector(".wr-ov-scroll").scrollTop = 0;
    togglePanel(false);
    setStatus("");
  }
  function closeReaderOverlay() {
    stopTts();
    if (W.overlay) { W.overlay.remove(); W.overlay = null; }
    // rebind read-aloud to the live page next time
    W.blocks = []; W.ttsHost = "page"; W.chunks = []; W.overlayNav = null;
  }
  // End of a chapter's TTS: auto-advance to the next chapter in the reader, else stop.
  function onReadFinished() {
    if (CFG.autoNext !== false && W.ttsHost === "overlay" && W.overlayNav && W.overlayNav.nextUrl) { gotoChapter(W.overlayNav.nextUrl, true); }
    else { stopTts(); setStatus("Finished reading."); }
  }

  // ================================================================= open in extension reader
  function openInExtensionReader() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_IN_READER", url: location.href }, () => void chrome.runtime.lastError);
      setStatus("Opening in the extension reader…");
    } catch (e) { setStatus("Couldn't open the reader."); }
  }

  // ================================================================= lifecycle
  function destroy() {
    stopTts();
    if (W.overlay) { W.overlay.remove(); W.overlay = null; }
    if (W.root) { W.root.remove(); W.root = null; }
    W.mini = W.panel = W.statusEl = null;
    W.translated = false; W.blocks = [];
  }

  let lastHref = location.href;
  function watchSpaNav() {
    if (W._spaTimer) return;
    W._spaTimer = setInterval(() => {
      // Re-assert the widget if the page (SPA re-render / hydration) removed our root.
      if (CFG.enabled) {
        if (!W.root) { build(); if (W.synth) loadVoices(); }
        else if (!document.documentElement.contains(W.root)) { document.documentElement.appendChild(W.root); }
      }
      if (location.href === lastHref) return;
      lastHref = location.href;
      // page changed (SPA): reset translation + adapter cache, optionally re-translate
      W.translated = false; W.showingOriginal = false; W.blocks = []; W.txNodes = [];
      W.adapterUrl = null; W.adapterContent = undefined;
      loadGlossary(); // the novel (and thus its glossary) may have changed
      const orig = W.panel && W.panel.querySelector('[data-act="original"]');
      if (orig) { orig.disabled = true; orig.textContent = "Show original"; }
      if (CFG.autoTranslate) setTimeout(() => translatePage(), 800);
    }, 1200);
  }

  async function init() {
    await loadCfg();
    loadGlossary();
    if (!CFG.enabled) { watchEnableFlag(); return; }
    build();
    if (W.synth) { loadVoices(); W.synth.onvoiceschanged = loadVoices; }
    watchSpaNav();
    watchEnableFlag();
    if (CFG.autoTranslate) setTimeout(() => translatePage(), 600);
  }

  // React to the extension tab enabling/disabling the widget without a reload.
  function watchEnableFlag() {
    if (W._watchingFlag || !chrome.storage || !chrome.storage.onChanged) return;
    W._watchingFlag = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.glossaries) loadGlossary(); // keep term-lock in sync with the editor
      if (!changes.webWidget) return;
      const nv = changes.webWidget.newValue || {};
      const wasEnabled = CFG.enabled;
      Object.assign(CFG, nv);
      if (CFG.enabled && !wasEnabled && !W.root) {
        build();
        if (W.synth) { loadVoices(); W.synth.onvoiceschanged = loadVoices; }
        watchSpaNav();
      } else if (!CFG.enabled && wasEnabled) {
        destroy();
      }
    });
  }

  init();
})();
