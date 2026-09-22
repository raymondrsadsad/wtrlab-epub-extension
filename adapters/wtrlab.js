// wtr-lab.com adapter: full support for Web / Web+ / AI, exact illustrations.
const API = "https://wtr-lab.com/api/reader/get";
const TERMS = (id) => `https://wtr-lab.com/api/v2/reader/terms/${id}.json`;
const TRANSLATE = "https://translate-pa.googleapis.com/v1/translateHtml";
const GKEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const DEC_KEY = "IJAFUUxjM25hyzL2AZrn0wl7cESED6Ru";
const IMG_RE = /^\s*\[\s*image\s*\]\s*$/i;

const te = new TextEncoder();
const td = new TextDecoder();
function b64ToBytes(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

let _decKey = null;
async function decKey() {
  if (!_decKey) _decKey = await crypto.subtle.importKey("raw", te.encode(DEC_KEY), { name: "AES-GCM" }, false, ["decrypt"]);
  return _decKey;
}
async function decryptBody(body) {
  if (typeof body !== "string") return body;
  const isArr = body.startsWith("arr:");
  const rest = isArr || body.startsWith("str:") ? body.slice(4) : body;
  const [s, n, a] = rest.split(":");
  const iv = b64ToBytes(s), tag = b64ToBytes(n), ct = b64ToBytes(a);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await decKey(), combined);
  const txt = td.decode(pt);
  return isArr ? JSON.parse(txt) : txt;
}

// HTML entity decode (google translateHtml returns &#39; etc.)
let _decoderEl = null;
function htmlUnescape(s) {
  if (!s || s.indexOf("&") === -1) return s;
  if (!_decoderEl) _decoderEl = document.createElement("textarea");
  _decoderEl.innerHTML = s;
  return _decoderEl.value;
}

async function translateBatch(paras, to, from) {
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
    for (const p of paras) out.push((await translateBatch([p], to, from))[0]);
    return out;
  }
  return list ? list.map(htmlUnescape) : paras;
}
async function translateAll(paras, to = "en", from = "zh-CN", batchChars = 4000) {
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

function resolveAi(paras, glossaryData) {
  const terms = (glossaryData && glossaryData.terms) || [];
  return paras.map((p) =>
    p.replace(/※(\d+)[⛬〓]/g, (m, n) => {
      const t = terms[+n];
      return t && t[0] != null ? String(t[0]).replace(/_/g, "") : m;
    })
  );
}
function applyGlossary(paras, terms) {
  if (!terms.length) return paras;
  return paras.map((p) => {
    let s = p;
    for (const [zh, en] of terms) if (s.indexOf(zh) !== -1) s = s.split(zh).join(en);
    return s;
  });
}

class CaptchaError extends Error {
  constructor() { super("Turnstile challenge required"); this.name = "CaptchaError"; }
}

// Fetch real chapter titles from wtr-lab's own chapter-list API so the tool can
// list "#1 Douluo Diary: Bibi Dong Breaks Down" instead of a fabricated
// "Chapter 1". The endpoint keys on the numeric id in the /novel/<id>/ URL
// (distinct from raw_id) and returns { chapters: [{ order, title }, …] }.
// Returns Map<order, title>, or null on any failure (→ generic titles).
async function fetchChapterTitles(novelId) {
  if (!novelId) return null;
  try {
    const r = await fetchT(`https://wtr-lab.com/api/chapters/${novelId}`, { credentials: "include" });
    if (!r.ok) return null;
    const j = await r.json();
    const list = j && Array.isArray(j.chapters) ? j.chapters : null;
    if (!list || !list.length) return null;
    const map = new Map();
    for (const c of list) {
      const no = typeof c.order === "number" ? c.order
        : (typeof c.order === "string" && /^\d+$/.test(c.order) ? +c.order : null);
      const title = c && c.title != null ? String(c.title).trim() : "";
      if (no != null && title) map.set(no, title);
    }
    return map.size ? map : null;
  } catch (e) {
    console.warn("chapter titles fetch failed", e);
    return null;
  }
}

// Combine a chapter number with its real title, avoiding a doubled number when
// the stored title already begins with "Chapter N" or "N".
function labelFor(no, title) {
  if (!title) return `Chapter ${no}`;
  const cleaned = title.replace(new RegExp(`^\\s*(chapter\\s*)?${no}\\b[\\s:.\\-]*`, "i"), "").trim();
  return cleaned ? `#${no} ${cleaned}` : `#${no} ${title}`;
}

export function create() {
  const state = { rawId: null, slug: null, glossary: null };

  async function loadGlossary() {
    if (state.glossary) return state.glossary;
    const terms = [];
    try {
      const r = await fetchT(TERMS(state.rawId), { credentials: "include" });
      const j = await r.json();
      if (j && j.success && Array.isArray(j.glossaries)) {
        for (const g of j.glossaries) {
          const ts = (g && g.data && g.data.terms) || [];
          for (const t of ts) {
            const en = Array.isArray(t[0]) ? t[0][0] : t[0];
            const zh = t[1];
            if (zh && en) terms.push([zh, en]);
          }
        }
      }
    } catch (e) { console.warn("glossary load failed", e); }
    terms.sort((a, b) => b[0].length - a[0].length);
    state.glossary = terms;
    return terms;
  }

  return {
    id: "wtrlab",
    label: "wtr-lab",

    matches(url) {
      try { return new URL(url).hostname.endsWith("wtr-lab.com"); } catch { return false; }
    },

    options() {
      return {
        services: [
          { id: "web", label: "Web" },
          { id: "webplus", label: "Web+" },
          { id: "ai", label: "AI" },
        ],
        defaultService: "webplus",
      };
    },

    async getMeta(url) {
      const res = await fetchT(url, { credentials: "include" });
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error("Not a wtr-lab novel page (no __NEXT_DATA__).");
      const data = JSON.parse(m[1]);
      const sd = data.props.pageProps.serie.serie_data;
      state.rawId = sd.raw_id;
      state.slug = sd.slug;
      const count = sd.chapter_count;
      // The chapter-list API and reader URLs key on the /novel/<id>/ segment
      // (not raw_id). Capture the id, language and slug so we can build a real
      // reader URL for each chapter (used by the CAPTCHA "Open page" button).
      const idm = url.match(/\/novel\/(\d+)/);
      const langm = url.match(/wtr-lab\.com\/([a-z]{2})\//i);
      const novelId = idm ? idm[1] : null;
      const lang = langm ? langm[1] : "en";
      const slug = sd.slug;
      const readerUrl = (no) =>
        novelId ? `https://wtr-lab.com/${lang}/novel/${novelId}/${slug}/chapter-${no}` : null;
      const titleMap = await fetchChapterTitles(novelId); // Map<no,title>|null
      const chapters = [];
      for (let n = 1; n <= count; n++) {
        chapters.push({ no: n, url: readerUrl(n), title: labelFor(n, titleMap && titleMap.get(n)) });
      }
      return {
        title: sd.data.title,
        author: sd.data.author || sd.author || "Unknown",
        language: "en",
        cover: sd.data.image || null,
        slug: sd.slug,
        chapters,
      };
    },

    // opts: { service, lang }
    async getChapter(chapter, opts) {
      const service = opts.service || "webplus";
      const lang = opts.lang || "en";
      const res = await fetchT(API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ raw_id: state.rawId, chapter_no: chapter.no, translate: service }),
      });
      const d = await res.json();
      if (!d.success) {
        if (d.requireTurnstile) throw new CaptchaError();
        throw new Error(d.error || "Chapter fetch failed");
      }
      const inner = d.data.data;
      const paras = await decryptBody(inner.body);
      const images = Array.isArray(inner.images) ? inner.images : [];

      // split into text vs image markers, preserving order
      const slots = []; // {kind:'text', i} or {kind:'image', url}
      const textItems = [];
      let imgIdx = 0;
      for (const p of paras) {
        const s = typeof p === "string" ? p : JSON.stringify(p);
        if (IMG_RE.test(s)) {
          slots.push({ kind: "image", url: images[imgIdx] || null });
          imgIdx++;
        } else {
          slots.push({ kind: "text", i: textItems.length });
          textItems.push(s);
        }
      }

      // transform text per mode
      let outText;
      if (service === "ai") {
        outText = resolveAi(textItems, inner.glossary_data);
      } else if (service === "webplus") {
        outText = await translateAll(applyGlossary(textItems, await loadGlossary()), lang);
      } else {
        outText = await translateAll(textItems, lang);
      }

      // chapter title
      let title = inner.title || `Chapter ${chapter.no}`;
      if (service !== "ai" && /[一-鿿]/.test(title)) {
        try { title = (await translateAll([title], lang))[0]; } catch {}
      }

      // reassemble blocks
      const blocks = [];
      for (const slot of slots) {
        if (slot.kind === "image") {
          if (slot.url) blocks.push({ type: "image", url: slot.url });
        } else {
          const t = outText[slot.i];
          if (t && t.trim()) blocks.push({ type: "text", text: t });
        }
      }
      return { title: `#${chapter.no} ${title}`.trim(), blocks };
    },
  };
}
