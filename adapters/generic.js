// Generic best-effort adapter for any other site.
// Extracts the main content container's paragraphs + images, text saved as-is.
// Chapter list: collects "chapter"-looking links from the page (document order),
// otherwise treats the given URL as a single chapter.

function abs(url, base) { try { return new URL(url, base).href; } catch { return url; } }

function pickContent(doc) {
  const bad = /(^|\s)(nav|footer|header|comment|sidebar|menu|share|advert|ads?)(\s|$)/i;
  const cands = Array.from(
    doc.querySelectorAll("article, main, [class*=content], [class*=chapter], [id*=content], [id*=chapter], .entry-content, .post-content, .reading-content")
  );
  if (doc.body) cands.push(doc.body);
  let best = null, bestScore = 0;
  for (const el of cands) {
    const cls = (el.className || "") + " " + (el.id || "");
    if (bad.test(cls)) continue;
    const ps = el.querySelectorAll("p");
    let score = 0;
    ps.forEach((p) => (score += (p.textContent || "").trim().length));
    if (!ps.length) score = (el.textContent || "").trim().length * 0.2;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best || doc.body;
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
          const src = child.getAttribute("src") || child.getAttribute("data-src") ||
            (child.getAttribute("srcset") || "").split(" ")[0];
          if (src) blocks.push({ type: "image", url: abs(src, baseUrl) });
          continue;
        }
        if (tag === "p" || tag === "blockquote") {
          const t = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (t && !seen.has(t)) { seen.add(t); blocks.push({ type: "text", text: t }); }
          // still descend for imgs inside p
          child.querySelectorAll("img").forEach((im) => {
            const src = im.getAttribute("src") || im.getAttribute("data-src");
            if (src) blocks.push({ type: "image", url: abs(src, baseUrl) });
          });
          continue;
        }
        walk(child);
      }
    }
  };
  walk(container);
  // fallback: if no <p> found, split text by newlines
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
    options() { return { services: [], defaultService: null }; },

    async getMeta(url) {
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const meta = (name) => {
        const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
        return el ? el.getAttribute("content") : null;
      };
      const title = meta("og:title") || (doc.querySelector("title") || {}).textContent || "Untitled";
      const cover = meta("og:image");
      const author = meta("author") || meta("book:author") || "Unknown";

      // collect chapter links in document order
      const links = Array.from(doc.querySelectorAll("a[href]"));
      const chLinks = [];
      const seen = new Set();
      for (const a of links) {
        const href = abs(a.getAttribute("href"), url);
        if (!/^https?:/i.test(href)) continue;
        if (!/(chapter|\/ch(-|\/|\d)|\/c\d+|episode|\/read\/)/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        chLinks.push({ url: href, title: (a.textContent || "").replace(/\s+/g, " ").trim() || href });
      }
      const chapters = chLinks.length
        ? chLinks
        : [{ url, title: (title || "").trim() || "Chapter 1" }];

      return { title: title.trim(), author, language: "en", cover, slug: "novel", chapters };
    },

    async getChapter(chapter) {
      const res = await fetch(chapter.url, { credentials: "include" });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const container = pickContent(doc);
      const blocks = extractBlocks(container, chapter.url);
      let title = chapter.title;
      const h = doc.querySelector("h1, h2");
      if ((!title || /^https?:/.test(title)) && h) title = (h.textContent || "").trim();
      return { title: title || "Chapter", blocks };
    },
  };
}
