// newtoki / booktoki adapter (Korean novel aggregator; rotating domains).
//
// Chapter list: the series page /novel/<id> lists 100 chapters per page in
// `div.wr-subject > a[href="/novel/<id>/<episodeId>"]`, newest-first, paginated
// via `?epage=N`. Each title ends with "…-N화" (화 = chapter counter) which is the
// real chapter number — the episodeId in the URL is a DB id, not the number. The
// generic extractor saw only one "chapter" because these hrefs carry no
// chapter/episode keyword, so it fell back to a single-chapter page.
//
// Chapter text: newtoki rebuilt its reader — the prose is NOT in the static HTML.
// A JS viewer reads a `<script id="theme-novel-viewer-data">` blob (novelId,
// episodeId, episodeRef, a signed token) and loads the text from an API behind a
// WASM "adGuard"/ad gate, rendering into `.theme-novel-content` (initially
// "Loading text…"). So a static fetch can't reliably get the body; getChapter is
// best-effort and signals a CaptchaError when the body isn't statically present,
// which drives the existing "open the page / verify" flow.
import { translateAll } from "./translate.js";

function abs(url, base) { try { return new URL(url, base).href; } catch { return url; } }

class CaptchaError extends Error {
  constructor(msg) { super(msg || "Open the chapter page once to load its text"); this.name = "CaptchaError"; }
}

async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { credentials: "include", ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function isDenied(html) {
  return /Access denied \| Cloudflare|Just a moment\.\.\.|cf-browser-verification|Attention Required/i.test(html || "");
}

// "…-1110화 (외전 완결)" -> 1110 ; returns null when there's no 화 number.
function hwaNum(s) {
  const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*화/);
  return m ? parseFloat(m[1]) : null;
}

// Parse one series-list page's chapter anchors into {url,title,no}.
function parseChapterLinks(doc, novelId, baseUrl) {
  const out = [];
  const sel = `div.wr-subject a[href*="/novel/${novelId}/"]`;
  for (const a of doc.querySelectorAll(sel)) {
    const href = a.getAttribute("href") || "";
    if (!new RegExp(`/novel/${novelId}/\\d+`).test(href)) continue;
    const title = (a.textContent || "").replace(/\s+/g, " ").trim();
    out.push({ url: abs(href, baseUrl), title, no: hwaNum(title) });
  }
  return out;
}

// Highest ?epage=N linked on the series page (the chapter list's last page).
function maxEpage(doc) {
  let max = 1;
  for (const a of doc.querySelectorAll('a[href*="epage="]')) {
    const m = (a.getAttribute("href") || "").match(/[?&]epage=(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

export function create() {
  const state = { novelId: null, origin: null, seriesUrl: null };

  return {
    id: "newtoki",
    label: "newtoki / booktoki",

    matches(url) {
      try {
        const h = new URL(url).hostname;
        return /(^|\.)(newtoki|booktoki|manatoki|mantoki)\d*\.[a-z]+$/i.test(h);
      } catch { return false; }
    },

    options() {
      return {
        services: [
          { id: "raw", label: "Original (Korean)" },
          { id: "en", label: "Translate → English" },
        ],
        defaultService: "en",
      };
    },

    async getMeta(url) {
      const res = await fetchT(url, {});
      const html = await res.text();
      if (isDenied(html)) throw new CaptchaError("newtoki is blocking automated access — open the series page once, then retry.");
      const doc = new DOMParser().parseFromString(html, "text/html");

      const idm = url.match(/\/novel\/(\d+)/);
      state.novelId = idm ? idm[1] : null;
      state.origin = (() => { try { return new URL(url).origin; } catch { return ""; } })();
      state.seriesUrl = state.novelId ? `${state.origin}/novel/${state.novelId}` : url;
      if (!state.novelId) throw new Error("Not a newtoki novel page (expected /novel/<id>).");

      const meta = (name) => {
        const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
        return el ? el.getAttribute("content") : null;
      };
      let title = (meta("og:title") || (doc.querySelector(".view-title, .toon-title, h1") || {}).textContent
        || (doc.querySelector("title") || {}).textContent || "Untitled").trim();
      title = title.replace(/\s*-\s*(북토끼|뉴토끼|newtokki|booktoki)\s*(소설)?\s*$/i, "").trim();
      const coverRaw = meta("og:image")
        || (() => { const im = doc.querySelector(".view-img img, .book-img img, img.img-tag"); return im ? (im.getAttribute("src") || im.getAttribute("data-src")) : null; })();
      const cover = coverRaw ? abs(coverRaw, url) : null;
      const description = (meta("og:description") || meta("description") || "").trim();

      // Collect chapters across all ?epage pages (100/page). Always fetch the series
      // list explicitly from page 1 — the analyzed `url` may be a CHAPTER page (which
      // carries no chapter list), so relying on `doc` would silently drop the newest
      // 100 chapters (epage=1). `doc` is used only for title/cover above.
      const byUrl = new Map();
      const addFrom = (d) => { for (const c of parseChapterLinks(d, state.novelId, state.origin)) if (!byUrl.has(c.url)) byUrl.set(c.url, c); };
      // Walk ?epage=1..N. Trust the pager's highest linked page (read from page 1),
      // but keep going a little past it (some pagers show only a sliding window) and
      // stop after two pages add nothing. Hard cap guards a never-terminating pager.
      let detected = 1, emptyStreak = 0;
      for (let p = 1; p <= 1000; p++) {
        let added = 0;
        try {
          const r = await fetchT(`${state.seriesUrl}?epage=${p}`, {});
          const h = await r.text();
          if (!isDenied(h)) {
            const d = new DOMParser().parseFromString(h, "text/html");
            if (p === 1) detected = maxEpage(d);
            const before = byUrl.size;
            addFrom(d);
            added = byUrl.size - before;
          }
        } catch (e) { console.warn("newtoki epage", p, "failed", e); }
        emptyStreak = added === 0 ? emptyStreak + 1 : 0;
        if (p >= detected && emptyStreak >= 2) break;
      }

      // Sort ascending by 화 number when most chapters carry one; else reverse the
      // newest-first page order into oldest-first.
      let chapters = [...byUrl.values()];
      const numbered = chapters.filter((c) => c.no != null).length;
      if (numbered >= chapters.length * 0.6 && chapters.length > 1) {
        chapters.sort((a, b) => (a.no ?? Infinity) - (b.no ?? Infinity));
      } else {
        chapters.reverse();
      }
      chapters = chapters.map((c, i) => ({ no: c.no ?? i + 1, url: c.url, title: c.title || `Chapter ${i + 1}` }));

      return {
        title, author: "Unknown", language: "en", origLang: "ko",
        cover, description, subjects: [], slug: "novel",
        chapterCount: chapters.length, chapters,
      };
    },

    // opts: { service, lang }. Best-effort: works only when the body is present in
    // the fetched HTML; newtoki's token/adGuard viewer usually isn't, so this
    // raises CaptchaError to trigger the existing manual-open flow.
    async getChapter(chapter, opts) {
      const service = (opts && opts.service) || "en";
      const lang = (opts && opts.lang) || "en";
      const res = await fetchT(chapter.url, { headers: {} });
      const html = await res.text();
      if (isDenied(html) || res.status === 403) throw new CaptchaError();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const body = doc.querySelector(".theme-novel-content") || doc.querySelector("#novel_content") || doc.querySelector(".view-content");
      const bodyText = body ? (body.textContent || "").trim() : "";
      if (!body || !bodyText || /Loading text|로딩|불러오는 중/i.test(bodyText)) throw new CaptchaError();

      // Extract text blocks (p / br-separated text) and inline images in order.
      const blocks = [];
      const seen = new Set();
      const pushText = (t) => { const s = (t || "").replace(/\s+/g, " ").trim(); if (s && !seen.has(s)) { seen.add(s); blocks.push({ type: "text", text: s }); } };
      const ps = body.querySelectorAll("p");
      if (ps.length) {
        ps.forEach((p) => { p.querySelectorAll("img").forEach((im) => { const s = im.getAttribute("src") || im.getAttribute("data-src"); if (s) blocks.push({ type: "image", url: abs(s, chapter.url) }); }); pushText(p.textContent); });
      } else {
        body.querySelectorAll("img").forEach((im) => { const s = im.getAttribute("src") || im.getAttribute("data-src"); if (s) blocks.push({ type: "image", url: abs(s, chapter.url) }); });
        (body.innerText || body.textContent || "").split(/\n+/).forEach(pushText);
      }
      if (!blocks.some((b) => b.type === "text")) throw new CaptchaError();

      let title = chapter.title;
      const h = doc.querySelector(".theme-novel-title, .view-title, h1");
      if ((!title || /^https?:/.test(title)) && h) title = (h.textContent || "").trim();

      if (service === "en") {
        const idxs = [], texts = [];
        blocks.forEach((b, i) => { if (b.type === "text" && b.text) { idxs.push(i); texts.push(b.text); } });
        if (texts.length) {
          try { const out = await translateAll(texts, lang, "ko"); idxs.forEach((bi, k) => { if (out[k]) blocks[bi].text = out[k]; }); } catch (e) { console.warn("newtoki translate failed", e); }
        }
        if (title) { try { title = (await translateAll([title], lang, "ko"))[0] || title; } catch {} }
      }
      return { title: title || `Chapter ${chapter.no}`, blocks };
    },
  };
}
