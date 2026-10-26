/**
 * Stack-agnostic page-quality probe and its pure judge. The probe is a
 * self-contained JS arrow function (as a string) the UI driver hands to
 * `evaluate_script`; it returns raw numbers only. `judgeHeuristics` turns those
 * numbers into hard defects and advisory smells in plain TypeScript — the
 * driver never judges, and this module never touches a DOM or the MCP.
 */

export type HeuristicsCapture = {
  innerWidth: number;
  innerHeight: number;
  scrollHeight: number;
  mainTextLength: number;
  hasDarkScheme: boolean;
  darkSchemeClass: string | null;
  bodyLuminance: number;
  clippedText: { path: string; overflowPx: number }[];
  leakedText: {
    sample: string;
    path: string;
    kind: "markup" | "template" | "object" | "citation" | "token";
  }[];
  tallBlocks: { path: string; height: number }[];
  anchorLandings: { href: string; targetTop: number; chromeBottom: number }[];
  pastViewport: { path: string; right: number }[];
  lowContrast: { path: string; ratio: number; large: boolean }[];
  duplicateControls: { name: string; role: string; count: number }[];
  repeatedText: { sample: string; count: number }[];
  crampedRows: {
    path: string;
    children: number;
    minChildWidth: number;
    truncated: boolean;
  }[];
  headingScale: {
    pair: "h1>h2" | "h2>h3";
    ratio: number;
    sameWeight: boolean;
  }[];
};

export const HEURISTIC_THRESHOLDS = {
  wallMinPx: 2400,
  wallPageShare: 0.35,
  anchorTolerancePx: 2,
  contrastDefect: 3,
  contrastNormal: 4.5,
  contrastLarge: 3,
  viewportMismatchPx: 1,
  crampedMaxViewport: 390,
  crampedMinChildren: 3,
  crampedMinChildPx: 100,
  flatHeadingRatio: 1.1,
} as const;

const PROBE_SOURCE = String.raw`() => {
  const CAP = 5, STR = 160, SCAN = 3000;
  const cut = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, STR);
  const W = window.innerWidth, H = window.innerHeight;
  const cs = (e) => getComputedStyle(e);
  const root = document.querySelector("main") || document.body;
  const all = Array.from(document.body.querySelectorAll("*")).slice(0, SCAN);
  const inRoot = all.filter((e) => e !== root && root.contains(e));
  const SKIP = "script,style,code,pre,textarea,noscript";
  const visible = (e) => {
    if (!e.getClientRects().length) return false;
    const s = cs(e);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const path = (e) => {
    const p = [];
    for (let n = e; n && n.nodeType === 1 && n !== document.body && p.length < 4; n = n.parentElement) {
      p.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : n.classList.length ? "." + n.classList[0] : ""));
    }
    return p.join(" > ");
  };
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
  };
  const lum = (c) => {
    const f = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const first = (arr, n) => arr.slice(0, n);
  const out = {
    innerWidth: W, innerHeight: H,
    scrollHeight: document.documentElement.scrollHeight,
    mainTextLength: 0, hasDarkScheme: false, darkSchemeClass: null, bodyLuminance: 1,
    clippedText: [], leakedText: [], tallBlocks: [], anchorLandings: [], pastViewport: [],
    lowContrast: [], duplicateControls: [], repeatedText: [], crampedRows: [], headingScale: [],
  };

  const clone = root.cloneNode(true);
  clone.querySelectorAll("script,style").forEach((n) => n.remove());
  out.mainTextLength = (clone.textContent || "").replace(/\s+/g, " ").trim().length;

  const LEAKS = [
    ["markup", /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>|&(?:[a-z]+|#\d+);/i],
    ["template", /\{\{[^}]*\}\}|\$\{[^}]*\}|\{%[^%]*%\}/],
    ["object", /\[object [A-Z][A-Za-z]*\]/],
    ["citation", /【[^】]*】|†source|contentReference\[/],
    ["token", /\bundefined\b|\bNaN\b|\*\*[^*\n]+\*\*/],
  ];
  const leaked = (text, el) => {
    for (const [kind, re] of LEAKS) {
      const m = text.match(re);
      if (m) { out.leakedText.push({ sample: cut(text), path: path(el), kind }); return; }
    }
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textEls = new Set();
  for (let n = walker.nextNode(), i = 0; n && i < SCAN * 4; n = walker.nextNode(), i++) {
    const el = n.parentElement;
    const t = (n.nodeValue || "").trim();
    if (!el || !t || el.closest(SKIP) || !visible(el)) continue;
    textEls.add(el);
    if (out.leakedText.length < CAP) leaked(t, el);
  }
  for (const el of document.body.querySelectorAll("[alt],[title],[aria-label]")) {
    if (out.leakedText.length >= CAP) break;
    if (el.closest(SKIP) || !visible(el)) continue;
    for (const a of ["alt", "title", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v) leaked(v, el);
    }
  }

  const bg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parse(s.backgroundColor);
      if (c && c.a === 1) return c;
      if (c && c.a > 0) return null;
    }
    return /dark/.test(cs(document.documentElement).colorScheme) ? null : { r: 255, g: 255, b: 255, a: 1 };
  };
  const bodyBg = bg(document.body);
  out.bodyLuminance = bodyBg ? lum(bodyBg) : 1;
  let low = [];
  for (const el of Array.from(textEls).slice(0, 600)) {
    if (el.closest(":disabled,[aria-disabled=true]")) continue;
    const s = cs(el), fg = parse(s.color), back = bg(el);
    if (!fg || !back || fg.a === 0) continue;
    const eff = fg.a < 1
      ? { r: fg.r * fg.a + back.r * (1 - fg.a), g: fg.g * fg.a + back.g * (1 - fg.a), b: fg.b * fg.a + back.b * (1 - fg.a), a: 1 }
      : fg;
    const px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
    const r = ratio(eff, back);
    if (r < (large ? 3 : 4.5)) low.push({ path: path(el), ratio: Math.round(r * 100) / 100, large });
  }
  out.lowContrast = first(low.sort((a, b) => a.ratio - b.ratio), CAP);

  const rendered = (e) =>
    e.getClientRects().length > 0 && cs(e).visibility !== "hidden" && !e.closest('[hidden],details:not([open]),[aria-hidden="true"]');
  const bars = all.filter((e) => {
    const s = cs(e);
    return (s.position === "fixed" || s.position === "sticky") && s.top !== "auto";
  });
  const sx = window.scrollX, sy = window.scrollY;
  try {
    const links = Array.from(document.querySelectorAll('a[href^="#"]:not([href="#"]):not([href="#!"])')).slice(0, 20);
    for (const a of links) {
      let target = null;
      try { target = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1))); } catch (e) { target = null; }
      if (!target || !rendered(a) || !rendered(target)) continue;
      target.scrollIntoView({ block: "start", behavior: "instant" });
      let chromeBottom = 0;
      for (const b of bars) {
        const r = b.getBoundingClientRect();
        if (rendered(b) && r.top < H / 2 && r.width >= W * 0.6 && r.height <= H * 0.35) chromeBottom = Math.max(chromeBottom, r.bottom);
      }
      out.anchorLandings.push({ href: cut(a.getAttribute("href")), targetTop: Math.round(target.getBoundingClientRect().top), chromeBottom: Math.round(chromeBottom) });
    }
  } finally {
    window.scrollTo({ left: sx, top: sy, behavior: "instant" });
  }

  const clipped = (e) => {
    const s = cs(e);
    return e.scrollWidth > e.clientWidth && ((/hidden|clip/.test(s.overflowX)) || s.textOverflow === "ellipsis");
  };
  for (const el of all) {
    if (out.clippedText.length >= CAP) break;
    if (!visible(el)) continue;
    const s = cs(el);
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.nodeValue || "").trim());
    if (hasText && /hidden|clip/.test(s.overflowX) && s.textOverflow !== "ellipsis" && el.scrollWidth - el.clientWidth > 1) {
      out.clippedText.push({ path: path(el), overflowPx: el.scrollWidth - el.clientWidth });
    }
  }
  const scrolls = (e) => { for (let n = e.parentElement; n; n = n.parentElement) if (/auto|scroll/.test(cs(n).overflowX)) return true; return false; };
  for (const el of all) {
    if (out.pastViewport.length >= CAP) break;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left < W && r.right > W + 1 && visible(el) && !scrolls(el)) out.pastViewport.push({ path: path(el), right: Math.round(r.right) });
  }

  const dupes = new Map();
  for (const el of inRoot.filter((e) => e.matches('button,a[href],[role=button]'))) {
    if (!visible(el) || el.closest('li,tr,[role=row],article')) continue;
    const name = cut(el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").toLowerCase();
    if (!name) continue;
    const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : "button");
    const k = role + "|" + name;
    dupes.set(k, { name, role, count: (dupes.has(k) ? dupes.get(k).count : 0) + 1 });
  }
  out.duplicateControls = first(Array.from(dupes.values()).filter((d) => d.count > 1), CAP);
  const reps = new Map();
  for (const el of inRoot) {
    if (el.childElementCount || el.closest(SKIP) || !visible(el)) continue;
    const t = cut(el.textContent || "");
    if (t.length >= 40) reps.set(t, (reps.get(t) || 0) + 1);
  }
  out.repeatedText = first(Array.from(reps, ([sample, count]) => ({ sample, count })).filter((r) => r.count > 1), CAP);

  const tall = inRoot.filter((e) => e.getBoundingClientRect().height >= 1200 && visible(e));
  out.tallBlocks = first(
    tall
      .filter((e) => !tall.some((c) => c !== e && e.contains(c) && c.getBoundingClientRect().height >= 0.8 * e.getBoundingClientRect().height))
      .map((e) => ({ path: path(e), height: Math.round(e.getBoundingClientRect().height) }))
      .sort((a, b) => b.height - a.height),
    CAP,
  );

  const rows = [];
  for (const el of inRoot) {
    if (!/^(inline-)?(flex|grid)$/.test(cs(el).display)) continue;
    const kids = Array.from(el.children).filter((c) => visible(c) && c.getBoundingClientRect().width > 0);
    if (kids.length < 3) continue;
    const top = kids[0].getBoundingClientRect().top;
    const row = kids.filter((c) => Math.abs(c.getBoundingClientRect().top - top) <= 2);
    if (row.length < 3) continue;
    const truncated = row.some((c) => clipped(c) || Array.from(c.querySelectorAll("*")).slice(0, 20).some(clipped));
    rows.push({ path: path(el), children: row.length, minChildWidth: Math.round(Math.min(...row.map((c) => c.getBoundingClientRect().width))), truncated });
  }
  out.crampedRows = first(rows.sort((a, b) => a.minChildWidth - b.minChildWidth), CAP);

  const vis = (sel) => Array.from(document.querySelectorAll(sel)).find(visible);
  const h1 = vis("h1"), h2 = vis("h2"), h3 = vis("h3");
  const scale = (pair, a, b) => {
    if (!a || !b) return;
    const sa = cs(a), sb = cs(b);
    out.headingScale.push({ pair, ratio: Math.round((parseFloat(sa.fontSize) / parseFloat(sb.fontSize)) * 100) / 100, sameWeight: sa.fontWeight === sb.fontWeight });
  };
  scale("h1>h2", h1, h2);
  scale("h2>h3", h2, h3);

  const isDark = (t) => /dark/.test(t);
  const sheets = Array.from(document.styleSheets);
  const walk = (rules) => {
    for (const r of Array.from(rules)) {
      if (r.media && /prefers-color-scheme:\s*dark/.test(r.media.mediaText)) out.hasDarkScheme = true;
      if (r.style && isDark(r.style.getPropertyValue("color-scheme"))) out.hasDarkScheme = true;
      const sel = r.selectorText || "";
      if (/(^|[\s,>])\.dark\b/.test(sel)) { out.hasDarkScheme = true; out.darkSchemeClass = out.darkSchemeClass || ".dark"; }
      else if (/\[data-theme=["']?dark["']?\]/.test(sel)) { out.hasDarkScheme = true; out.darkSchemeClass = out.darkSchemeClass || '[data-theme="dark"]'; }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sh of sheets) { try { walk(sh.cssRules); } catch (e) { /* cross-origin sheet */ } }
  if (isDark(cs(document.documentElement).colorScheme)) out.hasDarkScheme = true;
  return out;
}`;

const SECTIONS_SOURCE = String.raw`() => {
  document.querySelectorAll("details:not([open])").forEach((d) => { d.setAttribute("open", ""); d.setAttribute("data-flow-opened", ""); });
  const root = document.querySelector("main") || document.body;
  const kids = Array.from(root.children).filter((c) => c.id || c.matches("h1,h2,h3") || c.querySelector("h1,h2,h3"));
  const sections = kids.slice(0, 8).map((c) => {
    const h = c.matches("h1,h2,h3") ? c : c.querySelector("h1,h2,h3");
    const r = c.getBoundingClientRect();
    const label = ((h && h.textContent) || c.id || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return { section: label, selector: c.id ? "#" + c.id : c.tagName.toLowerCase() + ":nth-child(" + (Array.from(root.children).indexOf(c) + 1) + ")", top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
  });
  return { innerHeight: window.innerHeight, sections };
}`;

const SECTIONS_RESTORE_SOURCE = String.raw`() => {
  const opened = document.querySelectorAll("[data-flow-opened]");
  opened.forEach((d) => { d.removeAttribute("open"); d.removeAttribute("data-flow-opened"); });
  return opened.length;
}`;

export function heuristicsProbeScript(): string {
  return PROBE_SOURCE;
}

export function sectionsScript(): string {
  return SECTIONS_SOURCE;
}

export function sectionsRestoreScript(): string {
  return SECTIONS_RESTORE_SOURCE;
}

export type HeuristicViewport = {
  name: string;
  width: number;
  colorScheme?: "light" | "dark";
};

export type HeuristicVerdict = {
  defects: string[];
  smells: string[];
  envSkips: string[];
  refusedIgnores: string[];
};

const NEVER_IGNORED = /^\[[^\]]*\] (leak|past-viewport):/;

export function judgeHeuristics(
  h: HeuristicsCapture,
  vp: HeuristicViewport,
  ignorePatterns: string[],
): HeuristicVerdict {
  const t = HEURISTIC_THRESHOLDS;
  const tag = `[${vp.name}]`;
  const defects: string[] = [];
  const smells: string[] = [];
  const envSkips: string[] = [];

  if (Math.abs(h.innerWidth - vp.width) > t.viewportMismatchPx) {
    envSkips.push(
      `${tag} viewport-mismatch: innerWidth ${h.innerWidth} vs requested ${vp.width}`,
    );
  }

  for (const l of h.leakedText) {
    defects.push(`${tag} leak: ${l.kind} "${l.sample}" at ${l.path}`);
  }
  for (const a of h.anchorLandings) {
    if (a.targetTop < a.chromeBottom - t.anchorTolerancePx) {
      defects.push(
        `${tag} anchor: ${a.href} lands at ${a.targetTop}px, under ${a.chromeBottom}px of sticky chrome`,
      );
    }
  }
  for (const p of h.pastViewport) {
    defects.push(
      `${tag} past-viewport: ${p.path} extends to ${p.right}px (viewport ${h.innerWidth}px)`,
    );
  }

  const darkApplied = vp.colorScheme !== "dark" || h.bodyLuminance < 0.25;
  if (!darkApplied) envSkips.push(`${tag} dark-scheme-not-applied`);
  for (const c of darkApplied ? h.lowContrast : []) {
    const line = `${tag} contrast: ratio ${c.ratio} at ${c.path}`;
    if (c.ratio < t.contrastDefect) defects.push(line);
    else if (c.ratio < (c.large ? t.contrastLarge : t.contrastNormal)) {
      smells.push(line);
    }
  }

  for (const b of h.tallBlocks) {
    if (
      b.height >= t.wallMinPx &&
      b.height >= t.wallPageShare * h.scrollHeight
    ) {
      smells.push(
        `${tag} wall: ${b.path} is ${b.height}px tall of a ${h.scrollHeight}px page`,
      );
    }
  }
  for (const d of h.duplicateControls) {
    smells.push(
      `${tag} duplicate: ${d.role} "${d.name}" appears ${d.count} times`,
    );
  }
  for (const r of h.repeatedText) {
    smells.push(`${tag} repeated: "${r.sample}" appears ${r.count} times`);
  }
  for (const c of h.clippedText) {
    smells.push(`${tag} clipped: ${c.path} hides ${c.overflowPx}px of text`);
  }
  if (vp.width <= t.crampedMaxViewport) {
    for (const r of h.crampedRows) {
      if (
        r.children >= t.crampedMinChildren &&
        (r.minChildWidth < t.crampedMinChildPx || r.truncated)
      ) {
        smells.push(
          `${tag} cramped-row: ${r.path} fits ${r.children} children in one row, narrowest ${r.minChildWidth}px${r.truncated ? ", text truncated" : ""}`,
        );
      }
    }
  }
  for (const s of h.headingScale) {
    if (s.ratio < t.flatHeadingRatio && s.sameWeight) {
      smells.push(
        `${tag} flat-hierarchy: ${s.pair} size ratio ${s.ratio} at equal weight`,
      );
    }
  }

  const refused = new Set<string>();
  const keep = (m: string): boolean => {
    const hit = ignorePatterns.filter((p) => p.length > 0 && m.includes(p));
    if (hit.length === 0) return true;
    if (NEVER_IGNORED.test(m)) {
      for (const p of hit) refused.add(p);
      return true;
    }
    return false;
  };
  return {
    defects: defects.filter(keep),
    smells: smells.filter(keep),
    envSkips,
    refusedIgnores: [...refused],
  };
}
