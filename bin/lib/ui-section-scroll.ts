/**
 * Page function that scrolls a section into a screenshot position clear of
 * fixed/sticky bars. A plain `scrollIntoView` aligns the section edge to the
 * viewport edge, which parks the section's end (or start) under a pinned
 * bar. This measures the bars after the alignment and nudges the scroller by
 * the overlap. The source is evaluated inside the target page, so it imports
 * nothing and is shared by the capture script and the browser-driver path.
 */

export type SectionScrollResult = {
  found: boolean;
  /** Signed scroll delta the nudge actually produced (negative = up). */
  offsetPx: number;
  /** Start shot only: the section's bottom is below the visible area (under bottom chrome, or past the viewport edge when there is none) and the page can still scroll. */
  clippedByBottom: boolean;
};

const SCROLL_SOURCE = String.raw`(a) => {
  const el = document.querySelector(a.sel);
  if (!el) return { found: false, offsetPx: 0, clippedByBottom: false };
  el.scrollIntoView({ block: a.part, behavior: "instant" });
  const H = window.innerHeight;
  const W = window.innerWidth;
  const isScroller = (n) => {
    const o = getComputedStyle(n).overflowY;
    return (o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight;
  };
  const rootCs = getComputedStyle(document.documentElement);
  const bodyPropagates = (rootCs.overflowX || "visible") === "visible" && (rootCs.overflowY || "visible") === "visible";
  let scroller = null;
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    if (n === document.body && bodyPropagates) continue;
    if (isScroller(n)) { scroller = n; break; }
  }
  if (!scroller) scroller = document.scrollingElement || document.documentElement;
  const hiddenSel = ["[hidden]", "details:not([open])", '[aria-hidden="true"]'];
  const bottoms = [];
  const tops = [];
  for (const n of Array.from(document.querySelectorAll("*"))) {
    const cs = getComputedStyle(n);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (n.getClientRects().length === 0 || cs.visibility === "hidden" || !(parseFloat(cs.opacity) > 0)) continue;
    if (hiddenSel.some((s) => n.closest(s))) continue;
    if (n.contains(el)) continue;
    const sticky = cs.position === "sticky";
    if (sticky && el.contains(n)) continue;
    const r = n.getBoundingClientRect();
    const visW = Math.min(r.right, W) - Math.max(r.left, 0);
    if (visW < 0.6 * W || r.height <= 0 || r.height > 0.35 * H) continue;
    if (r.top >= H / 2 && r.top < H && r.bottom >= H - 40) {
      if (!sticky || r.bottom >= H - 1) bottoms.push(r.top);
    } else if (r.top <= 40 && r.bottom > 0 && r.bottom < H / 2) {
      if (!sticky || r.top <= 1) tops.push(r.bottom);
    }
  }
  const bottomTop = bottoms.length ? Math.min(...bottoms) : null;
  const before = scroller.scrollTop;
  let overlap = 0;
  if (a.part === "end") {
    if (bottomTop !== null) overlap = Math.max(0, el.getBoundingClientRect().bottom - bottomTop);
  } else if (tops.length) {
    overlap = -Math.max(0, Math.max(...tops) - el.getBoundingClientRect().top);
  }
  if (overlap !== 0) scroller.scrollBy({ top: overlap, behavior: "instant" });
  const offsetPx = Math.round(scroller.scrollTop - before);
  let clippedByBottom = false;
  if (a.part === "start") {
    const limit = (bottomTop === null ? H : bottomTop) + 1;
    clippedByBottom = el.getBoundingClientRect().bottom > limit && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
  }
  return { found: true, offsetPx, clippedByBottom };
}`;

export function sectionScrollSource(): string {
  return SCROLL_SOURCE;
}
