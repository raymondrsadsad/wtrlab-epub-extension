// Offscreen worker for the "follow / auto-update" check. The service worker can't parse
// HTML (no DOMParser in MV3), so it delegates here: we run the project's real adapters —
// which DO use DOMParser (kakuyomu, generic) — to fetch each followed novel's index and
// report its current chapter count. Every novel is wrapped in try/catch so one failing
// site never breaks the batch (keeps the feature maintenance-free).
import { pickAdapter } from "./adapters/registry.js";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "CHECK_FOLLOWS") return; // ignore everything else
  (async () => {
    const out = [];
    for (const url of (Array.isArray(msg.urls) ? msg.urls : [])) {
      try {
        const adapter = pickAdapter(url);
        const meta = await adapter.getMeta(url);
        out.push({ url, count: (meta && meta.chapters && meta.chapters.length) || 0 });
      } catch (e) {
        out.push({ url, error: (e && e.message) || String(e) });
      }
    }
    sendResponse({ results: out });
  })();
  return true; // async response
});
