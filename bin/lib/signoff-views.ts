/**
 * Pure view vocabulary for UI sign-off evidence: which viewports a SUBJECTIVE
 * item names, which view each attached screenshot shows, and which named
 * views have no shot. Shared by the Test Steps lint and the gate evidence.
 */
import * as path from "node:path";
import {
  DESKTOP_TOKENS,
  isPhoneLabelled,
  TABLET_TOKENS,
} from "./evidence-image-shape";

export type SignoffView =
  | "phone"
  | "tablet"
  | "desktop"
  | "phone-dark"
  | "tablet-dark"
  | "desktop-dark";

export type ItemShot = { view: SignoffView | null; ref: string };

type Light = "phone" | "tablet" | "desktop";
const LIGHT: Light[] = ["phone", "tablet", "desktop"];
const WIDTHS: Record<number, Light> = {
  320: "phone",
  375: "phone",
  390: "phone",
  414: "phone",
  430: "phone",
  768: "tablet",
  1024: "desktop",
  1280: "desktop",
  1440: "desktop",
  1920: "desktop",
};
const DARK_RE = /dark mode|dark theme|\(dark\)|light and dark|-dark\b/i;
const ALT_VIEW_RE = /\((phone|tablet|desktop)(-dark)?\)\s*$/i;
const IMAGE_MARKUP_RE = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;
const REASON_CLAUSE_RE = /\b(?:partial|no screenshot):.*$/i;

function byWidth(w: number): Light {
  return w <= 500 ? "phone" : w < 1000 ? "tablet" : "desktop";
}

/** The item's wording with its evidence clauses and image markup removed. */
export function viewSourceText(fullText: string): string {
  return fullText.replace(IMAGE_MARKUP_RE, " ").replace(REASON_CLAUSE_RE, "");
}

export function requiredViews(itemText: string): SignoffView[] {
  const text = viewSourceText(itemText);
  const found = new Set<Light>();
  for (const m of text.matchAll(/\b(\d{3,4})\s*[x×]\s*\d{2,4}\b/g)) {
    found.add(byWidth(Number(m[1])));
  }
  const widths: number[] = [];
  for (const m of text.matchAll(/\b(\d{3,4})\s?px\b/gi)) widths.push(+m[1]);
  for (const m of text.matchAll(
    /\bat\s+((?:\d{3,4}(?:\s?px)?(?:\s*(?:,|and|\/|&)\s*)?)+)/gi,
  )) {
    for (const n of m[1].matchAll(/\d{3,4}/g)) widths.push(Number(n[0]));
  }
  for (const w of widths) if (WIDTHS[w]) found.add(WIDTHS[w]);
  if (/\b(?:phone|mobile)\b/i.test(text)) found.add("phone");
  if (/\btablet\b/i.test(text)) found.add("tablet");
  if (/\b(?:desktop|wide)\b/i.test(text)) found.add("desktop");
  const base: Light[] =
    found.size === 0 ? ["phone", "desktop"] : LIGHT.filter((v) => found.has(v));
  return DARK_RE.test(text)
    ? [...base, ...base.map((v) => `${v}-dark` as SignoffView)]
    : base;
}

export function shotView(alt: string, ref: string): SignoffView | null {
  const m = alt.match(ALT_VIEW_RE);
  const file = path.basename(ref.split(/[?#]/)[0]);
  const tokens = file.toLowerCase().split(/[-_.\s]+/);
  if (m) {
    const dark = m[2] || tokens.includes("dark");
    return `${m[1].toLowerCase()}${dark ? "-dark" : ""}` as SignoffView;
  }
  let base: Light | null = null;
  if (isPhoneLabelled(file)) base = "phone";
  else if (tokens.some((t) => DESKTOP_TOKENS.has(t))) base = "desktop";
  else if (tokens.some((t) => TABLET_TOKENS.has(t))) base = "tablet";
  if (base === null) return null;
  return (tokens.includes("dark") ? `${base}-dark` : base) as SignoffView;
}

/** Views the item names that no shot shows; `[]` unless every shot is labelled. */
export function missingViews(
  required: SignoffView[],
  shots: ItemShot[],
): SignoffView[] {
  if (shots.some((s) => s.view === null)) return [];
  const have = new Set(shots.map((s) => s.view));
  return required.filter((v) => !have.has(v));
}
