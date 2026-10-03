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

  // After the extension is reloaded/updated, THIS content script keeps running in tabs that
  // were already open, but its chrome.runtime handle is torn down — every chrome.* call then
  // throws "Extension context invalidated" (or "Cannot read properties of undefined (reading
  // 'sendMessage' / 'getURL')"). We check this before any such call and tell the user to
  // reload, instead of spilling errors and half-working. A fresh page load has a live context.
  function extAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  const RELOAD_MSG = "Extension was updated — reload this page to use the Web Reader.";

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
    if (!store || !extAlive()) return;
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
  const CFG = { enabled: true, autoTranslate: true, targetLang: "en", rate: 1, sentPause: 250, voiceName: "", follow: true, highlight: true, readSymbols: true, autoNext: true, bgPlay: true, mediaNotif: true, pos: null, ttsCollapsed: false,
    // Page zoom: unlockZoom re-enables native pinch-zoom on sites that block it; zoomByHost is
    // a remembered CSS-zoom factor per hostname (set from the widget's Zoom control).
    unlockZoom: true, zoomByHost: {},
    // Sites where the user pressed ✕ ("turn off on this site"): { hostname: true }. The widget
    // still runs page-zoom/pinch-unlock there, but never mounts its UI. Re-enable from the popup.
    offHosts: {},
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

  // ---------- page zoom / pinch-zoom unlock ----------
  // Many reader/manga sites ship <meta name="viewport" content="...user-scalable=no,
  // maximum-scale=1">, which disables the browser's native pinch-to-zoom so oversized images
  // can't be shrunk. We rewrite that meta to permit scaling again. We ONLY edit an existing
  // viewport meta (never create one — adding width=device-width to a desktop site would reflow
  // it), and only write when it actually needs changing, so the periodic re-apply is a no-op on
  // steady pages.
  function unlockViewport() {
    if (CFG.unlockZoom === false) return;
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    const cur = m.getAttribute("content") || "";
    let parts = cur.split(",").map((s) => s.trim()).filter(Boolean)
      .filter((p) => !/^user-scalable\s*=/i.test(p) && !/^maximum-scale\s*=/i.test(p) && !/^minimum-scale\s*=/i.test(p));
    parts.push("user-scalable=yes", "maximum-scale=5", "minimum-scale=0.25");
    const next = parts.join(", ");
    if (next !== cur) m.setAttribute("content", next);
  }

  const zoomHost = () => { try { return location.hostname || ""; } catch (_) { return ""; } };
  // The user turned the widget off on this site via ✕ (page-zoom/pinch still run; only the UI hides).
  const hostOff = () => !!(CFG.offHosts && CFG.offHosts[zoomHost()]);
  const getZoom = () => {
    const z = CFG.zoomByHost && CFG.zoomByHost[zoomHost()];
    return (typeof z === "number" && isFinite(z) && z > 0) ? z : 1;
  };
  // Page zoom works by constraining <body>'s width to z×100vw and centering it — NOT with CSS
  // `zoom`. CSS `zoom` is a no-op on full-width / mobile pages (the body just re-fills the
  // viewport and full-width images re-fill the body, so nothing shrinks — this is why zoom-out
  // did nothing on comic sites like asurascans on the tablet). Constraining the width instead:
  //   • zoom-out (z<1): body shrinks and `margin: auto` centers it → equal side margins, like
  //     a webtoon column in the middle of the screen; images inside shrink with it.
  //   • zoom-in (z>1): body grows past the viewport → pan by scrolling.
  // It reflows the page (correct scroll height), so long webtoons don't get a huge blank
  // scroll area the way a `transform: scale()` would. We override the site's own width rules
  // with !important. The widget/reader overlay live under <html> (outside <body>) so they're
  // never scaled. A data-attr marks that WE own these props, so z===1 only clears our own.
  const ZOOM_PROPS = ["width", "max-width", "min-width", "margin-left", "margin-right", "box-sizing"];
  function applyZoom() {
    const b = document.body; if (!b) return;
    const z = getZoom();
    b.style.removeProperty("zoom"); // clear any legacy CSS-zoom left by older versions
    if (z === 1) {
      if (b.dataset.wrZoom != null) { for (const k of ZOOM_PROPS) b.style.removeProperty(k); delete b.dataset.wrZoom; }
      updateZoomLabel();
      return;
    }
    b.style.setProperty("width", (z * 100) + "vw", "important");
    b.style.setProperty("max-width", "none", "important");
    b.style.setProperty("min-width", "0", "important");
    b.style.setProperty("margin-left", "auto", "important");
    b.style.setProperty("margin-right", "auto", "important");
    b.style.setProperty("box-sizing", "border-box", "important");
    b.dataset.wrZoom = String(z);
    updateZoomLabel();
  }
  function setZoom(z) {
    z = Math.min(2, Math.max(0.4, Math.round(z * 100) / 100));
    CFG.zoomByHost = CFG.zoomByHost || {};
    if (z === 1) delete CFG.zoomByHost[zoomHost()]; else CFG.zoomByHost[zoomHost()] = z;
    saveCfg();
    applyZoom();
  }
  function updateZoomLabel() {
    const el = W.panel && W.panel.querySelector('[data-zoom="val"]');
    if (el) el.textContent = Math.round(getZoom() * 100) + "%";
  }
  // Keep viewport + zoom applied through SPA re-renders / late meta injection. Idempotent, so
  // this cheap tick runs even when the widget UI is disabled.
  function startZoomWatch() {
    if (W._zoomTimer) return;
    W._zoomTimer = setInterval(() => { try { unlockViewport(); applyZoom(); } catch (_) {} }, 2000);
  }

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
      <button class="wr-mini-btn wr-mini-dl" title="Download this chapter as EPUB">⬇</button>
      <button class="wr-mini-btn wr-mini-open" title="Open Web Reader">🌐</button>`;

    // expanded panel
    const panel = el("div", "wr-panel wr-hidden");
    panel.innerHTML = `
      <div class="wr-head">
        <span class="wr-brand">🌐 Web Reader</span>
        <span class="wr-head-btns">
          <button class="wr-icon" data-act="collapse" title="Collapse to bubble">–</button>
          <button class="wr-icon" data-act="close" title="Turn off on this site">✕</button>
        </span>
      </div>
      <div class="wr-actions">
        <button class="wr-btn wr-primary" data-act="translate">🌐 Translate page</button>
        <button class="wr-btn" data-act="original" disabled>Show original</button>
        <button class="wr-btn" data-act="read">🔊 Read aloud</button>
        <button class="wr-btn" data-act="reader">📖 Reader mode</button>
        <button class="wr-btn" data-act="openreader">📖 Open in Reader</button>
        <button class="wr-btn" data-act="openext">📘 Novel to EPUB</button>
      </div>
      <div class="wr-settings">
        <label class="wr-field">Translate to
          <select class="wr-sel" data-act="lang"></select>
        </label>
        <label class="wr-check"><input type="checkbox" data-act="auto"> <span>Auto-translate new chapters</span></label>
        <div class="wr-zoom">
          <span class="wr-zoom-label">Page zoom</span>
          <button class="wr-btn wr-zoom-btn" data-act="zoom-out" title="Smaller">−</button>
          <span class="wr-zoom-val" data-zoom="val">100%</span>
          <button class="wr-btn wr-zoom-btn" data-act="zoom-in" title="Larger">+</button>
          <button class="wr-btn wr-zoom-btn" data-act="zoom-reset" title="Reset to 100%">⟲</button>
        </div>
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
    mini.querySelector('.wr-mini-dl').addEventListener("click", (e) => { if (!W._dragged) downloadCurrentChapter(); });
    mini.querySelector('.wr-mini-open').addEventListener("click", (e) => { if (!W._dragged) togglePanel(true); });
    panel.addEventListener("click", onPanelClick);
    sel.addEventListener("change", (e) => { CFG.targetLang = e.target.value; saveCfg(); });
    panel.querySelector('[data-act="auto"]').addEventListener("change", (e) => { CFG.autoTranslate = e.target.checked; saveCfg(); });
    // Click a paragraph on the live page to read aloud from there (in-place mode).
    if (!W._pageClickBound) { document.addEventListener("click", onPageClickToRead, true); W._pageClickBound = true; }

    // Android's system TTS is a single shared engine: a backgrounded tab that keeps
    // speaking interleaves its paragraphs with the tab you're now reading. So when this
    // tab is hidden, stop it (cancel is reliable on Android; pause often isn't) and
    // remember where it was; resume from there when the tab is shown again.
    if (!W._visBound) {
      document.addEventListener("visibilitychange", () => {
        // With background playback OFF: stop speaking when hidden (avoids Android's shared TTS
        // engine interleaving paragraphs across tabs); position is kept (W.blockIdx) so pressing
        // Play continues from there, and we never auto-resume (that blasts audio on tab-switch).
        // With background playback ON (CFG.bgPlay, the default): keep going — the silent keep-alive
        // audio holds the tab alive so reading continues with the screen off / tab hidden.
        if (document.hidden && W.speaking && CFG.bgPlay === false) stopTts();
      });
      W._visBound = true;
    }

    // Build the TTS controls (voice/speed/gap + tick options) up front so they're
    // always visible — not only after Read aloud starts.
    const pbar = panel.querySelector('[data-tts="panel"]');
    if (pbar) { pbar.innerHTML = ttsBarHtml(); wireTtsBar(pbar); pbar.dataset.wired = "1"; pbar.classList.remove("wr-hidden"); }

    initDrag(mini);
    // The expanded panel is draggable by its header too (the header already shows a move
    // cursor). initDrag ignores clicks on buttons, so Collapse/Close still work.
    const head = panel.querySelector(".wr-head");
    if (head) initDrag(head);
    applyPos();
    // Keep the widget on-screen when the viewport changes (resize / device rotate).
    if (!W._resizeBound) { window.addEventListener("resize", clampIntoView); W._resizeBound = true; }
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

  // Position model: the widget is pinned by whichever CORNER the mini pill is nearest, not by a
  // fixed top-left. CFG.pos = { ax:'left'|'right', ay:'top'|'bottom', x, y } where x/y are the
  // distances from the anchored edges. This makes the expanded panel grow INWARD from the mini's
  // corner (so it opens where the mini is and never runs off that edge), and — because the mini
  // and panel share the same corner — collapsing returns the mini to exactly where it was.
  // null = use the CSS default (bottom-right 18px). Legacy {left,top} saves migrate on first use.
  const EDGE = 8;
  function migratePos() {
    // Convert an old {left,top} save into an anchor once the mini has a measured size.
    if (CFG.pos && typeof CFG.pos.left === "number" && !CFG.pos.ax && W.mini) {
      const w = W.mini.offsetWidth || 180, h = W.mini.offsetHeight || 44;
      saveAnchorFromRect({ left: CFG.pos.left, top: CFG.pos.top, right: CFG.pos.left + w, bottom: CFG.pos.top + h, width: w, height: h });
      saveCfg();
    }
  }
  function applyPos() {
    if (!W.root) return;
    migratePos();
    const a = CFG.pos;
    if (!a || !a.ax) return; // keep the CSS default (right/bottom: 18px)
    pinCorner(a.ax, a.ay, a.x, a.y);
  }
  // Pin W.root by the given corner at (x,y) from those edges; free the opposite sides.
  function pinCorner(ax, ay, x, y) {
    const s = W.root.style;
    if (ax === "left") { s.left = x + "px"; s.right = "auto"; } else { s.right = x + "px"; s.left = "auto"; }
    if (ay === "top") { s.top = y + "px"; s.bottom = "auto"; } else { s.bottom = y + "px"; s.top = "auto"; }
  }
  // Choose the nearest corner from an element's viewport rect and store it as CFG.pos, clamped so
  // the element stays on-screen. Used on drag-end and when migrating a legacy position. The pure
  // math lives in adapters/layout.js (WRLayout) so it can be unit-tested; this only touches DOM.
  function saveAnchorFromRect(rect) {
    CFG.pos = WRLayout.cornerAnchor(rect, window.innerWidth, window.innerHeight, EDGE);
  }
  // Place the expanded panel at the mini's corner, but clamp the offset to the panel's own size so
  // the larger box stays fully on-screen — WITHOUT changing CFG.pos, so the mini's saved spot (and
  // where it returns to on collapse) is untouched.
  function applyPanelPos() {
    if (!W.root || !W.panel) return;
    const a = CFG.pos;
    if (!a || !a.ax) return; // default bottom-right corner already grows inward
    const w = W.panel.offsetWidth || 300, h = W.panel.offsetHeight || 300;
    const c = WRLayout.clampCorner(a.x, a.y, w, h, window.innerWidth, window.innerHeight, EDGE);
    pinCorner(a.ax, a.ay, c.x, c.y);
  }
  // Keep the currently shown element on-screen (used for live drag, where the mini/panel is moved
  // by raw left/top). Uses the live rendered size and pins to a margin if it's bigger than the view.
  function clampXY(left, top) {
    const rw = (W.root && W.root.offsetWidth) || 60;
    const rh = (W.root && W.root.offsetHeight) || 60;
    return WRLayout.clampXY(left, top, rw, rh, window.innerWidth, window.innerHeight, EDGE);
  }
  // Re-assert position when the viewport changes (resize / rotate): the panel if it's open, else
  // the mini, both from the stored corner.
  function clampIntoView() {
    if (!W.root || !CFG.pos || !CFG.pos.ax) return;
    if (W.panel && !W.panel.classList.contains("wr-hidden")) applyPanelPos(); else applyPos();
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
      const { left: nx, top: ny } = clampXY(ox + dx, oy + dy);
      W.root.style.left = nx + "px"; W.root.style.top = ny + "px";
      W.root.style.right = "auto"; W.root.style.bottom = "auto";
    });
    const end = (e) => {
      if (!drag) return; drag = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        // Convert the dragged position into a corner anchor from whatever is on screen (mini or
        // panel). Both pin by the same corner, so the pair stays co-located across expand/collapse.
        saveAnchorFromRect(W.root.getBoundingClientRect());
        applyPos();
        W._dragged = true; saveCfg(); setTimeout(() => (W._dragged = false), 0);
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function togglePanel(show) {
    if (!W.panel) return;
    const open = show != null ? show : W.panel.classList.contains("wr-hidden");
    W.panel.classList.toggle("wr-hidden", !open);
    W.mini.classList.toggle("wr-hidden", open);
    // Expanding: place the panel at the mini's corner and grow inward (clamped to fit) — it opens
    // where the mini is. Collapsing: restore the mini to its own saved corner.
    if (open) { updateZoomLabel(); applyPanelPos(); } else { applyPos(); }
  }

  function setStatus(t) { if (W.statusEl) W.statusEl.textContent = t; }

  function onPanelClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "collapse") return togglePanel(false); // – : just collapse to the mini bubble
    if (act === "close") { // ✕ : turn the widget off for this site (re-enable from the popup)
      CFG.offHosts = CFG.offHosts || {}; CFG.offHosts[zoomHost()] = true; saveCfg();
      destroy();
      return;
    }
    // Page zoom is a local DOM/storage operation — works even on a stale tab, so handle it
    // before the extension-context gate below.
    if (act === "zoom-in") return setZoom(getZoom() + 0.1);
    if (act === "zoom-out") return setZoom(getZoom() - 0.1);
    if (act === "zoom-reset") return setZoom(1);
    if (!extAlive()) { setStatus(RELOAD_MSG); return; } // stale tab after an extension update
    if (act === "translate") return translatePage();
    if (act === "original") return toggleOriginal();
    if (act === "read") return startReadAloud("page");
    if (act === "reader") return openReaderOverlay();
    if (act === "openreader") return openInExtensionReader();
    if (act === "openext") return openExtensionPopup();
  }
  // Open the full Novel to EPUB extension (its Novel→EPUB tab, with this page pre-filled).
  function openExtensionPopup() {
    try { chrome.runtime.sendMessage({ type: "OPEN_POPUP", url: location.href }, () => void chrome.runtime.lastError); }
    catch (_) { setStatus(RELOAD_MSG); }
  }

  // ================================================================= content pick
  const BAD = /(^|\s|-|_)(nav|footer|header|comment|sidebar|menu|share|advert|ads?|related|recommend|breadcrumb|wr-root)(\s|$|-|_)/i;
  // Content wrappers that merely *borrow* a chrome word are not chrome. e.g. wtr-lab
  // wraps the chapter body in ".menu-target" (a right-click-menu target, not a menu);
  // matching it as a "menu" would hide the whole chapter from Read aloud / Reader mode.
  const NOT_BAD = /(^|\s|-|_)menu-target(\s|$)/i;
  // querySelectorAll that also descends into open shadow roots — some readers render
  // the chapter prose inside a shadow root (e.g. newtoki's .theme-novel-content), which
  // a plain querySelectorAll can't see, so Read aloud/Reader would only find the menu.
  function deepQueryAll(root, sel) {
    const out = [];
    const visit = (r) => {
      if (!r || !r.querySelectorAll) return;
      out.push(...r.querySelectorAll(sel));
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }
  function deepTextLen(el) {
    let n = (el.textContent || "").length;
    for (const h of (el.querySelectorAll ? el.querySelectorAll("*") : [])) if (h.shadowRoot) n += (h.shadowRoot.textContent || "").length;
    return n;
  }
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
      const ps = deepQueryAll(c, "p");
      let textLen = 0;
      ps.forEach((p) => (textLen += (p.textContent || "").trim().length));
      if (!ps.length) textLen = deepTextLen(c) * 0.2;
      const linkText = deepQueryAll(c, "a").reduce((n, a) => n + (a.textContent || "").length, 0);
      const total = deepTextLen(c) || 1;
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
    deepQueryAll(container, "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd").forEach(add);
    // Many readers (e.g. wtr-lab) render each paragraph as a <div>/<section>, not <p>.
    // If the tag scan found little prose, also collect "leaf" block containers — ones
    // whose text isn't split into child blocks — so those paragraphs get read too.
    if (out.length < 2) {
      deepQueryAll(container, "div, section, article").forEach((n) => {
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

  // Ordered reader items ([{text}|{image}]) from a container, piercing shadow roots and
  // keeping prose + inline images in document order — so Reader mode shows illustrations
  // too (e.g. newtoki renders images as <figure class="novel-inline-image"><img>).
  function collectItems(container) {
    const nodes = deepQueryAll(container, "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, img");
    const items = [], seen = new Set();
    for (const n of nodes) {
      if (n.closest && (n.closest("#wr-root") || n.closest(SKIP_SEL))) continue;
      if (n.tagName === "IMG") {
        const src = n.getAttribute("src") || n.getAttribute("data-src") || n.getAttribute("data-original");
        if (src && !/^data:image\/(gif|svg)/i.test(src)) { try { items.push({ image: new URL(src, location.href).href }); } catch (_) {} }
        continue;
      }
      if (n.querySelector && n.querySelector("p, h1, h2, h3, h4, h5, h6, li, blockquote, dd")) continue; // not a leaf block
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length >= 2 && !seen.has(t)) { seen.add(t); items.push({ text: t }); }
    }
    return items;
  }

  // ---- Download just the CURRENT chapter as a one-chapter EPUB ----
  // Uses whatever prose/images are shown on the page (so if you've translated it, the
  // EPUB is English). Title + filename are "Chapter N" when a number is detectable.
  function xesc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function sanitizeFile(s) { return String(s || "chapter").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "chapter"; }
  function mimeToExt(m) { m = (m || "").toLowerCase(); if (m.includes("png")) return "png"; if (m.includes("webp")) return "webp"; if (m.includes("gif")) return "gif"; if (m.includes("svg")) return "svg"; return "jpg"; }
  function currentChapterTitle() {
    // Prefer the clean "… Chapter N" the page shows in .page-desc.
    const pd = ((document.querySelector(".page-desc") || {}).textContent || "");
    let m = pd.match(/chapter\s*(\d+(?:\.\d+)?)/i);
    if (m) return "Chapter " + m[1];
    // Else pull a number from the chapter title (try selectors in PRIORITY order —
    // querySelector with a comma list returns document order, not selector order).
    let raw = "";
    for (const s of [".theme-novel-title", ".view-title", ".pg-title", ".view-content h1"]) {
      const e = document.querySelector(s); const t = e && (e.textContent || "").replace(/\s+/g, " ").trim();
      if (t) { raw = t; break; }
    }
    if (!raw) raw = (document.title || "").replace(/\s+/g, " ").trim();
    m = raw.match(/(\d+(?:\.\d+)?)\s*화/) || raw.match(/(?:episode|chapter|ep|ch)\s*[.#-]?\s*(\d+(?:\.\d+)?)/i);
    if (m) return "Chapter " + m[1];
    return raw.slice(0, 80) || "Chapter";
  }
  // The novel/series title (for the EPUB name), derived from the chapter heading with the
  // "- Episode N / N화" suffix stripped and a doubled title ("Foo Foo") collapsed.
  function currentNovelTitle() {
    let raw = ((document.querySelector(".theme-novel-title, .view-title") || {}).textContent || document.title || "").replace(/\s+/g, " ").trim();
    raw = raw.replace(/\s*[-–—]\s*(episode|chapter|ep|ch)\s*[.#-]?\s*\d+.*$/i, "")
             .replace(/\s*[-–—]?\s*\d+\s*화.*$/, "")
             .replace(/\s*[-–—]\s*(북토끼|뉴토끼|newtokki|booktoki)\s*(소설)?\s*$/i, "")
             .trim();
    const dup = raw.match(/^(.+?)\s+\1$/); if (dup) raw = dup[1].trim(); // "Foo Foo" -> "Foo"
    return raw.slice(0, 90);
  }
  // Build an EPUB chapter body from ordered items ([{text}|{image}]), fetching each image.
  // `prefix` namespaces image ids/names so a COMBINED book (many chapters) never collides.
  // Returns { xhtmlBody, images:[{id,name,data,mime}] }.
  async function buildChapterParts(items, prefix) {
    const pre = prefix || "";
    const parts = [], images = [];
    let imgN = 0;
    for (const it of items) {
      if (it.text) { parts.push(`<p>${xesc(it.text)}</p>`); continue; }
      if (it.image) {
        try {
          const r = await fetch(it.image, { credentials: "include" });
          if (!r.ok) continue;
          const buf = new Uint8Array(await r.arrayBuffer());
          if (!buf.length) continue;
          const mime = (r.headers.get("content-type") || "").split(";")[0] || "image/jpeg";
          imgN++;
          const name = `images/${pre}img${imgN}.${mimeToExt(mime)}`;
          images.push({ id: `${pre}img${imgN}`, name, data: buf, mime });
          parts.push(`<p><img src="${name}" alt=""/></p>`);
        } catch (_) { /* skip an image that won't load */ }
      }
    }
    return { xhtmlBody: parts.join("\n"), images };
  }
  // Save a blob via an in-page <a download>. This MUST be called synchronously inside a user
  // gesture (a tap) — mobile browsers (Quetta) only show their "where to save" prompt for a
  // gesture-initiated download, and silently drop downloads triggered from async/background code.
  // So we build files ahead of time and only call this from a Save-button tap handler.
  function saveBlob(blob, filename) {
    try {
      const a = el("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 20000);
      return true;
    } catch (_) { return false; }
  }
  // Present finished file(s) with a Save button; the tap handler saves synchronously so the
  // browser's download prompt actually appears. `pending` is normally a single file (a combined
  // EPUB, or a .zip of per-chapter EPUBs) so one tap = one download = one prompt.
  // Build the finished download(s) from collected chapter data. combined → one EPUB; individual →
  // one .zip of per-chapter EPUBs (one file = one gesture download, reliable on mobile).
  async function buildPending(dataArr, output, novel) {
    if (!dataArr || !dataArr.length) return [];
    dataArr = dataArr.slice().sort((a, b) => ((a.no != null ? a.no : a.seq) - (b.no != null ? b.no : b.seq))); // chapter order (retries append out of order)
    const { buildEpub, buildZip } = await import(chrome.runtime.getURL("epub.js"));
    const toImgs = (arr) => (arr || []).map((im) => (im.data ? im : { id: im.id, name: im.name, mime: im.mime, data: b64ToU8(im.b64) }));
    if (output === "combined") {
      const chapters = dataArr.map((c) => ({ title: c.title, xhtmlBody: c.xhtmlBody, srcUrl: c.srcUrl }));
      const images = dataArr.flatMap((c) => toImgs(c.images));
      return [{ blob: buildEpub({ title: novel, author: novel, lang: "en" }, chapters, images), filename: sanitizeFile(novel) + ".epub" }];
    }
    const entries = [];
    for (const c of dataArr) {
      const epubBlob = buildEpub({ title: (novel ? novel + " " : "") + c.title, author: novel, lang: "en" }, [{ title: c.title, xhtmlBody: c.xhtmlBody, srcUrl: c.srcUrl }], toImgs(c.images));
      entries.push({ name: sanitizeFile((novel ? novel + " " : "") + c.title) + ".epub", data: new Uint8Array(await epubBlob.arrayBuffer()) });
    }
    return [{ blob: new Blob([buildZip(entries)], { type: "application/zip" }), filename: sanitizeFile(novel) + " chapters.zip" }];
  }
  function readerLang() {
    return ((W.translated && !W.showingOriginal) || CFG.autoTranslate) ? "en" : (document.documentElement.getAttribute("lang") || "en");
  }
  // Translate the TEXT of scraped items directly (not the live DOM) — deterministic for the
  // bulk crawl, where mutating + re-reading the page was racing and leaving chapters untranslated.
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]); }
  async function translateItemsText(items) {
    const idxs = [], texts = [];
    items.forEach((it, i) => { if (it.text) { idxs.push(i); texts.push(it.text); } });
    if (!texts.length) return items;
    // CRITICAL for the bulk crawl: never let a translate call hang the crawl. requestTranslate
    // relies on a service-worker reply that can be lost (SW cold start / port dropped during the
    // rapid per-chapter navigations). Time-box it and retry once; on failure keep the original
    // text so the crawl still completes and the file is still produced.
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try { out = await withTimeout(requestTranslate(texts, CFG.targetLang || "en", "auto"), 30000); }
      catch (_) { out = null; }
    }
    if (!out) return items;
    const copy = items.map((x) => ({ ...x }));
    idxs.forEach((bi, k) => { if (out[k]) copy[bi].text = out[k]; });
    return copy;
  }
  async function downloadCurrentChapter() {
    try {
      setStatus("Preparing chapter…");
      const items = collectItems(pickContent());
      if (!items.length) { setStatus("No chapter text found to download."); return; }
      const chap = currentChapterTitle();                    // "Chapter N"
      const novel = currentNovelTitle();                     // "I Alone Sword Master"
      const title = (novel ? novel + " " : "") + chap;        // EPUB + filename name
      const { xhtmlBody, images } = await buildChapterParts(items, "");
      if (!xhtmlBody) { setStatus("No readable content to download."); return; }
      const meta = { title, author: novel || "", lang: readerLang() };
      const { buildEpub } = await import(chrome.runtime.getURL("epub.js"));
      const blob = buildEpub(meta, [{ title: chap, xhtmlBody, srcUrl: location.href }], images);
      saveBlob(blob, sanitizeFile(title) + ".epub");
      setStatus(`Downloaded “${title}”.`);
    } catch (e) {
      console.warn("[WebReader] chapter download failed", e);
      setStatus("⚠ " + ((e && e.message) || "Download failed."));
    }
  }

  // ================================================================= translation
  function requestTranslate(texts, to, from) {
    return new Promise((resolve, reject) => {
      if (!extAlive()) return reject(new Error(RELOAD_MSG));
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
  // A text node is translatable if it has letters and isn't ours / a skip tag / editable.
  function okTextNode(n) {
    const t = n.nodeValue;
    if (!t || !t.trim()) return false;
    const p = n.parentElement;
    if (!p || p.closest("#wr-root")) return false;
    if (TX_SKIP_TAGS.test(p.tagName)) return false;
    if (p.closest("[contenteditable=true], [translate=no], .notranslate")) return false;
    // Skip strings with no letters (pure numbers / punctuation / symbols).
    try { if (!/\p{L}/u.test(t)) return false; } catch (_) { /* older engines: accept */ }
    return true;
  }
  function collectTextNodes(root) {
    const nodes = [];
    // A TreeWalker can't cross shadow boundaries, so walk the host tree AND recurse
    // into every open shadow root. Some readers render the chapter prose inside a
    // shadow root (e.g. newtoki's .theme-novel-content), which a plain body walk
    // misses entirely — leaving the story untranslated while the menus turn English.
    const walkRoot = (r) => {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
        acceptNode(n) { return okTextNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; },
      });
      let n; while ((n = walker.nextNode())) nodes.push(n);
      if (r.querySelectorAll) for (const el of r.querySelectorAll("*")) if (el.shadowRoot) walkRoot(el.shadowRoot);
    };
    walkRoot(root);
    return nodes;
  }

  // Translate a set of text nodes in place and record them so "Show original" can undo it.
  // Skips nodes we've already handled; pauses the mutation observer around our own writes so
  // they don't loop back in as "new" nodes. Returns how many were newly translated.
  async function applyTranslationTo(nodes) {
    if (!W.txNodes) W.txNodes = [];
    if (!W.txSet) W.txSet = new Set();
    const fresh = nodes.filter((n) => n && n.isConnected && !W.txSet.has(n) && okTextNode(n));
    if (!fresh.length) return 0;
    // Preserve each node's leading/trailing whitespace; translate the trimmed core.
    const parts = fresh.map((node) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue) || ["", "", node.nodeValue, ""];
      return { node, lead: m[1], core: m[2], trail: m[3] };
    });
    const out = await requestTranslate(parts.map((p) => p.core), CFG.targetLang, "auto");
    if (W.txObserver) W.txObserver.disconnect(); // don't let our own edits retrigger us
    parts.forEach((p, i) => {
      const tr = out[i];
      if (tr == null) return;
      const trVal = p.lead + tr + p.trail;
      W.txNodes.push({ node: p.node, orig: p.node.nodeValue, tr: trVal });
      W.txSet.add(p.node);
      if (!W.showingOriginal) p.node.nodeValue = trVal;
    });
    if (W.txObserver && W.translated && !W.showingOriginal) reconnectTxObserver();
    return parts.length;
  }

  async function translatePage() {
    if (W.translating) return;
    if (!extAlive()) { setStatus(RELOAD_MSG); return; } // stale tab after an extension update
    if (W.translated && !W.showingOriginal) { setStatus("Page already translated."); return; }
    W.translating = true;
    setStatus("Translating…");
    try {
      const nodes = collectTextNodes(document.body);
      if (!nodes.length) { setStatus("No readable text found on this page."); return; }
      await applyTranslationTo(nodes);
      W.translated = true; W.showingOriginal = false;
      const orig = W.panel.querySelector('[data-act="original"]');
      if (orig) { orig.disabled = false; orig.textContent = "Show original"; }
      // Keep translating text that appears later — e.g. Kakuyomu's 目次 (table of contents)
      // drawer on mobile is rendered only when opened, so a one-shot pass misses it.
      startTxObserver();
      setStatus(`Translated ${W.txNodes.length} items → ${langName(CFG.targetLang)}.`);
    } catch (e) {
      console.warn("[WebReader] translate failed", e);
      setStatus("⚠ " + (e.message || "Translation failed."));
    } finally {
      W.translating = false;
    }
  }

  // Translate whatever UNTRANSLATED text is on the page right now, without the
  // "already translated" short-circuit. Needed because the on-load auto-translate often
  // runs before a reader's async prose (e.g. newtoki's shadow content) has rendered; that
  // first pass flips W.translated=true on just the menus, so a later translatePage() would
  // bail and leave the story in its original language. applyTranslationTo only touches nodes
  // it hasn't handled yet, so calling this repeatedly is cheap.
  async function translateNewNodes() {
    if (!extAlive() || W.showingOriginal) return 0;
    try {
      const n = await applyTranslationTo(collectTextNodes(document.body));
      if (n) { W.translated = true; startTxObserver(); const orig = W.panel && W.panel.querySelector('[data-act="original"]'); if (orig) { orig.disabled = false; orig.textContent = "Show original"; } }
      return n;
    } catch (e) { console.warn("[WebReader] translateNewNodes failed", e); return 0; }
  }

  // Watch for text added after the first pass (drawers, SPA chapter nav, lazy lists) and
  // translate it too. Debounced; guarded so our own writes never feed back in.
  function reconnectTxObserver() {
    if (W.txObserver) W.txObserver.observe(document.body, { childList: true, subtree: true });
  }
  function scheduleTxFlush() {
    if (W.txTimer) clearTimeout(W.txTimer);
    W.txTimer = setTimeout(async () => {
      W.txTimer = null;
      if (!W.translated || W.showingOriginal || !W.txPending || !W.txPending.size) { W.txPending && W.txPending.clear(); return; }
      // After an extension update the old content script's context is dead — every relay
      // rejects with the reload message. Stop watching for good rather than logging that on
      // every DOM mutation; the page must be reloaded to use the Web Reader again.
      if (!extAlive()) { stopTxObserver(); return; }
      const batch = Array.from(W.txPending); W.txPending.clear();
      try { await applyTranslationTo(batch); }
      catch (e) {
        if (e && String(e.message) === RELOAD_MSG) { stopTxObserver(); return; } // context died mid-flight
        console.warn("[WebReader] dynamic translate failed", e);
      }
    }, 400);
  }
  function startTxObserver() {
    if (!W.txPending) W.txPending = new Set();
    if (W.txObserver) { reconnectTxObserver(); return; }
    W.txObserver = new MutationObserver((muts) => {
      for (const mu of muts) {
        for (const node of mu.addedNodes) {
          if (node.nodeType === 3) { if (okTextNode(node)) W.txPending.add(node); }
          else if (node.nodeType === 1) {
            if (node.closest && node.closest("#wr-root")) continue;
            for (const tn of collectTextNodes(node)) W.txPending.add(tn);
          }
        }
      }
      if (W.txPending.size) scheduleTxFlush();
    });
    reconnectTxObserver();
  }
  function stopTxObserver() {
    if (W.txObserver) W.txObserver.disconnect();
    if (W.txTimer) { clearTimeout(W.txTimer); W.txTimer = null; }
    W.txPending && W.txPending.clear();
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
    // Don't translate newly-added text while the user is viewing the original.
    if (W.showingOriginal) stopTxObserver(); else if (W.translated) startTxObserver();
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
  // Our highlight/cursor CSS lives in the light DOM and can't style elements inside a
  // shadow root (style encapsulation). When any readable block lives in a shadow root
  // (e.g. newtoki's chapter prose), inject a tiny stylesheet into that root so the
  // wr-speaking / wr-readable classes we toggle on those elements are actually visible.
  function injectShadowHighlightCss(blocks) {
    const roots = new Set();
    for (const b of blocks || []) {
      const el = b && b.el;
      if (!el || !el.getRootNode) continue;
      const r = el.getRootNode();
      if (r && r.nodeType === 11 && r.host) roots.add(r); // a ShadowRoot
    }
    for (const r of roots) {
      try {
        if (r.querySelector && r.querySelector("#wr-shadow-hl")) continue;
        const st = document.createElement("style");
        st.id = "wr-shadow-hl";
        st.textContent = ".wr-speaking{background:var(--wr-speak,rgba(111,131,172,.28))!important;border-radius:4px;transition:background .2s;}.wr-readable{cursor:pointer;}";
        r.appendChild(st);
      } catch (_) {}
    }
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
      // Stale utterance after a stop (see readerview.js): a pre-buffered chunk that cancel()
      // didn't drop from the engine queue. If we've fully stopped, kill it the moment it starts
      // so it doesn't leak the next paragraph; if a newer speak is active, just ignore it (a
      // global cancel would kill the new speech).
      if (t !== W.token) { if (!W.speaking) { try { W.synth.cancel(); } catch (_) {} } return; }
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
      // Resume. speechSynthesis.pause()/resume() is unreliable (Android's shared engine and
      // remote/Google voices often won't resume and drop the utterance), so restart from the
      // current paragraph — the same reliable path a paragraph-click takes.
      W.paused = false;
      speakFrom(W.blockIdx);
      return; // speakFrom refreshes the play buttons
    } else {
      W.paused = true;
      try { W.synth.pause(); } catch (_) {}
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

  // ---- Background playback + lock-screen / notification controls (Media Session) ----
  // speechSynthesis isn't "media", so on its own Chrome shows no notification and FREEZES a
  // backgrounded tab (screen off → speech dies). Playing a silent, looping <audio> at full
  // volume gives the page audio focus: that both surfaces the OS media controls (notification +
  // lock screen on Android) AND keeps the tab alive so speech keeps going with the screen off.
  // The WAV is a ~40 Hz tone at amplitude 4 — non-zero so Chrome counts it as *audible* media
  // (pure digital silence is treated as silent and the notification is suppressed), but far too
  // quiet/low to actually hear. All of this is gated on CFG.bgPlay.
  const WR_SILENCE = "data:audio/wav;base64,UklGRmQfAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAfAACAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgICAgICAgICAgIGBgYGBgYGBgoKCgoKCgoKCgoODg4ODg4ODg4ODg4ODg4ODg4ODg4ODhIODg4ODg4ODg4ODg4ODg4ODg4ODg4ODgoKCgoKCgoKCgoGBgYGBgYGBgICAgICAgICAgICAgICAgIB/f39/f39/f35+fn5+fn5+fn59fX19fX19fX19fX19fX19fX19fX19fXx9fX19fX19fX19fX19fX19fX19fX19fX5+fn5+fn5+fn5/f39/f39/f4CAgICAgICAgICAgICAgICAgYGBgYGBgYGCgoKCgoKCgoKCg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OEg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4OCgoKCgoKCgoKCgYGBgYGBgYGAgICAgICAgICAgICAgICAgH9/f39/f39/fn5+fn5+fn5+fn19fX19fX19fX19fX19fX19fX19fX19fH19fX19fX19fX19fX19fX19fX19fX19fn5+fn5+fn5+fn9/f39/f39/gICAgICAgICAgICAgICAgICBgYGBgYGBgYKCgoKCgoKCgoKDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4SDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4KCgoKCgoKCgoKBgYGBgYGBgYCAgICAgICAgICAgICAgICAf39/f39/f39+fn5+fn5+fn5+fX19fX19fX19fX19fX19fX19fX19fX18fX19fX19fX19fX19fX19fX19fX19fX1+fn5+fn5+fn5+f39/f39/f3+AgICAgICAgA==";
  function mediaKeepAlive(on) {
    try {
      if (on) {
        if (!W.ka) { W.ka = new Audio(WR_SILENCE); W.ka.loop = true; W.ka.volume = 1; }
        const p = W.ka.play(); if (p && p.catch) p.catch(() => {}); // autoplay may reject off-gesture
      } else if (W.ka) { W.ka.pause(); }
    } catch (_) {}
  }
  function mediaState(state) { // "playing" | "paused" | "none"
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state; } catch (_) {}
  }
  function mediaMeta() {
    try {
      if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
      let icon = null;
      try { icon = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/icon128.png") : null; } catch (_) {}
      // Prefer the reader's chapter/novel title; fall back to the page title.
      let title = "", artist = location.hostname;
      try { if (W.ttsHost === "overlay") { title = currentChapterTitle(); artist = currentNovelTitle() || location.hostname; } } catch (_) {}
      if (!title) title = (document.title || "Web Reader").trim();
      navigator.mediaSession.metadata = new MediaMetadata({
        title: String(title).slice(0, 140),
        artist: String(artist).slice(0, 120),
        album: "Web Reader",
        artwork: icon ? [{ src: icon, sizes: "128x128", type: "image/png" }] : [],
      });
    } catch (_) {}
  }
  function mediaSetup() {
    try {
      if (!("mediaSession" in navigator) || W._msWired) return;
      const ms = navigator.mediaSession;
      const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (_) {} };
      set("play", () => { if (!W.speaking || W.paused) togglePlay(); });
      set("pause", () => { if (W.speaking && !W.paused) togglePlay(); });
      set("previoustrack", () => stepLine(-1));
      set("nexttrack", () => stepLine(1));
      set("stop", () => { stopTts(); setStatus("Stopped."); });
      W._msWired = true;
    } catch (_) {}
  }
  // Keep the keep-alive audio + OS media controls in lock-step with TTS state. Called from
  // updatePlayBtns, which every start/pause/stop path already routes through.
  function syncMedia() {
    // Keep-alive audio is needed for background play AND for the notification/lock-screen player;
    // the Media Session UI itself is shown only when "Show player in notification" is on.
    const keepAlive = W.speaking && (CFG.bgPlay !== false || CFG.mediaNotif !== false);
    mediaKeepAlive(keepAlive);
    if (W.speaking && CFG.mediaNotif !== false) { mediaSetup(); mediaMeta(); mediaState(W.paused ? "paused" : "playing"); }
    else mediaState("none");
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
          <label class="wr-check"><input type="checkbox" class="wr-bgplay" ${CFG.bgPlay !== false ? "checked" : ""}> <span>Keep playing in background (screen off)</span></label>
          <label class="wr-check"><input type="checkbox" class="wr-medianotif" ${CFG.mediaNotif !== false ? "checked" : ""}> <span>Show player in notification / lock screen</span></label>
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
    const bgplay = bar.querySelector(".wr-bgplay");
    if (bgplay) bgplay.addEventListener("change", (e) => { CFG.bgPlay = e.target.checked; saveCfg(); syncMedia(); });
    const medianotif = bar.querySelector(".wr-medianotif");
    if (medianotif) medianotif.addEventListener("change", (e) => { CFG.mediaNotif = e.target.checked; saveCfg(); syncMedia(); });
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
    syncMedia();
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
    if (!extAlive()) return null; // stale tab after an extension update — fall back / show reload hint
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
      // Surface a Turnstile/Cloudflare challenge distinctly so the bulk crawl can pause and let
      // the user clear it (rather than silently marking every chapter as a plain failure).
      if (e && (e.name === "CaptchaError" || /turnstile|captcha|verification/i.test(e.message || ""))) { W.adapterContent = undefined; return { captcha: true }; }
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
  // Some sites (e.g. Kakuyomu) render the chapter/episode title OUTSIDE the body
  // container that pickContent()/collectBlocks() scan, so it never becomes a readable
  // block and Read-aloud skips straight into the prose. Return it as a leading block so
  // the title is spoken first — unless the first prose block already is the title.
  function siteTitleBlock(firstText) {
    const el = document.querySelector(".widget-episodeTitle"); // Kakuyomu episode heading
    if (!el) return null;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const f = (firstText || "").replace(/\s+/g, " ").trim();
    if (f && (f === text || f.startsWith(text) || text.startsWith(f))) return null; // already covered
    return { el, text };
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
    const tb = siteTitleBlock(blocks[0] && blocks[0].text); // prepend the title if the site keeps it outside the body
    if (tb && !blocks.some((b) => b.el === tb.el)) blocks.unshift(tb);
    W.blocks = blocks; W.ttsHost = "page"; W.chunks = [];
    W.blocks.forEach((b) => b.el && b.el.classList.add("wr-readable")); // cursor hint: click to read from here
    injectShadowHighlightCss(W.blocks); // make highlight visible for prose inside shadow roots
    const bar = W.panel.querySelector('[data-tts="panel"]');
    if (bar && !bar.dataset.wired) { bar.innerHTML = ttsBarHtml(); wireTtsBar(bar); bar.dataset.wired = "1"; }
    if (bar) bar.classList.remove("wr-hidden");
    setStatus("Reading aloud… click any paragraph to jump there, or ■ to stop.");
    speakFrom(firstVisibleBlock(W.blocks));
  }

  // ================================================================= reader overlay
  // Detect the site's OWN Prev/Next chapter links from the page (e.g. newtoki's
  // .theme-novel-nav "Previous/Next episode"). Used for reader-mode Prev/Next on sites
  // whose chapter text can't be fetched into the overlay — there we navigate the real
  // page instead. Returns { prevUrl, nextUrl, pageNav:true } or null.
  function detectSiteChapterNav() {
    const scope = document.querySelector(".theme-novel-nav, .novel-nav, .view-nav, .pg-nav") || document.body;
    let prevUrl = null, nextUrl = null;
    for (const a of scope.querySelectorAll("a[href]")) {
      if (a.closest("#wr-root")) continue;
      const href = a.getAttribute("href"); if (!href || /^#/.test(href) || /^javascript:/i.test(href)) continue;
      const t = ((a.textContent || "") + " " + (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "")).replace(/\s+/g, " ").trim();
      let abs; try { abs = new URL(href, location.href).href; } catch (_) { continue; }
      if (abs === location.href) continue;
      if (!prevUrl && /previous\s*episode|이전\s*화|이전화|prev(ious)?\b|◀|‹|←/i.test(t)) prevUrl = abs;
      else if (!nextUrl && /next\s*episode|다음\s*화|다음화|\bnext\b|▶|›|→/i.test(t)) nextUrl = abs;
    }
    return (prevUrl || nextUrl) ? { prevUrl, nextUrl, pageNav: true } : null;
  }
  // Prev/Next for fetch-less sites: remember to reopen the reader (and resume TTS) after the
  // load, then navigate the real page to the sibling chapter.
  function navigateToChapter(url, autoplay) {
    if (!url) return;
    // Carry the current translate state forward so the next chapter opens translated too.
    const translate = !!(W.translated && !W.showingOriginal) || !!CFG.autoTranslate;
    try { sessionStorage.setItem("wrReopenReader", JSON.stringify({ autoplay: !!autoplay, translate, t: Date.now() })); } catch (_) {}
    setStatus("Loading chapter…");
    location.assign(url);
  }
  // After a page-nav Prev/Next, re-open the reader overlay once the new chapter's prose has
  // rendered (newtoki fills its shadow root asynchronously), and resume playback if it was on.
  function maybeReopenReader() {
    let intent = null;
    try { intent = JSON.parse(sessionStorage.getItem("wrReopenReader") || "null"); } catch (_) {}
    if (!intent || (Date.now() - intent.t) > 25000) { try { sessionStorage.removeItem("wrReopenReader"); } catch (_) {} return; }
    try { sessionStorage.removeItem("wrReopenReader"); } catch (_) {}
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      let blocks = [];
      try { blocks = pageReadableBlocks(); } catch (_) {}
      if (blocks.length > 2 || tries > 50) { // wait up to ~25s for async content
        clearInterval(timer);
        if (!blocks.length) return;
        try {
          if (intent.translate) { try { await translateNewNodes(); } catch (_) {} } // translate the freshly-rendered prose first
          await openReaderOverlay(); // reads the (now translated) prose + inline images
          if (intent.autoplay && W.ttsHost === "overlay" && W.blocks.length) speakFrom(0);
        } catch (_) {}
      }
    }, 500);
  }

  // ============================================================ chapter list + bulk download
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function u8ToB64(u8) { let s = ""; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function b64ToU8(b) { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  const stripQ = (u) => String(u || "").replace(/[#?].*$/, "");

  // The series URL the adapter's getMeta needs, derived from the current chapter URL.
  function seriesUrlFor(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)(newtoki|booktoki|manatoki|mantoki)\d*\./i.test(u.hostname)) return u.origin + u.pathname.replace(/\/(\d+)\/?$/, "");
      if (u.hostname.endsWith("wtr-lab.com")) return url.replace(/\/(?:old\/)?chapter-\d+\/?(?:[?#].*)?$/i, "");
      if (u.hostname.endsWith("kakuyomu.jp")) { const wm = /\/works\/(\d+)/.exec(url); return wm ? `https://kakuyomu.jp/works/${wm[1]}` : url; }
      return url;
    } catch (_) { return url; }
  }
  // Full chapter list for the current series via the site adapter's getMeta (cached).
  async function ensureChapterList() {
    const series = seriesUrlFor(location.href);
    if (W.chapterList && W.chapterListKey === series) return W.chapterList;
    globalThis.__WR_TX_VIA_SW = true;
    const reg = await import(chrome.runtime.getURL("adapters/registry.js"));
    const adapter = reg.pickAdapter(location.href);
    const meta = await adapter.getMeta(series);
    W.chapterList = (meta && Array.isArray(meta.chapters)) ? meta.chapters.map((c, i) => ({ no: c.no != null ? c.no : i + 1, url: c.url, title: c.title || ("Chapter " + (i + 1)) })) : [];
    W.chapterListKey = series;
    W.novelTitle = (meta && meta.title) || currentNovelTitle();
    return W.chapterList;
  }
  function currentChapterIndex(list) {
    const here = stripQ(location.href);
    let idx = list.findIndex((c) => stripQ(c.url) === here);
    if (idx < 0) { const tail = here.replace(/^https?:\/\/[^/]+/, ""); idx = list.findIndex((c) => c.url && stripQ(c.url).endsWith(tail)); }
    return idx;
  }
  function goToChapterUrl(url) {
    if (!url) return;
    if (W.overlayNav && W.overlayNav.pageNav) navigateToChapter(url, W.speaking);
    else gotoChapter(url, W.speaking);
  }

  // ---- Chapters drawer (left) ----
  function closeTocDrawer() { const d = W.overlay && W.overlay.querySelector(".wr-ov-toc"); if (d) d.remove(); }
  async function openTocDrawer() {
    if (!W.overlay) return;
    if (W.overlay.querySelector(".wr-ov-toc")) { closeTocDrawer(); return; } // toggle off
    const d = el("div", "wr-ov-toc");
    d.innerHTML = `
      <div class="wr-ov-toc-head"><span>Chapters</span><button class="wr-icon" data-toc="close">✕</button></div>
      <div class="wr-ov-toc-tools">
        <button class="wr-btn wr-sm" data-toc="all">All</button>
        <button class="wr-btn wr-sm" data-toc="none">None</button>
        <button class="wr-btn wr-sm" data-toc="here">From here</button>
        <button class="wr-btn wr-sm" data-toc="tr">🌐 Titles</button>
        <button class="wr-btn wr-sm wr-primary" data-toc="dl">⬇ Download…</button>
      </div>
      <div class="wr-ov-toc-list">Loading chapters…</div>`;
    W.overlay.appendChild(d);
    d.querySelector('[data-toc="close"]').addEventListener("click", closeTocDrawer);
    const list = d.querySelector(".wr-ov-toc-list");
    let chapters = [];
    try { chapters = await ensureChapterList(); } catch (e) { chapters = []; }
    const curIdx = currentChapterIndex(chapters);
    const titleFor = (c, i) => (W.chapterTitlesEn && W.chapterTitlesEn[i]) || c.title || ("Chapter " + (c.no != null ? c.no : i + 1));
    if (chapters.length) {
      list.innerHTML = "";
      chapters.forEach((c, i) => {
        const row = el("label", "wr-ov-toc-row" + (i === curIdx ? " wr-current" : ""));
        const cb = el("input"); cb.type = "checkbox"; cb.dataset.i = String(i);
        const t = el("span", "wr-ov-toc-t"); t.textContent = titleFor(c, i);
        t.addEventListener("click", (e) => { e.preventDefault(); goToChapterUrl(c.url); });
        row.appendChild(cb); row.appendChild(t); list.appendChild(row);
      });
      const curRow = list.children[curIdx]; if (curRow) curRow.scrollIntoView({ block: "center" });
    } else {
      list.textContent = "No chapter list on this site — use “Download…” → “From here (follow Next)”.";
    }
    const boxes = () => Array.from(list.querySelectorAll('input[type="checkbox"]'));
    d.querySelector('[data-toc="all"]').addEventListener("click", () => boxes().forEach((b) => (b.checked = true)));
    d.querySelector('[data-toc="none"]').addEventListener("click", () => boxes().forEach((b) => (b.checked = false)));
    d.querySelector('[data-toc="here"]').addEventListener("click", () => boxes().forEach((b, i) => (b.checked = i >= curIdx)));
    d.querySelector('[data-toc="dl"]').addEventListener("click", () => {
      const sel = boxes().filter((b) => b.checked).map((b) => +b.dataset.i);
      openDownloadDialog(chapters, curIdx, sel);
    });
    // Translate all chapter titles to English (cached on W, applied in place).
    const trBtn = d.querySelector('[data-toc="tr"]');
    trBtn.addEventListener("click", async () => {
      if (W.chapterTitlesEn) { // toggle back to original
        W.chapterTitlesEn = null;
        list.querySelectorAll(".wr-ov-toc-t").forEach((t, i) => (t.textContent = chapters[i] ? titleFor(chapters[i], i) : t.textContent));
        trBtn.textContent = "🌐 Titles"; return;
      }
      trBtn.disabled = true; trBtn.textContent = "Translating…";
      try {
        const out = await requestTranslate(chapters.map((c) => c.title || ""), CFG.targetLang || "en", "auto");
        W.chapterTitlesEn = out;
        list.querySelectorAll(".wr-ov-toc-t").forEach((t, i) => { if (out[i]) t.textContent = out[i]; });
        trBtn.textContent = "🌐 Original";
      } catch (e) { trBtn.textContent = "🌐 Titles"; setStatus("Couldn't translate titles."); }
      finally { trBtn.disabled = false; }
    });
  }

  // ---- Download options dialog ----
  function openDownloadDialog(chapters, curIdx, preSel) {
    const old = W.overlay.querySelector(".wr-ov-dl"); if (old) old.remove();
    const pageNav = !!(W.overlayNav && W.overlayNav.pageNav);
    const lastNo = (chapters[chapters.length - 1] && chapters[chapters.length - 1].no) || chapters.length;
    const curNo = (chapters[curIdx] && chapters[curIdx].no) || 1;
    const d = el("div", "wr-ov-dl");
    d.innerHTML = `
      <div class="wr-ov-toc-head"><span>Download chapters</span><button class="wr-icon" data-dl="close">✕</button></div>
      <div class="wr-dl-body">
        <label class="wr-dl-row">Which <select data-dl="scope">
          ${chapters.length > 1 ? `<option value="selected">Selected (${preSel.length})</option>
          <option value="here">From here to the end</option>
          <option value="range">Range…</option>
          <option value="all">All (${chapters.length})</option>` : ""}
          <option value="follow">From here (follow Next →)</option>
        </select></label>
        <div class="wr-dl-row wr-dl-range wr-hidden">From <input type="number" min="1" data-dl="from" value="${curNo}"> to <input type="number" min="1" data-dl="to" value="${lastNo}"></div>
        <label class="wr-dl-row">Output <select data-dl="output"><option value="individual">One file per chapter</option><option value="combined">One combined EPUB</option></select></label>
        <label class="wr-dl-row">Language <select data-dl="lang"><option value="en">English</option><option value="match">Match reader</option><option value="orig">Original</option></select></label>
        ${pageNav ? `<label class="wr-dl-row">Mode <select data-dl="mode"><option value="tab">This tab</option><option value="bg">Background tab</option></select></label>` : ""}
        <div class="wr-dl-row"><button class="wr-btn wr-primary" data-dl="start">Start download</button></div>
        <div class="wr-dl-note"></div>
      </div>`;
    W.overlay.appendChild(d);
    d.querySelector('[data-dl="close"]').addEventListener("click", () => d.remove());
    const scopeSel = d.querySelector('[data-dl="scope"]');
    scopeSel.value = preSel.length ? "selected" : "here";
    const rangeRow = d.querySelector(".wr-dl-range");
    const syncRange = () => rangeRow.classList.toggle("wr-hidden", scopeSel.value !== "range");
    scopeSel.addEventListener("change", syncRange); syncRange();
    const note = d.querySelector(".wr-dl-note");
    const modeSel = d.querySelector('[data-dl="mode"]');
    if (modeSel) modeSel.addEventListener("change", () => { note.textContent = modeSel.value === "bg" ? "Background mode isn't available yet — this run will use the current tab." : ""; });
    d.querySelector('[data-dl="start"]').addEventListener("click", () => {
      const scope = scopeSel.value;
      let idxs = [];
      if (scope === "selected") idxs = preSel.slice();
      else if (scope === "here") idxs = chapters.map((_, i) => i).filter((i) => i >= Math.max(curIdx, 0));
      else if (scope === "all") idxs = chapters.map((_, i) => i);
      else if (scope === "range") {
        const from = +d.querySelector('[data-dl="from"]').value, to = +d.querySelector('[data-dl="to"]').value;
        const lo = Math.min(from, to), hi = Math.max(from, to);
        idxs = chapters.map((c, i) => i).filter((i) => { const n = chapters[i].no != null ? chapters[i].no : i + 1; return n >= lo && n <= hi; });
      }
      idxs = [...new Set(idxs)].sort((a, b) => a - b);
      const opts = {
        scope,
        output: d.querySelector('[data-dl="output"]').value,
        lang: d.querySelector('[data-dl="lang"]').value,
        pageNav: scope === "follow" ? true : pageNav, // follow always drives the page
      };
      if (scope !== "follow" && !idxs.length) { note.textContent = "No chapters selected."; return; }
      d.remove(); closeTocDrawer();
      startCrawl(chapters, idxs, opts);
    });
  }

  // ================= bulk download: panel, engines, per-chapter status + pause + retry =========
  // sessionStorage: wrCrawl (control), wrCancel, wrPause. chrome.storage.local: wrCrawlChapters
  // (built content for OK chapters), wrCrawlStatus (every attempt: {seq,no,title,url,ok}).
  const MAX_ATTEMPTS = 3;          // per-chapter reloads before a chapter is marked failed
  const MAX_ROUNDS = 2;            // end-of-run automatic retry passes over the failed chapters
  const CONN_FAIL_THRESHOLD = 3;   // consecutive failed chapters → assume connectivity/VPN loss → pause
  function myId() { try { return (chrome.runtime && chrome.runtime.id) || ""; } catch (_) { return ""; } }
  function clearCrawl() { try { sessionStorage.removeItem("wrCrawl"); } catch (_) {} }
  function getCrawlState() { try { return JSON.parse(sessionStorage.getItem("wrCrawl") || "null"); } catch (_) { return null; } }
  function saveCrawl(st) { try { sessionStorage.setItem("wrCrawl", JSON.stringify(st)); } catch (_) {} }
  function cancelRequested() { try { return !!sessionStorage.getItem("wrCancel"); } catch (_) { return false; } }
  function clearCancel() { try { sessionStorage.removeItem("wrCancel"); } catch (_) {} }
  function cancelCrawl() { W._crawlCancel = true; try { sessionStorage.setItem("wrCancel", "1"); } catch (_) {} clearCrawl(); hideCrawlProgress(); setStatus("Download cancelled."); }
  function pauseRequested() { try { return !!sessionStorage.getItem("wrPause"); } catch (_) { return false; } }
  function setPause() { try { sessionStorage.setItem("wrPause", "1"); } catch (_) {} }
  function clearPause() { try { sessionStorage.removeItem("wrPause"); } catch (_) {} }
  const sgGet = (k) => new Promise((res) => { try { chrome.storage.local.get(k, (o) => res((o && o[k]) || [])); } catch (_) { res([]); } });
  const sgSet = (k, v) => new Promise((res) => { try { chrome.storage.local.set({ [k]: v }, res); } catch (_) { res(); } });
  function clearCrawlData() { return sgSet("wrCrawlChapters", []).then(() => sgSet("wrCrawlStatus", [])); }
  function loadCrawlData() { return sgGet("wrCrawlChapters"); }
  function loadCrawlStatus() { return sgGet("wrCrawlStatus"); }
  async function upsertCrawlData(e) { const a = await sgGet("wrCrawlChapters"); const i = a.findIndex((x) => x.seq === e.seq); if (i >= 0) a[i] = e; else a.push(e); await sgSet("wrCrawlChapters", a); }
  async function upsertCrawlStatus(e) { const a = await sgGet("wrCrawlStatus"); const i = a.findIndex((x) => x.seq === e.seq); if (i >= 0) a[i] = e; else a.push(e); await sgSet("wrCrawlStatus", a); }
  function wantTranslateFor(lang) { return lang === "en" || (lang === "match" && ((W.translated && !W.showingOriginal) || CFG.autoTranslate)); }

  // ---- unified crawl panel ----
  function crawlPanelEl() { let p = W.root && W.root.querySelector(".wr-crawl"); if (!p) { p = el("div", "wr-crawl"); if (W.root) W.root.appendChild(p); } p.classList.remove("wr-hidden"); return p; }
  function hideCrawlProgress() { const p = W.root && W.root.querySelector(".wr-crawl"); if (p) p.remove(); }
  function crawlMin() { try { return !!sessionStorage.getItem("wrCrawlMin"); } catch (_) { return false; } }
  function wireMin(p) { // minimize/expand the panel so it never blocks the page
    const b = p.querySelector('[data-crawl="min"]'); if (!b) return;
    const apply = () => { const m = crawlMin(); p.classList.toggle("wr-min", m); b.textContent = m ? "▣" : "—"; b.title = m ? "Expand" : "Minimize"; };
    b.addEventListener("click", () => { try { crawlMin() ? sessionStorage.removeItem("wrCrawlMin") : sessionStorage.setItem("wrCrawlMin", "1"); } catch (_) {} apply(); });
    apply();
  }
  function statusRowsHtml(status, withRetry) {
    return status.map((s) => `<div class="wr-cr-row"><span class="wr-cr-ic ${s.ok ? "ok" : "fail"}">${s.ok ? "✓" : "✗"}</span><span class="wr-cr-t">${xesc(s.title || ("Chapter " + (s.no != null ? s.no : s.seq + 1)))}</span>${(withRetry && !s.ok) ? `<button class="wr-btn wr-sm" data-retry="${s.seq}">Retry</button>` : ""}</div>`).join("");
  }
  async function renderProgressPanel(info) { // {idx,total,title,paused}
    const p = crawlPanelEl();
    const status = await loadCrawlStatus();
    const ok = status.filter((s) => s.ok).length, fail = status.length - ok;
    const head = info.paused
      ? `Paused — ${ok} done${fail ? `, ${fail} failed` : ""}`
      : (info.total ? `Downloading ${Math.min(info.idx + 1, info.total)} / ${info.total}` : `Downloading ${info.idx + 1}`) + (fail ? ` · ${fail} failed` : "");
    p.innerHTML = `<div class="wr-cr-head"><span class="wr-cr-htext"></span><span class="wr-cr-btns"><button class="wr-btn wr-sm" data-crawl="min">—</button><button class="wr-btn wr-sm" data-crawl="${info.paused ? "resume" : "pause"}">${info.paused ? "Resume" : "Pause"}</button><button class="wr-btn wr-sm" data-crawl="cancel">Cancel</button></span></div><div class="wr-cr-list">${statusRowsHtml(status, false)}${info.paused ? "" : `<div class="wr-cr-row"><span class="wr-cr-ic">…</span><span class="wr-cr-t">${xesc(info.title || "")}</span></div>`}</div>`;
    p.querySelector(".wr-cr-htext").textContent = head;
    wireMin(p);
    p.querySelector('[data-crawl="cancel"]').addEventListener("click", cancelCrawl);
    const pb = p.querySelector('[data-crawl="pause"]'); if (pb) pb.addEventListener("click", () => { setPause(); pb.textContent = "Pausing…"; pb.disabled = true; setStatus("Pausing after this chapter…"); });
    const rb = p.querySelector('[data-crawl="resume"]'); if (rb) rb.addEventListener("click", resumeFromPause);
    const list = p.querySelector(".wr-cr-list"); if (list) list.scrollTop = list.scrollHeight;
  }
  async function renderResultsPanel(novel, opts, engine) {
    const p = crawlPanelEl();
    const status = await loadCrawlStatus();
    const dataArr = await loadCrawlData();
    const ok = status.filter((s) => s.ok).length, fail = status.length - ok;
    const hasCaptcha = status.some((s) => !s.ok && s.captcha);
    let pending = [];
    try { pending = dataArr.length ? await buildPending(dataArr, opts.output, novel) : []; } catch (e) { console.warn("[WebReader] build failed", e); }
    const bar = fail ? `<div class="wr-cr-bar">${hasCaptcha ? "⚠ Site asked for a captcha — tap Solve, clear it, then Retry failed. " : ""}<button class="wr-btn wr-sm" data-crawl="retryall">Retry failed (${fail})</button>${hasCaptcha ? '<button class="wr-btn wr-sm" data-crawl="solve">Solve captcha</button>' : ""}</div>` : "";
    p.innerHTML = `<div class="wr-cr-head"><span class="wr-cr-htext">Done — ${ok} ok${fail ? `, ${fail} failed` : ""}</span><span class="wr-cr-btns"><button class="wr-btn wr-sm" data-crawl="min">—</button><button class="wr-btn wr-sm wr-primary" data-crawl="save" ${pending.length ? "" : "disabled"}>⬇ Save</button><button class="wr-btn wr-sm" data-crawl="close">✕</button></span></div>${bar}<div class="wr-cr-list">${statusRowsHtml(status, true)}</div>`;
    wireMin(p);
    p.querySelector('[data-crawl="close"]').addEventListener("click", () => { p.remove(); clearCrawlData(); });
    p.querySelector('[data-crawl="save"]').addEventListener("click", () => { let n = 0; for (const d of pending) { if (saveBlob(d.blob, d.filename)) n++; } setStatus(`Saved ${n} file(s).`); }); // sync in gesture; pending pre-built
    p.querySelectorAll("[data-retry]").forEach((btn) => btn.addEventListener("click", () => retryChapter(+btn.dataset.retry, novel, opts, engine)));
    const ra = p.querySelector('[data-crawl="retryall"]'); if (ra) ra.addEventListener("click", () => retryFailed(novel, opts, engine));
    const sv = p.querySelector('[data-crawl="solve"]'); if (sv) sv.addEventListener("click", () => { const f = status.find((s) => !s.ok); if (f) { try { window.open(f.url, "_blank"); } catch (_) { location.href = f.url; } setStatus("Solve the verification in the opened tab, then tap “Retry failed”."); } });
  }
  // Retry every failed chapter (mass). Keeps the OK chapters; upserts the failed ones by seq.
  async function retryFailed(novel, opts, engine) {
    const status = await loadCrawlStatus();
    const failed = status.filter((s) => !s.ok);
    if (!failed.length) return;
    W._crawlCancel = false; clearCancel(); clearPause();
    const queue = failed.map((s) => ({ url: s.url, no: s.no, title: s.title, seq: s.seq }));
    if (engine === "fetch") { await crawlFetch(queue, opts, novel); return; } // re-fetch in place, re-renders results
    saveCrawl({ queue, idx: 0, opts, novel, owner: myId(), t: Date.now() });
    setStatus("Retrying failed…");
    if (stripQ(location.href) === stripQ(queue[0].url)) resumeCrawl();
    else location.assign(queue[0].url);
  }

  // ---- wait for the chapter prose to actually render (not menus/ads/"Loading text") ----
  async function waitForChapter() {
    const needsVD = /(^|\.)(newtoki|booktoki|manatoki|mantoki)\d*\./i.test(location.hostname);
    const isChapter = () => !needsVD || !!document.getElementById("theme-novel-viewer-data") || !!document.querySelector(".theme-novel-content");
    const ready = () => { const host = document.querySelector(".theme-novel-content, #novel_content, .view-content"); if (host) { const sr = host.shadowRoot; const t = ((sr && sr.textContent) || host.textContent || "").replace(/\s+/g, " ").trim(); return t.length > 150 && !/Loading text|불러오는 중|로딩/i.test(t); } let b = []; try { b = pageReadableBlocks(); } catch (_) {} return b.length > 2; };
    for (let tries = 0; tries < 90; tries++) {
      if (isChapter() && ready()) return "ok";
      if (cancelRequested() || W._crawlCancel) return "cancel";
      if (/Access denied/i.test(document.title)) return "denied";
      // After a short grace, a page that still isn't a chapter is an ad/listing/redirect — bail fast
      // so the caller can reload, instead of burning the full timeout budget on it.
      if (tries >= 14 && !isChapter()) return "notchapter";
      await sleep(500);
    }
    return "timeout";
  }
  // Scrape the current page into storage (data + status), keyed by seq (so a retry replaces it).
  async function scrapeAndStore(seq, no, url, opts) {
    let items = collectItems(pickContent());
    if (wantTranslateFor(opts.lang)) { try { items = await translateItemsText(items); } catch (_) {} }
    const title = currentChapterTitle() || ("Chapter " + (no != null ? no : seq + 1));
    const { xhtmlBody, images } = await buildChapterParts(items, `c${seq}_`);
    if (xhtmlBody) {
      await upsertCrawlData({ seq, no, title, xhtmlBody, images: images.map((im) => ({ id: im.id, name: im.name, mime: im.mime, b64: u8ToB64(im.data) })), srcUrl: url });
      await upsertCrawlStatus({ seq, no, title, url, ok: true });
      return true;
    }
    await upsertCrawlStatus({ seq, no, title, url, ok: false });
    return false;
  }

  async function startCrawl(chapters, idxs, opts) {
    const novel = currentNovelTitle() || W.novelTitle || "Novel";
    W._crawlCancel = false; clearCancel(); clearPause();
    const owner = myId();
    if (opts.scope === "follow") { // follow the site's own Next link from the current page (any site)
      await clearCrawlData();
      saveCrawl({ follow: true, idx: 0, opts, novel, owner, t: Date.now(), max: 5000 });
      resumeCrawl(); return;
    }
    const queue = idxs.map((i, k) => ({ url: chapters[i].url, no: chapters[i].no, title: chapters[i].title, seq: k }));
    if (!queue.length) return;
    await clearCrawlData();
    if (!opts.pageNav) return crawlFetch(queue, opts, novel); // adapter sites: fetch loop (no reload)
    saveCrawl({ queue, idx: 0, opts, novel, owner, t: Date.now() });
    if (stripQ(location.href) === stripQ(queue[0].url)) resumeCrawl();
    else location.assign(queue[0].url);
  }

  // Adapter sites: fetch each chapter in place (fast, no navigation), store status, then results.
  // queue items may carry `seq` (mass-retry of specific chapters); else the loop index is the seq.
  async function crawlFetch(queue, opts, novel) {
    for (let i = 0; i < queue.length; i++) {
      if (W._crawlCancel || cancelRequested()) { clearCancel(); hideCrawlProgress(); setStatus("Download cancelled."); return; }
      const ch = queue[i]; const seq = ch.seq != null ? ch.seq : i;
      await renderProgressPanel({ idx: i, total: queue.length, title: ch.title });
      let content = null;
      try { W.adapterUrl = null; W.adapterContent = undefined; content = await getAdapterContent(ch.url); } catch (_) {}
      // Captcha → pause the WHOLE crawl right here (don't burn the rest as failures). The captcha'd
      // chapter stays at the front of the remaining queue so it's retried (not skipped) on resume.
      if (content && content.captcha) {
        saveCrawl({ engine: "fetch", queue: queue.slice(i), opts, novel, owner: myId(), captchaPaused: true, captchaUrl: ch.url, t: Date.now() });
        await renderCaptchaPanel(novel, opts);
        return;
      }
      const title = (content && content.title) || ch.title || ("Chapter " + (ch.no != null ? ch.no : seq + 1));
      if (content && content.items && content.items.length) {
        const { xhtmlBody, images } = await buildChapterParts(content.items, `c${seq}_`);
        if (xhtmlBody) { await upsertCrawlData({ seq, no: ch.no, title, xhtmlBody, images, srcUrl: ch.url }); await upsertCrawlStatus({ seq, no: ch.no, title, url: ch.url, ok: true }); continue; }
      }
      await upsertCrawlStatus({ seq, no: ch.no, title, url: ch.url, ok: false });
    }
    clearCrawl(); // a fully-finished fetch crawl needs no resumable state
    await renderResultsPanel(novel, opts, "fetch");
  }

  // Captcha pause panel: like the progress panel but with Open-captcha / Resume / Cancel.
  async function renderCaptchaPanel(novel, opts) {
    const p = crawlPanelEl();
    const status = await loadCrawlStatus();
    const ok = status.filter((s) => s.ok).length;
    p.innerHTML = `<div class="wr-cr-head"><span class="wr-cr-htext">⚠ Paused — captcha (${ok} done)</span><span class="wr-cr-btns"><button class="wr-btn wr-sm" data-crawl="min">—</button><button class="wr-btn wr-sm" data-crawl="cancel">Cancel</button></span></div><div class="wr-cr-bar">The site needs a verification. Tap <b>Open captcha</b>, clear it, and it resumes automatically. <button class="wr-btn wr-sm wr-primary" data-crawl="opencap">Open captcha</button><button class="wr-btn wr-sm" data-crawl="resumecap">Resume now</button></div><div class="wr-cr-list">${statusRowsHtml(status, false)}</div>`;
    wireMin(p);
    p.querySelector('[data-crawl="cancel"]').addEventListener("click", cancelCrawl);
    p.querySelector('[data-crawl="resumecap"]').addEventListener("click", resumeFetchCrawl);
    p.querySelector('[data-crawl="opencap"]').addEventListener("click", () => {
      const st = getCrawlState(); const url = (st && st.captchaUrl) || location.href;
      setStatus("Solve the verification — the download resumes automatically.");
      try { closeReaderOverlay(); } catch (_) {}
      location.assign(url); // show the site's Turnstile; init re-shows the panel + poll after load
    });
  }
  function resumeFetchCrawl() {
    const st = getCrawlState(); if (!st || !st.queue) return;
    st.captchaPaused = false; saveCrawl(st);
    W._captchaPoll = false;
    crawlFetch(st.queue, st.opts, st.novel); // captcha'd chapter is first → retried, then continues
  }
  // After "Open captcha" reloads the page, poll the API until the captcha clears, then auto-resume.
  function startCaptchaPoll(st) {
    W._captchaPoll = true;
    const started = Date.now();
    const tick = async () => {
      if (!W._captchaPoll) return;
      if (cancelRequested()) { W._captchaPoll = false; return; }
      const cur = getCrawlState();
      if (!cur || !cur.captchaPaused) { W._captchaPoll = false; return; }
      if (Date.now() - started > 10 * 60 * 1000) { W._captchaPoll = false; setStatus("Captcha wait timed out — tap Resume now when ready."); return; }
      let c = null;
      try { W.adapterUrl = null; W.adapterContent = undefined; c = await getAdapterContent(cur.captchaUrl); } catch (_) {}
      if (c && !c.captcha) { W._captchaPoll = false; resumeFetchCrawl(); return; } // cleared → resume
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 3000);
  }

  // Retry a single failed chapter. nav → navigate+scrape (reload); fetch → re-fetch in place.
  async function retryChapter(seq, novel, opts, engine) {
    const status = await loadCrawlStatus();
    const s = status.find((x) => x.seq === seq); if (!s) return;
    if (engine === "fetch") {
      setStatus("Retrying…");
      let content = null;
      try { W.adapterUrl = null; W.adapterContent = undefined; content = await getAdapterContent(s.url); } catch (_) {}
      if (content && content.items && content.items.length) {
        const { xhtmlBody, images } = await buildChapterParts(content.items, `c${seq}_`);
        if (xhtmlBody) { await upsertCrawlData({ seq, no: s.no, title: content.title || s.title, xhtmlBody, images, srcUrl: s.url }); await upsertCrawlStatus({ seq, no: s.no, title: content.title || s.title, url: s.url, ok: true }); }
      }
      await renderResultsPanel(novel, opts, "fetch"); return;
    }
    W._crawlCancel = false; clearCancel();
    saveCrawl({ retry: true, retrySeq: seq, retryNo: s.no, retryUrl: s.url, retryTitle: s.title, opts, novel, owner: myId(), t: Date.now() });
    setStatus("Retrying…"); location.assign(s.url);
  }

  function resumeFromPause() {
    const st = getCrawlState(); if (!st) return;
    st.paused = false; clearPause(); saveCrawl(st);
    if (st.follow) { const nu = (detectSiteChapterNav() || {}).nextUrl; if (nu && stripQ(nu) !== stripQ(location.href)) location.assign(nu); else finishNavCrawl(st); }
    else if (st.queue && st.idx < st.queue.length) location.assign(st.queue[st.idx].url);
    else finishNavCrawl(st);
  }
  async function finishNavCrawl(st) {
    // Auto-retry failed chapters in rounds before showing results, so the user doesn't have to tap
    // Retry themselves. Each round re-navigates only the failed chapters with A2's reload-retry.
    const status = await loadCrawlStatus();
    const failed = status.filter((s) => !s.ok);
    const round = st.autoRound || 0;
    if (failed.length && round < MAX_ROUNDS && !cancelRequested() && !W._crawlCancel) {
      const queue = failed.map((s) => ({ url: s.url, no: s.no, title: s.title, seq: s.seq }));
      clearPause();
      saveCrawl({ queue, idx: 0, opts: st.opts, novel: st.novel, owner: myId(), autoRound: round + 1, t: Date.now() });
      setStatus(`Auto-retrying ${failed.length} failed (round ${round + 1})…`);
      await renderProgressPanel({ idx: 0, total: queue.length, title: queue[0].title });
      await sleep(1500);
      if (W._crawlCancel || cancelRequested()) { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
      if (stripQ(location.href) === stripQ(queue[0].url)) resumeCrawl();
      else location.assign(queue[0].url);
      return;
    }
    clearCrawl(); await renderResultsPanel(st.novel, st.opts, "nav");
  }

  // Connectivity-loss pause (nav engine): the site is unreachable (VPN dropped). Show a panel and
  // poll the origin until it responds, then auto-resume from where we paused. Mirrors the captcha pause.
  async function renderConnPanel(st) {
    const p = crawlPanelEl();
    const status = await loadCrawlStatus();
    const ok = status.filter((s) => s.ok).length;
    p.innerHTML = `<div class="wr-cr-head"><span class="wr-cr-htext">⚠ Connection lost (${ok} done)</span><span class="wr-cr-btns"><button class="wr-btn wr-sm" data-crawl="min">—</button><button class="wr-btn wr-sm" data-crawl="cancel">Cancel</button></span></div><div class="wr-cr-bar">Can't reach the site — check your VPN. It retries automatically; or tap <button class="wr-btn wr-sm wr-primary" data-crawl="resumeconn">Resume now</button> once it's back.</div><div class="wr-cr-list">${statusRowsHtml(status, false)}</div>`;
    wireMin(p);
    p.querySelector('[data-crawl="cancel"]').addEventListener("click", cancelCrawl);
    p.querySelector('[data-crawl="resumeconn"]').addEventListener("click", resumeFromConn);
  }
  function startConnPoll(st) {
    W._connPoll = true;
    const started = Date.now();
    const tick = async () => {
      if (!W._connPoll) return;
      if (cancelRequested()) { W._connPoll = false; return; }
      const cur = getCrawlState();
      if (!cur || !cur.connPaused) { W._connPoll = false; return; }
      if (Date.now() - started > 60 * 60 * 1000) { W._connPoll = false; return; } // stop auto-probe after 1h; Resume still works
      let up = false;
      try {
        await Promise.race([
          fetch(location.origin + "/favicon.ico?_wrp=" + Date.now(), { method: "GET", cache: "no-store", mode: "no-cors" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
        ]);
        up = true;
      } catch (_) { up = false; }
      if (up) { W._connPoll = false; resumeFromConn(); return; } // reachable → resume
      setTimeout(tick, 20000);
    };
    setTimeout(tick, 20000);
  }
  function resumeFromConn() {
    const st = getCrawlState(); if (!st) return;
    st.connPaused = false; st.consecFail = 0; st.attempt = 0; st.failRunStart = undefined; saveCrawl(st);
    W._connPoll = false;
    const target = (st.queue && st.idx < st.queue.length) ? st.queue[st.idx].url : null;
    if (target && stripQ(location.href) !== stripQ(target)) location.assign(target);
    else location.reload();
  }

  // newtoki/pageNav + follow: resume the navigate-scrape crawl after each page load.
  async function resumeCrawl() {
    if (cancelRequested()) { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
    const st = getCrawlState();
    if (!st || (Date.now() - st.t) > 6 * 3600 * 1000) { clearCrawl(); return; }
    if (st.owner && myId() && st.owner !== myId()) return; // another installed copy owns this crawl
    W._crawlCancel = false;

    // Retry of a single chapter (user tapped Retry on the results list).
    if (st.retry) {
      await renderProgressPanel({ idx: 0, total: 1, title: st.retryTitle });
      const w = await waitForChapter();
      if (w === "cancel") { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
      // Reload-retry so manual Retry matches a by-hand reload (clears ads / grants render time).
      if (w !== "ok" && (st.attempt || 0) < MAX_ATTEMPTS && !cancelRequested() && !W._crawlCancel) {
        st.attempt = (st.attempt || 0) + 1; saveCrawl(st);
        await renderProgressPanel({ idx: 0, total: 1, title: `Retrying chapter (attempt ${st.attempt})${w === "denied" ? " — check VPN" : ""}` });
        await sleep(w === "denied" ? 5000 : (w === "notchapter" ? 1500 : 2500));
        if (cancelRequested() || W._crawlCancel) { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
        location.reload(); return;
      }
      if (w === "ok") await scrapeAndStore(st.retrySeq, st.retryNo, st.retryUrl, st.opts);
      else await upsertCrawlStatus({ seq: st.retrySeq, no: st.retryNo, title: st.retryTitle, url: st.retryUrl, ok: false });
      clearCrawl(); await renderResultsPanel(st.novel, st.opts, "nav"); return;
    }
    // Sitting paused (reloaded while paused): just show the paused panel.
    if (st.paused) { await renderProgressPanel({ idx: st.idx, total: st.queue ? st.queue.length : 0, paused: true }); return; }

    const total = st.queue ? st.queue.length : 0;
    const cur = st.queue ? st.queue[st.idx] : { url: location.href };
    const seq = (cur && cur.seq != null) ? cur.seq : st.idx; // mass-retry queue carries original seq
    await renderProgressPanel({ idx: st.idx, total, title: cur && cur.title });
    let w = await waitForChapter();
    if (w === "cancel") { clearCancel(); clearCrawl(); hideCrawlProgress(); setStatus("Download cancelled."); return; }

    // Per-chapter reload-retry: an ad interstitial ("notchapter"), a slow render ("timeout"), or a
    // transient block ("denied") is almost always fixed by reloading — exactly what the user did by
    // hand. Reload the SAME chapter up to MAX_ATTEMPTS before giving up and marking it failed.
    if (w !== "ok") {
      if ((st.attempt || 0) < MAX_ATTEMPTS && !cancelRequested() && !W._crawlCancel) {
        st.attempt = (st.attempt || 0) + 1; saveCrawl(st);
        await renderProgressPanel({ idx: st.idx, total, title: `Retrying chapter (attempt ${st.attempt})${w === "denied" ? " — check VPN" : ""}` });
        await sleep(w === "denied" ? 5000 : (w === "notchapter" ? 1500 : 2500));
        if (cancelRequested() || W._crawlCancel) { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
        location.reload(); return;
      }
    }
    st.attempt = 0;

    let okNow = false;
    if (w === "ok") okNow = await scrapeAndStore(seq, cur && cur.no, location.href, st.opts);
    else await upsertCrawlStatus({ seq, no: cur && cur.no, title: (cur && cur.title) || currentChapterTitle() || ("Chapter " + (seq + 1)), url: location.href, ok: false });
    if (W._crawlCancel || cancelRequested()) { clearCancel(); clearCrawl(); hideCrawlProgress(); setStatus("Download cancelled."); return; }

    // A run of consecutive failures means the site is unreachable (VPN/connection dropped), not a
    // per-chapter glitch — so PAUSE and poll instead of burning the rest of the queue as failures.
    // Rewind to the first chapter of the run so none of those are lost once it's back.
    if (okNow) { st.consecFail = 0; st.failRunStart = undefined; }
    else {
      if (st.consecFail == null) st.consecFail = 0;
      if (st.consecFail === 0) st.failRunStart = st.idx;
      st.consecFail++;
      if (st.consecFail >= CONN_FAIL_THRESHOLD && !st.follow && st.queue) {
        st.idx = (st.failRunStart != null ? st.failRunStart : st.idx);
        st.connPaused = true; st.attempt = 0; saveCrawl(st);
        await renderConnPanel(st); startConnPoll(st); return;
      }
    }

    // Decide the next chapter.
    const nextIdx = st.idx + 1;
    let nextUrl = null;
    if (st.follow) { const nu = (detectSiteChapterNav() || {}).nextUrl; if (nu && stripQ(nu) !== stripQ(location.href) && nextIdx < (st.max || 5000)) nextUrl = nu; }
    else if (st.queue && nextIdx < st.queue.length) nextUrl = st.queue[nextIdx].url;

    if (!nextUrl) { await finishNavCrawl(st); return; } // finished → results (auto-retry rounds first)

    if (pauseRequested()) { clearPause(); st.idx = nextIdx; st.paused = true; saveCrawl(st); await renderProgressPanel({ idx: st.idx, total, paused: true }); return; }
    st.idx = nextIdx; saveCrawl(st);
    await renderProgressPanel({ idx: st.idx, total, title: st.queue ? (st.queue[st.idx] && st.queue[st.idx].title) : "" });
    // Adaptive pacing: base delay plus extra after failures so rate-limiting can cool off.
    await sleep(Math.min(600 + (st.consecFail || 0) * 1500, 6000));
    if (W._crawlCancel || cancelRequested()) { clearCancel(); clearCrawl(); hideCrawlProgress(); return; }
    location.assign(nextUrl);
  }

  async function openReaderOverlay() {
    setStatus("Loading…");
    let adapted = null;
    try { adapted = await getAdapterContent(); } catch (e) { console.warn("[WebReader] adapter failed", e); adapted = null; }
    if (adapted && adapted.toc) { setStatus("This is a contents page — open a chapter/episode to read it."); return; }
    if (adapted && adapted.items && adapted.items.length) { buildOverlay(adapted.title || document.title, adapted.items, adapted.nav); return; }
    // Fallback (adapter unavailable / unrecognised site): build the clean overlay from the
    // page's visible content as-is — no forced translation, so it can't hang or stay blank.
    // If translation is on (or the page was translated), translate the freshly-rendered
    // prose before snapshotting it into the overlay — otherwise Reader mode shows the
    // original language even though auto-translate is enabled.
    if (CFG.autoTranslate || (W.translated && !W.showingOriginal)) { try { await translateNewNodes(); } catch (_) {} }
    // Collect prose AND inline images (shadow-aware), in order; fall back to text-only.
    let items = collectItems(pickContent());
    if (!items.length) items = pageReadableBlocks().map((b) => ({ text: b.text }));
    if (!items.length) { setStatus("No readable text to show in the reader."); return; }
    const title = (document.querySelector("h1, h2") || {}).textContent || document.title || "Reading";
    // Chapter text isn't fetchable here, but the page exposes its own Prev/Next links —
    // wire them so reader-mode Prev/Next navigate the real page (and reopen the reader).
    buildOverlay(title, items, detectSiteChapterNav());
  }

  // Render a clean reading overlay from items ([{text}|{image}]) and start the reader.
  // nav = { prevUrl, nextUrl } enables the Prev/Next chapter buttons (adapter sites).
  function buildOverlay(title, items, nav) {
    W.overlayNav = nav || null;
    if (W.overlay) W.overlay.remove();
    const ov = el("div", "wr-overlay");
    ov.innerHTML = `
      <div class="wr-ov-bar">
        <button class="wr-icon wr-ov-tocbtn" data-ov="toc" title="Chapters">☰</button>
        <span class="wr-ov-title"></span>
        <span class="wr-head-btns">
          <button class="wr-btn wr-sm" data-ov="prev" title="Previous chapter">← Prev</button>
          <button class="wr-btn wr-sm" data-ov="next" title="Next chapter">Next →</button>
          <button class="wr-icon" data-ov="dl" title="Download this chapter as EPUB">⬇</button>
          <button class="wr-icon" data-ov="display" title="Display settings (font, size, theme)">Aa</button>
          <button class="wr-icon" data-ov="close" title="Close reader">✕</button>
        </span>
      </div>
      <div class="wr-ov-scroll"><article class="wr-ov-content"></article></div>
      <button class="wr-ov-top wr-hidden" data-ov="top" title="Back to top" aria-label="Back to top">↑</button>
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
    ov.querySelector('[data-ov="toc"]').addEventListener("click", openTocDrawer);
    ov.querySelector('[data-ov="dl"]').addEventListener("click", downloadCurrentChapter);
    ov.querySelector('[data-ov="display"]').addEventListener("click", toggleOvDisplay);
    // Floating "back to top": show once the reader is scrolled down, jump to the top on tap.
    const ovScroll = ov.querySelector(".wr-ov-scroll"), ovTop = ov.querySelector('[data-ov="top"]');
    if (ovScroll && ovTop) {
      ovScroll.addEventListener("scroll", () => ovTop.classList.toggle("wr-hidden", ovScroll.scrollTop < 400), { passive: true });
      ovTop.addEventListener("click", () => ovScroll.scrollTo({ top: 0, behavior: "smooth" }));
    }
    buildOvDisplay(ov);
    if (CFG.ovImportedFont && CFG.ovImportedFont.name && CFG.ovImportedFont.dataUrl) registerOvFont(CFG.ovImportedFont.name, CFG.ovImportedFont.dataUrl).then(applyOverlayDisplay);
    applyOverlayDisplay();
    const prevBtn = ov.querySelector('[data-ov="prev"]'), nextBtn = ov.querySelector('[data-ov="next"]');
    // pageNav sites (e.g. newtoki) can't fetch a sibling chapter into the overlay, so Prev/Next
    // navigate the real page; adapter sites load the chapter in place via gotoChapter.
    const go = (url) => { if (!url) return; (nav && nav.pageNav) ? navigateToChapter(url, W.speaking) : gotoChapter(url, W.speaking); };
    prevBtn.disabled = !(nav && nav.prevUrl); prevBtn.addEventListener("click", () => go(nav && nav.prevUrl));
    nextBtn.disabled = !(nav && nav.nextUrl); nextBtn.addEventListener("click", () => go(nav && nav.nextUrl));
    const bar = ov.querySelector(".wr-ov-tts");
    bar.innerHTML = ttsBarHtml(); wireTtsBar(bar);
    content.addEventListener("click", (e) => {
      const p = e.target.closest(".wr-ov-p"); if (!p) return;
      const i = ovBlocks.findIndex((x) => x.el === p); if (i >= 0) speakFrom(i);
    });

    stopTts();
    W.blocks = ovBlocks; W.ttsHost = "overlay"; W.chunks = []; W.blockIdx = 0; // start at the title, not a stale index from the previous chapter
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
    if (CFG.autoNext !== false && W.ttsHost === "overlay" && W.overlayNav && W.overlayNav.nextUrl) {
      if (W.overlayNav.pageNav) navigateToChapter(W.overlayNav.nextUrl, true);
      else gotoChapter(W.overlayNav.nextUrl, true);
    } else { stopTts(); setStatus("Finished reading."); }
  }

  // ================================================================= open in extension reader
  function openInExtensionReader() {
    if (!extAlive()) { setStatus(RELOAD_MSG); return; } // stale tab after an extension update
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
      if (CFG.enabled && !hostOff()) {
        if (!W.root) { build(); if (W.synth) loadVoices(); }
        else if (!document.documentElement.contains(W.root)) { document.documentElement.appendChild(W.root); }
      }
      if (location.href === lastHref) return;
      lastHref = location.href;
      try { unlockViewport(); applyZoom(); } catch (_) {} // re-assert zoom for the new page immediately
      // page changed (SPA): reset translation + adapter cache, optionally re-translate
      W.translated = false; W.showingOriginal = false; W.blocks = []; W.txNodes = [];
      W.adapterUrl = null; W.adapterContent = undefined;
      loadGlossary(); // the novel (and thus its glossary) may have changed
      const orig = W.panel && W.panel.querySelector('[data-act="original"]');
      if (orig) { orig.disabled = true; orig.textContent = "Show original"; }
      if (CFG.autoTranslate && !hostOff()) setTimeout(() => translatePage(), 800);
    }, 1200);
  }

  async function init() {
    await loadCfg();
    loadGlossary();
    // Page zoom / pinch-zoom unlock runs on EVERY page, even when the widget UI is disabled.
    try { unlockViewport(); applyZoom(); startZoomWatch(); } catch (_) {}
    if (!CFG.enabled || hostOff()) { watchEnableFlag(); return; } // off globally or on this site
    build();
    if (W.synth) { loadVoices(); W.synth.onvoiceschanged = loadVoices; }
    watchSpaNav();
    watchEnableFlag();
    if (CFG.autoTranslate) setTimeout(() => translatePage(), 600);
    // A multi-chapter download in progress takes priority over a one-off reader reopen.
    const cs = getCrawlState();
    if (cs && cs.captchaPaused) { renderCaptchaPanel(cs.novel, cs.opts); startCaptchaPoll(cs); } // solved → auto-resume
    else if (cs && cs.connPaused) { renderConnPanel(cs); startConnPoll(cs); } // VPN/connection back → auto-resume
    else if (cs && cs.engine === "fetch") crawlFetch(cs.queue, cs.opts, cs.novel); // resume a fetch crawl after a reload
    else if (cs) resumeCrawl();          // nav engine (newtoki/follow)
    else maybeReopenReader();            // resume reader mode after a Prev/Next page navigation
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
      Object.assign(CFG, nv);
      // Recompute against BOTH the global flag and this site's off-list, so toggling either the
      // global switch or the per-site entry (from the popup) mounts/unmounts live.
      const shouldShow = CFG.enabled && !hostOff();
      if (shouldShow && !W.root) {
        build();
        if (W.synth) { loadVoices(); W.synth.onvoiceschanged = loadVoices; }
        watchSpaNav();
      } else if (!shouldShow && W.root) {
        destroy();
      }
    });
  }

  init();
})();
