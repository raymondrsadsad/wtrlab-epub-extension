// Generic best-effort adapter for any other site.
// Extracts the main content container's paragraphs + images; optionally
// translates the text to English. Chapter list: collects "chapter"-looking
// links, sorts them by detected number, otherwise treats the URL as one chapter.
import { translateAll } from "./translate.js";

function abs(url, base) { try { return new URL(url, base).href; } catch { return url; } }

// Shared CAPTCHA signal so the existing pause/auto-resume UI works for any site.
function captchaError() { const e = new Error("Verification required"); e.name = "CaptchaError"; return e; }
function isChallenge(status, html) {
  if (status === 403 || status === 503 || status === 429) {
    if (/cloudflare|cf-|challenge|captcha|just a moment/i.test(html || "")) return true;
  }
  return /Just a moment\.\.\.|cf-mitigated|cf-challenge|cf-browser-verification|challenge-platform|Attention Required! \| Cloudflare/i.test(html || "");
}
async function fetchDoc(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();
  if (isChallenge(res.status, html)) throw captchaError();
  if (!res.ok && !html) throw new Error("HTTP " + res.status);
  return new DOMParser().parseFromString(html, "text/html");
}

// Detected chapter number from an href or link text (chapter-12, /c12, ep 12, …).
function chapNum(s) {
  if (!s) return null;
  const m = String(s).match(/(?:chapter|chap|episode|\bep|\bch|\bc|\/c)[\s._/-]*?(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  const nums = String(s).match(/\d+(?:\.\d+)?/g);
  return nums ? parseFloat(nums[nums.length - 1]) : null;
}

function pickContent(doc) {
  const bad = /(^|\s|-|_)(nav|footer|header|comment|sidebar|menu|share|advert|ads?|related|recommend|breadcrumb)(\s|$|-|_)/i;
  const cands = Array.from(
    doc.querySelectorAll("article, main, [class*=content], [class*=chapter], [id*=content], [id*=chapter], .entry-content, .post-content, .reading-content, .text-content")
  );
  if (doc.body) cands.push(doc.body);
  let best = null, bestScore = 0;
  for (const el of cands) {
    const cls = (el.className || "") + " " + (el.id || "");
    if (bad.test(cls)) continue;
    const ps = el.querySelectorAll("p");
    let textLen = 0;
    ps.forEach((p) => (textLen += (p.textContent || "").trim().length));
    if (!ps.length) textLen = (el.textContent || "").trim().length * 0.2;
    // penalise link-heavy containers (navs, TOCs, related lists)
    const linkText = Array.from(el.querySelectorAll("a")).reduce((n, a) => n + (a.textContent || "").length, 0);
    const total = (el.textContent || "").length || 1;
    const linkDensity = linkText / total;
    const score = textLen * (1 - Math.min(linkDensity, 0.95));
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best || doc.body;
}

function imgSrc(el) {
  return el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-original") ||
    el.getAttribute("data-lazy-src") || (el.getAttribute("srcset") || "").split(" ")[0] || "";
}

function extractBlocks(container, baseUrl) {
  const blocks = [];
  const seen = new Set();
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (/(script|style|nav|footer|header|form|noscript|aside)/.test(tag)) continue;
        if (tag === "img") {
          const src = imgSrc(child);
          if (src) blocks.push({ type: "image", url: abs(src, baseUrl) });
          continue;
        }
        if (tag === "p" || tag === "blockquote") {
          const t = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (t && !seen.has(t)) { seen.add(t); blocks.push({ type: "text", text: t }); }
          child.querySelectorAll("img").forEach((im) => {
            const src = imgSrc(im);
            if (src) blocks.push({ type: "image", url: abs(src, baseUrl) });
          });
          continue;
        }
        walk(child);
      }
    }
  };
  walk(container);
  if (!blocks.some((b) => b.type === "text")) {
    const text = (container.textContent || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const t of text) blocks.push({ type: "text", text: t });
  }
  return blocks;
}

export function create() {
  return {
    id: "generic",
    label: "Generic",
    matches() { return true; },
    options() {
      return {
        services: [
          { id: "raw", label: "Original" },
          { id: "en", label: "Translate → English" },
        ],
        defaultService: "raw",
      };
    },

    async getMeta(url) {
      const doc = await fetchDoc(url);
      const meta = (name) => {
        const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
        return el ? el.getAttribute("content") : null;
      };
      const title = (meta("og:title") || (doc.querySelector("title") || {}).textContent || "Untitled").trim();
      const author = meta("author") || meta("book:author") || "Unknown";

      // Cover: prefer a real cover <img> over an OG-card generator endpoint
      // (e.g. /api/og/…), which many sites use for social previews.
      const isGenerated = (u) => /\/(api\/)?og(\/|\?|$)|opengraph|\/og-image/i.test(u || "");
      let imgCover = null;
      for (const im of doc.querySelectorAll("img")) {
        const hint = ((im.getAttribute("alt") || "") + " " + (im.className || "") + " " + (im.id || "")).toLowerCase();
        if (/cover|poster|thumbnail|thumb|book-?img|novel-?img/.test(hint)) {
          const s = imgSrc(im);
          if (s && !/\.svg($|\?)/i.test(s)) { imgCover = s; break; }
        }
      }
      const og = meta("og:image") || meta("twitter:image");
      const linkSrc = (() => { const l = doc.querySelector('link[rel="image_src"]'); return l ? l.getAttribute("href") : null; })();
      const coverRaw = imgCover || linkSrc || (og && !isGenerated(og) ? og : null) || og;
      const cover = coverRaw ? abs(coverRaw, url) : null;
      const description = (meta("og:description") || meta("description") || "").trim();
      const kw = meta("keywords") || "";
      const subjects = kw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);

      // Detect the source language for a correct EPUB tag on "Original" (raw)
      // downloads. Kept SEPARATE from `language` (which stays "en") so it never
      // repoints the translation target — the popup only uses it for the tag.
      const clEl = doc.querySelector('meta[http-equiv="content-language" i]');
      const langRaw = (doc.documentElement && doc.documentElement.getAttribute("lang"))
        || meta("og:locale") || (clEl && clEl.getAttribute("content")) || "";
      const origLang = (String(langRaw).trim().toLowerCase().split(/[_-]/)[0].match(/^[a-z]{2,3}$/) || [null])[0];

      // collect chapter links (same-origin, chapter-like href), dedupe by href
      const pageOrigin = (() => { try { return new URL(url).origin; } catch { return ""; } })();
      const links = Array.from(doc.querySelectorAll("a[href]"));
      const cands = [];
      const seen = new Set();
      for (const a of links) {
        const href = abs(a.getAttribute("href"), url);
        if (!/^https?:/i.test(href)) continue;
        if (pageOrigin && !href.startsWith(pageOrigin)) continue;
        if (!/(chapter|\/ch(-|\/|\d)|\/c\d+|episode|\/read\/|-ch\d)/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        cands.push({ url: href, title: text || href, path: (() => { try { return new URL(href).pathname; } catch { return href; } })() });
      }

      // keep the majority path-prefix group (drops unrelated / related-novel links)
      let group = cands;
      if (cands.length > 3) {
        const counts = {};
        for (const c of cands) {
          const seg = c.path.split("/").filter(Boolean).slice(0, 2).join("/");
          counts[seg] = (counts[seg] || 0) + 1;
        }
        const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        const filtered = cands.filter((c) => c.path.split("/").filter(Boolean).slice(0, 2).join("/") === top);
        if (filtered.length >= Math.max(3, cands.length * 0.4)) group = filtered;
      }

      // number + sort ascending when most links carry a chapter number
      let withNo = group.map((c) => ({ ...c, no: chapNum(c.url) ?? chapNum(c.title) }));
      const numbered = withNo.filter((c) => c.no != null).length;
      if (numbered >= group.length * 0.6 && group.length > 1) {
        const byNo = new Map();
        for (const c of withNo) if (c.no != null && !byNo.has(c.no)) byNo.set(c.no, c);
        withNo = [...byNo.values()].sort((a, b) => a.no - b.no);
      }

      const chapters = withNo.length
        ? withNo.map((c) => ({ url: c.url, title: c.title }))
        : [{ url, title: title || "Chapter 1" }];

      return { title, author, language: "en", origLang, cover, description, subjects, slug: "novel", chapterCount: chapters.length, chapters };
    },

    // opts: { service, lang }
    async getChapter(chapter, opts) {
      const service = (opts && opts.service) || "raw";
      const lang = (opts && opts.lang) || "en";
      const doc = await fetchDoc(chapter.url);
      const container = pickContent(doc);
      const blocks = extractBlocks(container, chapter.url);

      let title = chapter.title;
      const h = doc.querySelector("h1, h2");
      if ((!title || /^https?:/.test(title)) && h) title = (h.textContent || "").trim();

      if (service === "en") {
        const idxs = [], texts = [];
        blocks.forEach((b, i) => { if (b.type === "text" && b.text) { idxs.push(i); texts.push(b.text); } });
        if (texts.length) {
          try {
            const out = await translateAll(texts, lang, "auto");
            idxs.forEach((bi, k) => { if (out[k]) blocks[bi].text = out[k]; });
          } catch (e) { console.warn("generic translate failed", e); }
        }
        if (title) { try { title = (await translateAll([title], lang, "auto"))[0] || title; } catch {} }
      }

      return { title: title || "Chapter", blocks };
    },
  };
}
