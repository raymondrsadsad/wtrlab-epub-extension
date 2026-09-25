// Kakuyomu (kakuyomu.jp) — Japanese web-novel site. Text is optionally translated
// to English via the shared Google translate helper (same engine Linguist uses).
import { translateAll } from "./translate.js";

function abs(url, base) { try { return new URL(url, base).href; } catch { return url; } }

async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
async function fetchText(url) {
  const res = await fetchT(url, { credentials: "include" });
  const html = await res.text();
  if (!res.ok && !html) throw new Error("HTTP " + res.status);
  return html;
}
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Not a Kakuyomu page (no __NEXT_DATA__).");
  return JSON.parse(m[1]);
}
function workIdFromUrl(url) {
  const m = String(url).match(/\/works\/(\d+)/);
  if (!m) throw new Error("Not a Kakuyomu work/episode URL.");
  return m[1];
}
function episodeIdFromUrl(url) {
  const m = String(url).match(/\/episodes\/(\d+)/);
  return m ? m[1] : null;
}

export function create() {
  return {
    id: "kakuyomu",
    label: "Kakuyomu",
    matches(url) { try { return new URL(url).hostname.endsWith("kakuyomu.jp"); } catch { return false; } },

    options() {
      return {
        services: [
          { id: "en", label: "Translated → English" },
          { id: "raw", label: "Raw (日本語)" },
        ],
        defaultService: "en",
      };
    },

    async getMeta(url) {
      const workId = workIdFromUrl(url);
      const html = await fetchText(`https://kakuyomu.jp/works/${workId}`);
      const data = nextData(html);
      const apollo = data.props.pageProps.__APOLLO_STATE__ || {};
      const work = apollo["Work:" + workId];
      if (!work) throw new Error("Kakuyomu work data not found.");

      const author = (apollo[work.author && work.author.__ref] || {});
      const authorName = author.activityName || author.name || "Unknown";
      const cover = work.ogImageUrl || work.adminCoverImageUrl || work.adminSquareImageUrl || null;
      const description = (work.introduction || work.catchphrase || "").trim();
      const subjects = Array.isArray(work.tagLabels)
        ? work.tagLabels.map((t) => (typeof t === "string" ? t : (t && t.name) || "")).filter(Boolean).slice(0, 20)
        : [];

      // Ordered episode list from the table of contents (skip unpublished EmptyEpisodes).
      const chapters = [];
      let no = 0;
      for (const chRef of work.tableOfContentsV2 || []) {
        const toc = apollo[chRef && chRef.__ref];
        if (!toc) continue;
        for (const epRef of toc.episodeUnions || []) {
          const ref = epRef && epRef.__ref;
          if (!ref || !ref.startsWith("Episode:")) continue; // skip EmptyEpisode
          const ep = apollo[ref];
          if (!ep) continue;
          no++;
          chapters.push({
            no, id: ep.id,
            url: `https://kakuyomu.jp/works/${workId}/episodes/${ep.id}`,
            title: `#${no} ${ep.title || "Episode " + no}`,
            epTitle: ep.title || "",
          });
        }
      }

      return {
        title: work.title || "Untitled",
        author: authorName,
        language: "en", origLang: "ja",
        cover, description, subjects,
        slug: "kakuyomu", chapterCount: chapters.length, chapters,
      };
    },

    // opts: { service, lang }
    async getChapter(chapter, opts) {
      const service = (opts && opts.service) || "en";
      const lang = (opts && opts.lang) || "en";
      const html = await fetchText(chapter.url);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const body = doc.querySelector(".js-episode-body, .widget-episodeBody");

      const blocks = [];
      if (body) {
        body.querySelectorAll("rt, rp").forEach((el) => el.remove()); // drop furigana readings
        for (const p of Array.from(body.children)) {
          const t = (p.textContent || "").replace(/\s+/g, " ").trim();
          if (t) blocks.push({ type: "text", text: t });
          p.querySelectorAll && p.querySelectorAll("img").forEach((im) => {
            const s = im.getAttribute("src") || im.getAttribute("data-src");
            if (s) blocks.push({ type: "image", url: abs(s, chapter.url) });
          });
        }
      }

      const te = doc.querySelector(".widget-episodeTitle");
      let title = (te && te.textContent.trim()) || chapter.epTitle || chapter.title || `Episode ${chapter.no}`;

      if (service === "en") {
        const idxs = [], texts = [];
        blocks.forEach((b, i) => { if (b.type === "text" && b.text) { idxs.push(i); texts.push(b.text); } });
        if (texts.length) {
          try {
            const out = await translateAll(texts, lang, "ja");
            idxs.forEach((bi, k) => { if (out[k]) blocks[bi].text = out[k]; });
          } catch (e) { console.warn("kakuyomu translate failed", e); }
        }
        try { title = (await translateAll([title], lang, "ja"))[0] || title; } catch {}
      }

      return { title: `#${chapter.no} ${title}`.trim(), blocks };
    },
  };
}
