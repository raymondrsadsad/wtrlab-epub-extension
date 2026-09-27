// Opens the full-page UI in a new tab when the toolbar icon is clicked,
// passing the current tab's URL so the UI can auto-fill the Starting URL.
import { translateAll, translateBatch } from "./adapters/translate.js";

if (chrome.action && chrome.action.onClicked) chrome.action.onClicked.addListener((tab) => {
  const src = tab && tab.url ? "?src=" + encodeURIComponent(tab.url) : "";
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html" + src) });
});

// Messages from the on-site Web Reader widget (content script). Translation is
// routed here because in MV3 a content script's fetch is bound by the host page's
// CORS/CSP and no longer inherits host_permissions — the service worker has the
// extension's privileges and can call the Google endpoint directly.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "TRANSLATE_BATCH") {
    const texts = Array.isArray(msg.texts) ? msg.texts : [];
    const to = msg.to || "en";
    const from = msg.from || "auto";
    translateAll(texts, to, from)
      .then((out) => sendResponse({ ok: true, out }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // keep the port open for the async reply
  }

  // Single batch relayed by adapters/translate.js running inside the widget.
  if (msg.type === "TRANSLATE_RAW") {
    translateBatch(msg.texts || [], msg.to || "en", msg.from || "auto")
      .then((out) => sendResponse({ ok: true, out }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  if (msg.type === "OPEN_IN_READER") {
    const url = msg.url || (sender.tab && sender.tab.url) || "";
    const q = url ? "?read=" + encodeURIComponent(url) : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html" + q) });
    sendResponse({ ok: true });
    return; // synchronous
  }

  // On-demand "Check for new chapters" from the Library. Checks the given URLs (plus any
  // followed novels), updates followed badges/notifications, and returns per-URL counts so
  // the popup can flag new chapters for any library item.
  if (msg.type === "CHECK_FOLLOWS_NOW") {
    checkNow(Array.isArray(msg.urls) ? msg.urls : [])
      .then((results) => sendResponse({ ok: true, results }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async reply
  }

  // CHECK_FOLLOWS is handled by the offscreen document, not here — ignore it so we don't
  // reply on its channel.
});

// ---------- follow / auto-update ----------
// A periodic, best-effort check for new chapters in followed novels. Runs the site
// adapters in an offscreen document (they need a DOM), compares chapter counts, and fires
// a notification on an increase. Everything is wrapped so a failure is silent — nothing to
// babysit.
const CHECK_ALARM = "checkFollows";
const CHECK_PERIOD_MIN = 720; // ~12h

function ensureAlarm() { try { chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_PERIOD_MIN }); } catch (_) {} }
// Android browsers may lack alarms/notifications/offscreen. Guard every top-level
// listener: an exception here would kill the whole service worker (and with it the
// toolbar button and translation).
if (chrome.alarms) {
  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup.addListener(ensureAlarm);
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === CHECK_ALARM) checkFollows(); });
}

async function ensureOffscreen() {
  try { if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return; } catch (_) {}
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Parse novel index pages to detect newly released chapters.",
    });
  } catch (_) { /* already exists / race — fine */ }
}

async function runOffscreenCheck(urls) {
  if (!chrome.offscreen) return []; // no offscreen API (e.g. mobile) — skip quietly
  await ensureOffscreen();
  try {
    // The offscreen module registers its listener asynchronously after the document is
    // created, so the first sendMessage can find no receiver — retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "CHECK_FOLLOWS", urls });
        if (res && res.results) return res.results;
      } catch (_) { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return [];
  } finally { try { await chrome.offscreen.closeDocument(); } catch (_) {} }
}

// The scheduled ~12h check: just the followed novels.
async function checkFollows() { await checkNow([]); }

// Check `extraUrls` and every followed novel for new chapters. Updates followed novels'
// badges + fires notifications (same rules as the scheduled check) and returns the raw
// per-URL results so an on-demand caller (the Library) can flag any item, followed or not.
async function checkNow(extraUrls) {
  let map;
  try { ({ follows: map } = await chrome.storage.local.get("follows")); } catch (_) { map = {}; }
  map = map || {};
  const followUrls = Object.keys(map).filter((k) => map[k] && map[k].url).map((k) => map[k].url);
  const urls = Array.from(new Set([...(extraUrls || []), ...followUrls]));
  if (!urls.length) return [];
  const results = await runOffscreenCheck(urls);
  const byUrl = new Map(results.map((r) => [r && r.url, r]));
  for (const k of Object.keys(map)) {
    const f = map[k];
    if (!f || !f.url) continue;
    const r = byUrl.get(f.url);
    f.lastCheck = Date.now();
    if (!r || r.error || typeof r.count !== "number") continue;
    const prev = f.lastCount || 0;
    if (r.count > prev) {
      const delta = r.count - prev;
      f.newCount = (f.newCount || 0) + delta;
      f.lastCount = r.count;
      notifyNew(f, delta);
    } else if (!f.lastCount) {
      f.lastCount = r.count; // first successful check establishes the baseline
    }
  }
  try { await chrome.storage.local.set({ follows: map }); } catch (_) {}
  return results;
}

function notifyNew(f, delta) {
  if (!chrome.notifications) return;
  try {
    chrome.notifications.create("follow:" + f.url, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${delta} new chapter${delta === 1 ? "" : "s"}`,
      message: f.title || f.url,
      priority: 1,
    });
  } catch (_) {}
}

if (chrome.notifications && chrome.notifications.onClicked) chrome.notifications.onClicked.addListener((id) => {
  if (!id || id.indexOf("follow:") !== 0) return;
  const url = id.slice("follow:".length);
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?src=" + encodeURIComponent(url)) });
  try { chrome.notifications.clear(id); } catch (_) {}
});
