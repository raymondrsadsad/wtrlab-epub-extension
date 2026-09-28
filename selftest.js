// Built-in self-test — exercises the real code paths so a release can be
// sanity-checked without manual clicking. Everything here is OFFLINE except the
// optional translation check (opts.online), so it never depends on a live site.
//
// Each test returns { name, ok, detail }. runSelfTest() gathers them into
// { results, passed, failed, ms }. Add a test by pushing an async fn into TESTS.
import { buildEpub } from "./epub.js";
import { parseEpub } from "./epubread.js";
import { pickAdapter, adapterById } from "./adapters/registry.js";
import { applyGlossary, htmlUnescape, translateAll, parseGtx, makeMemo, memoKey } from "./adapters/translate.js";

// ---- tiny assert helpers ----
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "not equal") + ` — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A minimal valid 1×1 transparent PNG, used as both cover and inline image.
const PNG_1x1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);
const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function buildAndParse(idSeed) {
  const meta = {
    title: "Self-Test Book",
    author: "Tester",
    language: "en",
    description: "A synthetic book built by the self-test.",
    idSeed,
    cover: { data: PNG_1x1, mime: "image/png", ext: "png" },
  };
  const chapters = [
    { title: "Chapter One", xhtmlBody: `<p>Hello world.</p><img src="images/img1.png" alt=""/>`, srcNo: "1", srcUrl: "https://example.com/c1" },
    // Title packed with every XML-sensitive character, to catch escaping regressions.
    { title: `Tricky & <Two> "Q" 'A'`, xhtmlBody: `<p>Second &amp; test.</p>`, srcNo: "2", srcUrl: "https://example.com/c2" },
  ];
  const images = [{ id: "img1", name: "images/img1.png", data: PNG_1x1, mime: "image/png" }];
  const blob = buildEpub(meta, chapters, images);
  const ab = await blob.arrayBuffer();
  return { meta, chapters, blob, parsed: await parseEpub(ab) };
}

// ---- tests ----
const TESTS = [
  async function epubRoundTrip() {
    const { parsed } = await buildAndParse("selftest-roundtrip");
    eq(parsed.count, 2, "chapter count");
    eq(parsed.chapters[0].title, "Chapter One", "chapter 1 title");
    eq(parsed.chapters[0].srcNo, "1", "chapter 1 srcNo preserved");
    eq(parsed.chapters[0].srcUrl, "https://example.com/c1", "chapter 1 srcUrl preserved");
    eq(parsed.meta.title, "Self-Test Book", "book title from OPF");
    eq(parsed.meta.author, "Tester", "book author from OPF");
    return "built a 2-chapter EPUB and read it back intact";
  },

  async function xmlEscaping() {
    const { parsed } = await buildAndParse("selftest-escaping");
    // The tricky title must survive escape (build) + parse (read) unchanged.
    eq(parsed.chapters[1].title, `Tricky & <Two> "Q" 'A'`, "special-char title round-trip");
    return `special characters ( & < > " ' ) survive packing and re-reading`;
  },

  async function imagesPreserved() {
    const { parsed } = await buildAndParse("selftest-images");
    assert(parsed.cover && bytesEqual(parsed.cover.data, PNG_1x1), "cover bytes preserved");
    assert(parsed.images.length >= 1, "inline image collected");
    assert(bytesEqual(parsed.images[0].data, PNG_1x1), "inline image bytes preserved");
    assert(parsed.chapters[0].imgNames.length === 1, "chapter keeps its image reference");
    return "cover + inline image bytes round-trip byte-for-byte";
  },

  async function deterministicId() {
    const a1 = await buildAndParse("seed-A");
    const a2 = await buildAndParse("seed-A");
    const b = await buildAndParse("seed-B");
    assert(UUID_RE.test(a1.parsed.meta.identifier), "identifier is a well-formed urn:uuid");
    eq(a1.parsed.meta.identifier, a2.parsed.meta.identifier, "same seed → same id (no duplicate books on re-download)");
    assert(a1.parsed.meta.identifier !== b.parsed.meta.identifier, "different seed → different id");
    return "stable, well-formed book id from the seed";
  },

  async function adapterAutoDetect() {
    eq(pickAdapter("https://wtr-lab.com/en/serie-100/x").id, "wtrlab", "wtr-lab URL");
    eq(pickAdapter("https://kakuyomu.jp/works/123").id, "kakuyomu", "kakuyomu URL");
    eq(pickAdapter("https://some-unknown-site.example/novel/1").id, "generic", "unknown site → generic");
    eq(adapterById("generic", "x").id, "generic", "forced generic");
    eq(adapterById("kakuyomu", "x").id, "kakuyomu", "forced kakuyomu");
    return "URLs route to the right adapter (wtr-lab / kakuyomu / generic)";
  },

  async function adapterOptions() {
    for (const id of ["wtrlab", "kakuyomu", "generic"]) {
      const o = adapterById(id, "https://example.com").options();
      assert(o && Array.isArray(o.services) && o.services.length > 0, `${id}: services list`);
      assert(o.defaultService, `${id}: has a default service`);
    }
    return "every adapter offers translation-mode options";
  },

  async function glossaryReplacement() {
    // Pairs are applied longest-source-first (as setGlossary sorts them), so a
    // longer term wins over a substring of it. Passing pairs explicitly keeps
    // this test from touching the app's active glossary.
    const pairs = [{ from: "乾坤", to: "Qiankun" }, { from: "乾", to: "Qian" }];
    eq(applyGlossary("乾坤 and 乾", pairs), "Qiankun and Qian", "longest term wins, both replaced");
    eq(applyGlossary("nothing here", pairs), "nothing here", "no-match text is unchanged");
    return "glossary replaces terms and prefers the longer match";
  },

  async function entityDecode() {
    eq(htmlUnescape("A &amp; B &#39;C&#39; &#x2764;"), "A & B 'C' ❤", "named, decimal and hex entities");
    eq(htmlUnescape("plain text"), "plain text", "text without entities is untouched");
    return "HTML entities from the translator decode correctly";
  },

  async function gtxFallbackParse() {
    eq(parseGtx([[["Hello, ", "x"], ["world", "y"]]]), "Hello, world", "joins the translated halves of gtx segments");
    eq(parseGtx([[]]), "", "empty segment list → empty string");
    assert(parseGtx(null) === null && parseGtx([1]) === null, "malformed response → null (so the caller keeps the source)");
    return "the keyless Google fallback response parses into text";
  },

  async function translationCacheLru() {
    const m = makeMemo(3);
    m.set("a", "1"); m.set("b", "2"); m.set("c", "3");
    eq(m.get("a"), "1", "cache hit"); // touches "a" so it's now most-recently-used
    m.set("d", "4");                   // over the cap of 3 → evict the least-recently-used ("b")
    eq(m.get("b"), undefined, "least-recently-used entry evicted");
    eq(m.get("a"), "1", "recently-used entry survives eviction");
    assert(memoKey("google", "auto", "en", "x") !== memoKey("google", "auto", "fr", "x"), "target language is part of the key");
    assert(memoKey("google", "auto", "en", "x") !== memoKey("openai", "auto", "en", "x"), "engine mode is part of the key");
    return "translation cache memoizes, evicts LRU, and keys by engine + languages";
  },

  async function xmlAttrEscaping() {
    // A language tag full of XML-significant characters must be escaped in every attribute/element
    // it's interpolated into, or the packaged OPF/XHTML is malformed and won't re-open.
    const meta = { title: "Esc", author: "A", language: `en" & <x>`, idSeed: "esc-attrs", cover: { data: PNG_1x1, mime: "image/png", ext: "png" } };
    const chapters = [{ title: "C1", xhtmlBody: "<p>ok</p>", srcNo: "1", srcUrl: "https://example.com/1" }];
    const parsed = await parseEpub(await buildEpub(meta, chapters, []).arrayBuffer());
    eq(parsed.count, 1, "book still packs & re-parses with a tricky language tag");
    eq(parsed.chapters[0].title, "C1", "chapter intact despite the bad language value");
    return "XML-significant characters in metadata don't corrupt the EPUB";
  },

  async function layoutGeometry() {
    const L = globalThis.WRLayout;
    assert(L && L.cornerAnchor && L.clampCorner, "WRLayout (shared widget geometry) is loaded");
    const tl = L.cornerAnchor({ left: 4, top: 4, right: 184, bottom: 48, width: 180, height: 44 }, 1000, 1000, 8);
    eq(tl.ax + "/" + tl.ay, "left/top", "a rect near the top-left anchors to that corner");
    const br = L.cornerAnchor({ left: 800, top: 900, right: 980, bottom: 944, width: 180, height: 44 }, 1000, 1000, 8);
    eq(br.ax + "/" + br.ay, "right/bottom", "a rect near the bottom-right anchors to that corner");
    const c = L.clampCorner(950, 950, 300, 500, 1000, 1000, 8);
    assert(c.x <= 1000 - 300 - 8 && c.y <= 1000 - 500 - 8, "an oversized panel is pulled fully on-screen");
    return "corner anchoring + clamp keep the floating widget on-screen";
  },
];

// Optional online check — real Google translation of one short string.
async function onlineTranslate() {
  const out = await translateAll(["これはテストです"], "en", "auto");
  assert(Array.isArray(out) && out.length === 1 && out[0] && out[0].trim(), "got one non-empty translation back");
  return `translation reachable → "${out[0]}"`;
}

export async function runSelfTest({ online = false } = {}) {
  const started = performance.now();
  const results = [];
  const run = async (name, fn) => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || "passed", ms: performance.now() - t0 });
    } catch (e) {
      results.push({ name, ok: false, detail: (e && e.message) || String(e), ms: performance.now() - t0 });
    }
  };
  for (const fn of TESTS) await run(prettyName(fn.name), fn);
  if (online) await run("Online: Google translation", onlineTranslate);
  const failed = results.filter((r) => !r.ok).length;
  return { results, passed: results.length - failed, failed, ms: performance.now() - started };
}

// camelCase fn name → "Sentence case" label.
function prettyName(n) {
  const s = n.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
  return s.replace(/\bEpub\b/i, "EPUB").replace(/\bXml\b/i, "XML").replace(/\bId\b/, "ID").replace(/\bUrl\b/i, "URL");
}
