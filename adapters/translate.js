// Shared Google translateHtml helper (used by the wtr-lab and generic adapters).
const TRANSLATE = "https://translate-pa.googleapis.com/v1/translateHtml";
const GKEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";

async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
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

async function translateGoogle(paras, to, from) {
  const res = await fetchT(TRANSLATE, {
    method: "POST",
    headers: { "content-type": "application/json+protobuf", "X-Goog-API-Key": GKEY },
    body: JSON.stringify([[paras, from, to], "te_lib"]),
  });
  if (!res.ok) throw new Error("translate HTTP " + res.status);
  const j = await res.json();
  const list = Array.isArray(j) && Array.isArray(j[0]) ? j[0] : null;
  if (list && list.length === paras.length) return list.map(htmlUnescape);
  // fallback: one at a time to preserve alignment
  if (paras.length > 1) {
    const out = [];
    for (const p of paras) out.push((await translateGoogle([p], to, from))[0]);
    return out;
  }
  return list ? list.map(htmlUnescape) : paras;
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

// Raw translation (no glossary): configured engine, or relay to the service worker when
// running inside a content script. Custom engines fall back to Google on any failure.
async function translateBatchRaw(paras, to, from) {
  if (typeof globalThis !== "undefined" && globalThis.__WR_TX_VIA_SW) return swTranslateBatch(paras, to, from);
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
