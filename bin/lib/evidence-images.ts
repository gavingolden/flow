import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

export type PromotableImage = { path: string; alt: string };

// Anchored at a token boundary (start, whitespace, or a delimiter) so a long
// unbroken run is scanned once, not once per start position. `=` `:` `,` `;`
// delimit `key=path`, `key:path` and comma/semicolon lists; a leading
// `file://` is consumed whole.
const DELIM = "\\s\"'`()<>[\\],;:=";
const SCREENSHOT_PATH = new RegExp(
  `(?<![^${DELIM}])(?:file://)?[^${DELIM}]*\\.flow-tmp/ui-evidence/[^${DELIM}]*\\.(?:png|jpe?g|webp)`,
  "gi",
);

function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// A screenshot is promotable only when its canonical path stays inside the
// root's `.flow-tmp/ui-evidence/` — blocks `..` traversal and symlink escapes.
function insideEvidence(root: string, abs: string): boolean {
  return isUnder(
    canon(path.join(root, ".flow-tmp", "ui-evidence")),
    canon(abs),
  );
}

/**
 * Screenshots named as text in captured evidence (`.flow-tmp/ui-evidence/…`)
 * would publish as dead path strings; this appends each one that exists under
 * a root to `images` so it uploads like an explicit `--image`. Paths already
 * in `images` (compared by canonical path) and missing files are skipped.
 * Only paths whose canonical form stays inside a root's
 * `.flow-tmp/ui-evidence/` are promoted. Reads the filesystem (`exists`,
 * realpath).
 */
export function promoteEvidenceImages(
  output: string,
  images: PromotableImage[],
  roots: string[],
  exists: (p: string) => boolean = existsSync,
): PromotableImage[] {
  if (roots.length === 0) return images;
  const seen = new Set(
    images.map((i) => canon(path.resolve(roots[0], i.path))),
  );
  const out = [...images];
  for (const [match] of output.matchAll(SCREENSHOT_PATH)) {
    const found = match.replace(/^file:\/\//i, "");
    let abs: string | undefined;
    let emit = found;
    if (path.isAbsolute(found)) {
      if (roots.some((r) => insideEvidence(r, found)) && exists(found))
        abs = found;
    } else if (/^(?:\.\/)?\.flow-tmp\//.test(found)) {
      const root = roots.find((r) => {
        const cand = path.resolve(r, found);
        return insideEvidence(r, cand) && exists(cand);
      });
      if (root !== undefined) {
        abs = path.resolve(root, found);
        if (root !== roots[0]) emit = abs;
      }
    }
    if (abs === undefined) continue;
    const key = canon(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: emit, alt: path.basename(abs) });
  }
  return out;
}
