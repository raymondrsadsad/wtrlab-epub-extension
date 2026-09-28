// Minimal, dependency-free EPUB reader — the inverse of epub.js.
// Unzips an EPUB (STORE + DEFLATE) and extracts its chapters and images so a
// previously-built book can be re-imported and only new chapters fetched.
//
// Primary target: EPUBs produced by this extension (store-only, chapter-NNNN.xhtml
// files shaped as <body><h1>title</h1>{body}</body>). Third-party EPUBs are
// handled best-effort.

// ---- ZIP reading (store + deflate) ----

// Native raw-inflate via DecompressionStream (Chrome 103+). No third-party lib.
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

// Parse a ZIP via its central directory. Returns a Map(name -> Uint8Array),
// inflating deflated entries. Throws on a malformed archive.
async function unzip(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the End Of Central Directory record (scan back from the end; the
  // trailing comment is at most 65535 bytes).
  const maxBack = Math.min(bytes.length, 65557);
  let eocd = -1, firstHit = -1;
  for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    if (firstHit < 0) firstHit = i;
    // A real EOCD's comment length exactly accounts for the remaining bytes; prefer that record
    // so a 0x06054b50 that happens to occur inside the archive payload isn't mistaken for it.
    if (i + 22 + dv.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) eocd = firstHit; // no exact match — fall back to the first signature found
  if (eocd < 0) throw new Error("Not a ZIP/EPUB (no end-of-directory record).");

  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory offset

  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break; // not a central header — stop
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = td.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    // Read the local header to find where the entry's data actually begins.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error("Unsupported ZIP compression method " + method + " for " + name);

    out.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- EPUB parsing ----

const td = new TextDecoder();
function textOf(map, name) {
  const b = map.get(name);
  return b ? td.decode(b) : null;
}

// Resolve an href relative to a base directory (e.g. "OEBPS/"), collapsing "../".
function resolvePath(baseDir, href) {
  // OPF/XHTML hrefs may be percent-encoded (e.g. "images/my%20cover.jpg") while zip entry names
  // are literal bytes — decode so the lookup matches. Bad escapes are left as-is.
  try { href = decodeURIComponent(href); } catch (_) {}
  const parts = (baseDir + href).split("/");
  const stack = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

function mimeFromName(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}
function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "jpg";
}

const baseName = (p) => p.split("/").pop() || p;
const isChapterFile = (p) => /^chapter-[^/]*\.xhtml$/i.test(baseName(p));
// The exact front-matter files we generate (stem + extension only), so a real chapter like
// "title-of-book-1.xhtml" isn't wrongly excluded on the fallback path.
const isFrontMatter = (p) => /^(cover|title|nav|toc)\.[a-z0-9]+$/i.test(baseName(p));

/**
 * Parse an EPUB ArrayBuffer.
 * Options: { nsPrefix } prefixes every image name/id ("images/<nsPrefix>impN.ext"),
 * so several EPUBs can be merged without image-name collisions.
 * Returns { chapters: [{title, xhtmlBody, srcNo, srcUrl, imgNames[]}],
 *           images: [{id, name, mime, data, imported:true}],
 *           meta: {title, author, language, description, identifier},
 *           cover: {data, mime, ext} | null, count }.
 * Image names are namespaced and the chapter bodies' <img> srcs are rewritten to
 * match, so they never collide with freshly-fetched images.
 * srcNo/srcUrl come from the data-* identity this extension stamps on each chapter
 * (absent in older/third-party EPUBs), enabling identity-based re-import matching.
 */
export async function parseEpub(arrayBuffer, { nsPrefix = "" } = {}) {
  const map = await unzip(arrayBuffer);

  // 1) container.xml -> the OPF path
  const container = textOf(map, "META-INF/container.xml");
  if (!container) throw new Error("Not an EPUB (missing META-INF/container.xml).");
  const dp = new DOMParser();
  const cdoc = dp.parseFromString(container, "application/xml");
  const rootfile = cdoc.querySelector("rootfile");
  const opfPath = rootfile && rootfile.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB container has no rootfile path.");
  const opfDir = opfPath.includes("/") ? opfPath.replace(/[^/]*$/, "") : "";

  // 2) OPF -> manifest (id/href/media-type) + spine order
  const opfText = textOf(map, opfPath);
  if (!opfText) throw new Error("EPUB is missing its OPF package file.");
  const odoc = dp.parseFromString(opfText, "application/xml");
  const hrefById = new Map();
  const typeByHref = new Map();
  odoc.querySelectorAll("manifest > item").forEach((it) => {
    const id = it.getAttribute("id");
    const href = it.getAttribute("href");
    if (!id || !href) return;
    hrefById.set(id, href);
    typeByHref.set(href, it.getAttribute("media-type") || "");
  });
  const spine = [];
  odoc.querySelectorAll("spine > itemref").forEach((ref) => {
    const href = hrefById.get(ref.getAttribute("idref"));
    if (href) spine.push(href);
  });

  // 2b) Book metadata (offline, from the OPF <metadata>) + cover image bytes.
  const metaEl = odoc.querySelector("metadata");
  const dc = (n) => {
    if (metaEl) for (const el of metaEl.children) if (el.localName === n) return (el.textContent || "").trim();
    return "";
  };
  const meta = {
    title: dc("title"), author: dc("creator"), language: dc("language"),
    description: dc("description"), identifier: dc("identifier"),
  };
  let coverHref = null;
  if (metaEl) for (const el of metaEl.children) {
    if (el.localName === "meta" && el.getAttribute("name") === "cover") {
      const id = el.getAttribute("content");
      if (id && hrefById.has(id)) coverHref = hrefById.get(id);
    }
  }
  if (!coverHref) odoc.querySelectorAll("manifest > item").forEach((it) => {
    if (!coverHref && /\bcover-image\b/.test(it.getAttribute("properties") || "")) coverHref = it.getAttribute("href");
  });
  let cover = null;
  if (coverHref) {
    const cpath = resolvePath(opfDir, coverHref);
    const data = map.get(cpath);
    if (data) cover = { data, mime: mimeFromName(cpath), ext: extFromName(cpath) };
  }

  // 3) Pick the chapter documents in spine order. Prefer this extension's
  //    "chapter-*.xhtml"; if none match, fall back to every XHTML spine doc that
  //    isn't obvious front matter.
  const xhtmlSpine = spine.filter((h) => /\.x?html?$/i.test(h) && /xhtml|html/.test(typeByHref.get(h) || "html"));
  let chapterHrefs = xhtmlSpine.filter((h) => isChapterFile(h));
  if (!chapterHrefs.length) chapterHrefs = xhtmlSpine.filter((h) => !isFrontMatter(h));
  if (!chapterHrefs.length) throw new Error("No chapter documents found in this EPUB.");

  // 4) Parse each chapter: title from <h1>, body inner XML as xhtmlBody, and
  //    collect + re-namespace images.
  const images = [];
  const imgByPath = new Map(); // original zip path -> new record
  let imgN = 0;
  const xs = new XMLSerializer();

  const chapters = [];
  for (const href of chapterHrefs) {
    const path = resolvePath(opfDir, href);
    const xml = textOf(map, path);
    if (xml == null) continue;

    // Parse as XHTML (well-formed for our output); fall back to HTML for others.
    let doc = dp.parseFromString(xml, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length) {
      doc = dp.parseFromString(xml, "text/html");
    }
    const body = doc.querySelector("body");
    if (!body) continue;

    // Stable source identity stamped at build time (absent on older/foreign EPUBs).
    const noAttr = body.getAttribute("data-src-no");
    const srcNo = noAttr != null && noAttr !== "" ? noAttr : null;
    const srcUrl = body.getAttribute("data-src-url") || null;

    // Title: first <h1>, else <title>, else a positional fallback.
    let title = "";
    const h1 = body.querySelector("h1");
    if (h1) { title = h1.textContent.trim(); h1.remove(); }
    if (!title) {
      const t = doc.querySelector("title");
      title = (t && t.textContent.trim()) || `Chapter ${chapters.length + 1}`;
    }

    // Rewrite <img> srcs to namespaced imported names and pull the bytes.
    const imgNames = [];
    body.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const ipath = resolvePath(path.replace(/[^/]*$/, ""), src);
      let rec = imgByPath.get(ipath);
      if (!rec) {
        const data = map.get(ipath);
        if (!data) { img.remove(); return; } // referenced image not in the archive — drop the element (no dangling src)
        imgN++;
        const ext = extFromName(ipath);
        rec = { id: `${nsPrefix}imp${imgN}`, name: `images/${nsPrefix}imp${imgN}.${ext}`, mime: mimeFromName(ipath), data, imported: true };
        imgByPath.set(ipath, rec);
        images.push(rec);
      }
      img.setAttribute("src", rec.name);
      if (!imgNames.includes(rec.name)) imgNames.push(rec.name);
    });

    // Serialize the body's inner content (self-closing tags preserved as XML).
    const bodyXml = xs.serializeToString(body);
    const xhtmlBody = bodyXml.replace(/^[\s\S]*?<body[^>]*>/, "").replace(/<\/body>\s*$/, "").trim();

    chapters.push({ title, xhtmlBody, srcNo, srcUrl, imgNames });
  }

  if (!chapters.length) throw new Error("Could not read any chapters from this EPUB.");
  return { chapters, images, meta, cover, count: chapters.length };
}
