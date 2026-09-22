// Minimal, dependency-free EPUB builder.
// Produces a valid EPUB3 (with EPUB2 toc.ncx fallback) as a Blob using a
// hand-rolled ZIP writer (STORE only; mimetype stored first & uncompressed).

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
function toBytes(data) {
  return typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
}

// ---- ZIP (store only) ----
function buildZip(files) {
  // files: [{ name, data(string|Uint8Array) }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // fixed 1980-01-01

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = toBytes(f.data);
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0, true);         // flags
    lv.setUint16(8, 0, true);         // method 0 = store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { chunks.push(c); centralSize += c.length; }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  return new Blob(chunks, { type: "application/epub+zip" });
}

// ---- helpers ----
function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function pad(n, w) { return String(n).padStart(w, "0"); }
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Build an EPUB.
 * meta: { title, author, language, cover: {data:Uint8Array, mime, ext} | null }
 * chapters: [{ title, xhtmlBody(string, inner HTML) }]
 * images: [{ id, name(e.g. images/img1.jpg), data:Uint8Array, mime }]
 * Returns a Blob.
 */
export function buildEpub(meta, chapters, images) {
  const bookId = "urn:uuid:" + uuid();
  const lang = meta.language || "en";
  const files = [];

  // mimetype MUST be first and stored (our zip is store-only, so order is enough)
  files.push({ name: "mimetype", data: "application/epub+zip" });

  files.push({
    name: "META-INF/container.xml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  });

  // shared stylesheet
  files.push({
    name: "OEBPS/style.css",
    data: `html,body{margin:0;padding:0}
body{font-family:Georgia,"Times New Roman",serif;line-height:1.7;color:#111;margin:1.2em 1.15em}
h1{font-size:1.35em;line-height:1.3;margin:0 0 1em;text-align:left}
p{margin:0 0 .9em;text-align:justify;-webkit-hyphens:auto;hyphens:auto}
img{max-width:100%;height:auto;display:block;margin:1.2em auto}
.cover{margin:0;padding:0;height:100%;text-align:center}
.cover img{max-width:100%;max-height:100vh;height:auto;margin:0 auto}`,
  });

  // cover (image metadata + a real cover page so the book opens on it)
  let coverMeta = "", coverImageItem = "", coverPageItem = "", coverPageRef = "";
  if (meta.cover && meta.cover.data) {
    const cname = "images/cover." + (meta.cover.ext || "jpg");
    files.push({ name: "OEBPS/" + cname, data: meta.cover.data });
    coverImageItem = `<item id="cover-image" href="${cname}" media-type="${meta.cover.mime || "image/jpeg"}" properties="cover-image"/>`;
    coverMeta = `<meta name="cover" content="cover-image"/>`;
    files.push({
      name: "OEBPS/cover.xhtml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}">
<head><meta charset="utf-8"/><title>Cover</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body class="cover" epub:type="cover"><img src="${cname}" alt="Cover"/></body></html>`,
    });
    coverPageItem = `<item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
    coverPageRef = `<itemref idref="coverpage"/>`;
  }

  // images
  const imageItems = [];
  for (const img of images) {
    files.push({ name: "OEBPS/" + img.name, data: img.data });
    imageItems.push(`<item id="${img.id}" href="${img.name}" media-type="${img.mime}"/>`);
  }

  // chapter xhtml
  const chapItems = [];
  const chapRefs = [];
  const navList = [];
  const ncxList = [];
  chapters.forEach((ch, i) => {
    const idx = pad(i + 1, 4);
    const fname = `chapter-${idx}.xhtml`;
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}">
<head><meta charset="utf-8"/><title>${xmlEscape(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body><h1>${xmlEscape(ch.title)}</h1>
${ch.xhtmlBody}
</body></html>`;
    files.push({ name: "OEBPS/" + fname, data: doc });
    chapItems.push(`<item id="chap${idx}" href="${fname}" media-type="application/xhtml+xml"/>`);
    chapRefs.push(`<itemref idref="chap${idx}"/>`);
    navList.push(`<li><a href="${fname}">${xmlEscape(ch.title)}</a></li>`);
    ncxList.push(`<navPoint id="np${idx}" playOrder="${i + 1}"><navLabel><text>${xmlEscape(ch.title)}</text></navLabel><content src="${fname}"/></navPoint>`);
  });

  // nav.xhtml (EPUB3)
  files.push({
    name: "OEBPS/nav.xhtml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList.join("")}</ol></nav></body></html>`,
  });

  // toc.ncx (EPUB2 fallback)
  files.push({
    name: "OEBPS/toc.ncx",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${bookId}"/></head>
<docTitle><text>${xmlEscape(meta.title)}</text></docTitle>
<navMap>${ncxList.join("")}</navMap></ncx>`,
  });

  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files.push({
    name: "OEBPS/content.opf",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${bookId}</dc:identifier>
    <dc:title>${xmlEscape(meta.title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <dc:creator>${xmlEscape(meta.author || "Unknown")}</dc:creator>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${coverImageItem}
    ${coverPageItem}
    ${imageItems.join("\n    ")}
    ${chapItems.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${coverPageRef}
    ${chapRefs.join("\n    ")}
  </spine>
</package>`,
  });

  return buildZip(files);
}
