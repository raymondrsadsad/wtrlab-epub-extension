// Shared Google translateHtml helper (used by the wtr-lab and generic adapters).
const TRANSLATE = "https://translate-pa.googleapis.com/v1/translateHtml";
const GKEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
// Keyless fallback endpoint (the classic web-translate API). Used only when the primary
// translateHtml endpoint above fails (outage / rate-limit / revoked key), so translation
// keeps working with no key and nothing to maintain.
const GTX = "https://translate.googleapis.com/translate_a/single";

// Transient failures are common with the free Google endpoint: it intermittently returns
// 502/503 and the network sometimes drops the request ("Failed to fetch"). Retry a few
// times with exponential backoff + jitter before giving up, so a blip doesn't fail the
// whole page (or an auto-translated chapter). Non-transient errors (4xx) return/throw at once.
function isTransientStatus(s) { return s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599); }
async function fetchT(url, opts = {}, ms = 30000, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      if (res.ok || !isTransientStatus(res.status) || attempt === tries - 1) return res;
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;                       // network error / abort (timeout)
      if (attempt === tries - 1) throw e;
    } finally {
      clearTimeout(t);
    }
    await new Promise((r) => setTimeout(r, 600 * (2 ** attempt) + Math.random() * 300));
  }
  throw lastErr;
}

// HTML entity decode (google translateHtml returns &#39; etc.). Uses a <textarea>
// in a DOM context (popup / content script); falls back to a small pure-JS decoder
// in the service worker, where `document` doesn't exist.
let _decoderEl = null;
const _NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const v = _NAMED[body.toLowerCase()];
    return v != null ? v : m;
  });
}
export function htmlUnescape(s) {
  if (!s || s.indexOf("&") === -1) return s;
  if (typeof document !== "undefined") {
    if (!_decoderEl) _decoderEl = document.createElement("textarea");
    _decoderEl.innerHTML = s;
    return _decoderEl.value;
  }
  return decodeEntities(s);
}

// When imported into a content script (which can't call the Google endpoint cross-
// origin under MV3), the widget sets globalThis.__WR_TX_VIA_SW so every batch is
// relayed to the service worker, which has the extension's host permissions. In the
// popup and the service worker the flag is unset and we fetch Google directly.
function swTranslateBatch(paras, to, from) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: "TRANSLATE_RAW", texts: paras, to, from }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "translate failed"));
        resolve(resp.out || paras);
      });
    } catch (e) { reject(e); }
  });
}

// ---------- glossary / term-lock ----------
// User-defined source→target replacements applied AFTER translation, so machine-
// translated names/terms stay consistent (乾→Qian, 魔法→magic, …). The active set is
// held per JS context and applied in translateBatch, so every path benefits: EPUB
// packing, title/metadata translation, the reader and the on-site widget. Purely local
// string work — no network, nothing to maintain.
let _glossary = [];
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function applyGlossary(text, pairs) {
  const g = pairs || _glossary;
  if (!text || !g || !g.length) return text;
  let out = text;
  for (const p of g) {
    if (!p || !p.from) continue;
    try { out = out.replace(new RegExp(escapeRegex(p.from), "g"), () => p.to != null ? p.to : ""); }
    catch (_) { /* skip a bad entry */ }
  }
  return out;
}
// Set the active glossary (array of {from,to}); longest source first so a longer term
// wins over a substring of it.
export function setGlossary(pairs) {
  _glossary = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && p.from)
    .map((p) => ({ from: String(p.from), to: String(p.to == null ? "" : p.to) }))
    .sort((a, b) => b.from.length - a.from.length);
}

// ---------- translation engine (optional) ----------
// Default is the free Google endpoint (no key). A user may instead configure DeepL or
// any OpenAI-compatible endpoint (stored in chrome.storage "txEngine"); on ANY error we
// fall back to Google, so a bad key or a provider change never breaks translation and
// there's nothing to keep maintained. `<all_urls>` host permission already covers any
// endpoint. The config is read in every context (popup, reader, service worker), so the
// packer, the reader and the on-site widget (which relays through the SW) all honour it.
let _engine = { mode: "google" };
(function initEngine() {
  try {
    const st = (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null;
    if (!st) return;
    st.get("txEngine", (o) => { if (o && o.txEngine) _engine = o.txEngine; });
    if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.txEngine) _engine = c.txEngine.newValue || { mode: "google" };
    });
  } catch (_) { /* ignore */ }
})();

const LANG_NAMES = { en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", ru: "Russian", ja: "Japanese", ko: "Korean", "zh-cn": "Chinese (Simplified)", zh: "Chinese", id: "Indonesian", vi: "Vietnamese", ar: "Arabic", hi: "Hindi", tl: "Filipino" };
function langLabel(to) { return LANG_NAMES[String(to || "en").toLowerCase()] || to || "English"; }
function deeplLang(to) { const u = String(to || "en").toUpperCase(); if (u.startsWith("EN")) return "EN-US"; if (u.startsWith("PT")) return "PT-PT"; if (u.startsWith("ZH")) return "ZH"; return u.split("-")[0]; }
function parseJsonArray(s) {
  try { const v = JSON.parse(s); if (Array.isArray(v)) return v; if (v && Array.isArray(v.translations)) return v.translations; } catch (_) {}
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a >= 0 && b > a) { try { const v = JSON.parse(s.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (_) {} }
  return null;
}

// The Google key and endpoint are replaceable config: a user can override the baked-in key
// (or point at a proxy) via txEngine.gkey / txEngine.gendpoint, so a revoked default key is
// recoverable without a new build. Empty overrides fall back to the constants above.
function googleKey() { const k = _engine && _engine.gkey && String(_engine.gkey).trim(); return k || GKEY; }
function googleEndpoint() { const e = _engine && _engine.gendpoint && String(_engine.gendpoint).trim(); return e || TRANSLATE; }

// Primary Google engine: the protobuf translateHtml endpoint (batch, keyed).
async function googleHtml(paras, to, from) {
  const res = await fetchT(googleEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json+protobuf", "X-Goog-API-Key": googleKey() },
    body: JSON.stringify([[paras, from, to], "te_lib"]),
  });
  if (!res.ok) throw new Error("translate HTTP " + res.status);
  const j = await res.json();
  const list = Array.isArray(j) && Array.isArray(j[0]) ? j[0] : null;
  if (list && list.length === paras.length) return list.map(htmlUnescape);
  // fallback: one at a time to preserve alignment
  if (paras.length > 1) {
    const out = [];
    for (const p of paras) out.push((await googleHtml([p], to, from))[0]);
    return out;
  }
  return list ? list.map(htmlUnescape) : paras;
}

// Parse the keyless gtx endpoint's response: [ [ [translated, orig, …], … ], … ].
// The first element is the array of sentence segments; join their translated halves.
export function parseGtx(j) {
  if (!Array.isArray(j) || !Array.isArray(j[0])) return null;
  return j[0].map((seg) => (Array.isArray(seg) && seg[0] != null ? seg[0] : "")).join("");
}

// Keyless fallback engine (one request per string; returns plain text, not HTML-escaped).
async function googleGtx(paras, to, from) {
  const out = [];
  for (const p of paras) {
    const u = GTX + "?client=gtx&dt=t&sl=" + encodeURIComponent(from || "auto") +
      "&tl=" + encodeURIComponent(to || "en") + "&q=" + encodeURIComponent(p);
    const res = await fetchT(u, { method: "GET" });
    if (!res.ok) throw new Error("gtx HTTP " + res.status);
    const t = parseGtx(await res.json());
    out.push(t == null ? p : t);
  }
  return out;
}

// Default engine with a fallback chain: try the primary translateHtml endpoint, and only if
// it fails (outage / rate-limit / bad key) drop to the keyless gtx endpoint. On both failing,
// surface the primary error so callers see the real status (e.g. "translate HTTP 502").
async function translateGoogle(paras, to, from) {
  try { return await googleHtml(paras, to, from); }
  catch (e) {
    try { return await googleGtx(paras, to, from); }
    catch (_) { throw e; }
  }
}

async function translateDeepL(paras, to) {
  const key = (_engine.key || "").trim();
  if (!key) throw new Error("no DeepL key");
  const endpoint = (_engine.endpoint || "").trim() || "https://api-free.deepl.com/v2/translate";
  const body = new URLSearchParams();
  for (const p of paras) body.append("text", p);
  body.append("target_lang", deeplLang(to));
  const res = await fetchT(endpoint, { method: "POST", headers: { "Authorization": "DeepL-Auth-Key " + key, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error("DeepL HTTP " + res.status);
  const j = await res.json();
  const arr = j && Array.isArray(j.translations) ? j.translations.map((t) => t.text) : null;
  if (!arr) throw new Error("DeepL bad response");
  return arr;
}

async function translateOpenAI(paras, to) {
  const key = (_engine.key || "").trim();
  if (!key) throw new Error("no API key");
  const endpoint = (_engine.endpoint || "").trim() || "https://api.openai.com/v1/chat/completions";
  const model = (_engine.model || "").trim() || "gpt-4o-mini";
  const sys = `You are a translation engine. Translate each string in the given JSON array into ${langLabel(to)}. Keep meaning, names and order. Return ONLY a JSON array of exactly the same length, nothing else.`;
  const res = await fetchT(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(paras) }] }),
  }, 60000);
  if (!res.ok) throw new Error("LLM HTTP " + res.status);
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error("LLM empty response");
  const arr = parseJsonArray(content);
  if (!Array.isArray(arr)) throw new Error("LLM non-array response");
  return arr.map((x) => String(x == null ? "" : x));
}

// Dispatch to the configured engine (no cache, no glossary). Custom engines fall back to
// Google on any failure so a bad key never breaks translation.
async function engineTranslate(paras, to, from) {
  const mode = _engine && _engine.mode;
  if (mode === "deepl" || mode === "openai") {
    try {
      const out = mode === "deepl" ? await translateDeepL(paras, to) : await translateOpenAI(paras, to);
      if (Array.isArray(out) && out.length === paras.length) return out.map(htmlUnescape);
      throw new Error(`engine returned ${out ? out.length : "null"}/${paras.length}`);
    } catch (e) { console.warn("[translate] custom engine failed — using Google:", (e && e.message) || e); }
  }
  return translateGoogle(paras, to, from);
}

// ---------- translation cache ----------
// Per-string memo so re-visiting or re-toggling a chapter doesn't re-hit the network (which is
// also what provoked the 502s under load). Keyed by engine mode + from + to + the RAW source
// text (pre-glossary, so glossary edits never invalidate it). LRU-capped and persisted to
// chrome.storage.local "txCache" (unlimitedStorage is granted). The cache lives wherever the
// real fetch happens — the service worker for the widget, or the popup/reader directly.
const CACHE_MAX = 5000;
export function memoKey(mode, from, to, text) {
  return (mode || "google") + "\u0001" + (from || "auto") + "\u0001" + (to || "en") + "\u0001" + text;
}
// Small LRU as a factory so the self-test can exercise it in isolation.
export function makeMemo(max = CACHE_MAX) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
    entries() { return [...m.entries()]; },
    load(pairs) { if (Array.isArray(pairs)) for (const kv of pairs) if (Array.isArray(kv) && kv.length === 2) this.set(kv[0], kv[1]); },
    clear() { m.clear(); },
  };
}
const _cache = makeMemo();
let _cacheLoaded = false, _cacheDirty = false, _flushTimer = null;
function _txStore() { try { return (typeof chrome !== "undefined" && chrome.storage) ? chrome.storage.local : null; } catch (_) { return null; } }
function loadCache() {
  if (_cacheLoaded) return Promise.resolve();
  _cacheLoaded = true;
  return new Promise((res) => {
    const st = _txStore(); if (!st) return res();
    try { st.get("txCache", (o) => { try { _cache.load(o && o.txCache); } catch (_) {} res(); }); }
    catch (_) { res(); }
  });
}
function flushCache() {
  _flushTimer = null;
  if (!_cacheDirty) return;
  _cacheDirty = false;
  const st = _txStore(); if (!st) return;
  try { st.set({ txCache: _cache.entries() }); } catch (_) {}
}
function scheduleFlush() {
  _cacheDirty = true;
  if (_flushTimer) return;
  _flushTimer = setTimeout(flushCache, 2000);
}
export function clearCache() {
  _cache.clear(); _cacheDirty = false;
  const st = _txStore(); if (st) { try { st.set({ txCache: [] }); } catch (_) {} }
}

// Raw translation (no glossary): SW relay when inside a content script, otherwise a cache-first
// engine call — only the uncached strings are sent to the network, in order.
async function translateBatchRaw(paras, to, from) {
  if (typeof globalThis !== "undefined" && globalThis.__WR_TX_VIA_SW) return swTranslateBatch(paras, to, from);
  await loadCache();
  const mode = (_engine && _engine.mode) || "google";
  const out = new Array(paras.length);
  const missIdx = [], missTexts = [];
  for (let i = 0; i < paras.length; i++) {
    const hit = _cache.get(memoKey(mode, from, to, paras[i]));
    if (hit !== undefined) out[i] = hit;
    else { missIdx.push(i); missTexts.push(paras[i]); }
  }
  if (missTexts.length) {
    const got = await engineTranslate(missTexts, to, from);
    for (let j = 0; j < missIdx.length; j++) {
      const v = got[j];
      out[missIdx[j]] = v == null ? missTexts[j] : v;
      // Don't cache a no-op (engine returned the source unchanged — usually a failure path);
      // caching it would poison the memo with untranslated text.
      if (v != null && v !== missTexts[j]) _cache.set(memoKey(mode, from, to, missTexts[j]), v);
    }
    scheduleFlush();
  }
  return out;
}

export async function translateBatch(paras, to, from) {
  const out = await translateBatchRaw(paras, to, from);
  return _glossary.length ? out.map((t) => applyGlossary(t, _glossary)) : out;
}

// from "auto" lets Google detect the source language (used by the generic adapter).
export async function translateAll(paras, to = "en", from = "zh-CN", batchChars = 4000) {
  const out = [];
  let i = 0;
  while (i < paras.length) {
    const batch = [];
    let size = 0;
    while (i < paras.length && (batch.length === 0 || size + paras[i].length <= batchChars)) {
      batch.push(paras[i]); size += paras[i].length + 1; i++;
    }
    const r = await translateBatch(batch, to, from);
    for (const x of r) out.push(x);
  }
  return out;
}
