// Shared Google translateHtml helper (used by the wtr-lab and generic adapters).
const TRANSLATE = "https://translate-pa.googleapis.com/v1/translateHtml";
const GKEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";

async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// HTML entity decode (google translateHtml returns &#39; etc.)
let _decoderEl = null;
export function htmlUnescape(s) {
  if (!s || s.indexOf("&") === -1) return s;
  if (!_decoderEl) _decoderEl = document.createElement("textarea");
  _decoderEl.innerHTML = s;
  return _decoderEl.value;
}

export async function translateBatch(paras, to, from) {
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
