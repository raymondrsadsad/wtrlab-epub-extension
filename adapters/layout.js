// Pure widget-positioning math, shared by the on-site widget (webwidget.js) and the self-test.
// Loaded as a classic script — as a content script (declared before webwidget.js, so they share
// one isolated-world global) and via a <script> tag in popup.html (so the self-test can reach it
// as globalThis.WRLayout). No DOM here: callers pass in measured rects / viewport sizes, so every
// function is deterministic and unit-testable.
(function () {
  "use strict";
  const clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const WRLayout = {
    // Clamp a top-left position so a w×h box stays within a vw×vh viewport, keeping margin m.
    // If the box is bigger than the viewport, it pins to the m margin (max wins over min).
    clampXY(left, top, w, h, vw, vh, m) {
      return {
        left: clampRange(left, m, Math.max(m, vw - w - m)),
        top: clampRange(top, m, Math.max(m, vh - h - m)),
      };
    },

    // Pick the corner a rect is nearest (by its center) and return an anchor
    // { ax:'left'|'right', ay:'top'|'bottom', x, y } where x/y are distances from those edges,
    // clamped so the rect stays fully on-screen.
    cornerAnchor(rect, vw, vh, m) {
      const ax = (rect.left + rect.width / 2) > vw / 2 ? "right" : "left";
      const ay = (rect.top + rect.height / 2) > vh / 2 ? "bottom" : "top";
      const x = ax === "left" ? rect.left : vw - rect.right;
      const y = ay === "top" ? rect.top : vh - rect.bottom;
      return {
        ax, ay,
        x: clampRange(x, m, Math.max(m, vw - rect.width - m)),
        y: clampRange(y, m, Math.max(m, vh - rect.height - m)),
      };
    },

    // Clamp a corner offset so a w×h box pinned at that corner stays fully visible. Used for the
    // expanded panel, which is larger than the mini pill it shares a corner with.
    clampCorner(x, y, w, h, vw, vh, m) {
      return {
        x: clampRange(x, m, Math.max(m, vw - w - m)),
        y: clampRange(y, m, Math.max(m, vh - h - m)),
      };
    },
  };

  if (typeof globalThis !== "undefined") globalThis.WRLayout = WRLayout;
})();
