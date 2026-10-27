import { existsSync } from "node:fs";
import * as path from "node:path";

export type PromotableImage = { path: string; alt: string };

const SCREENSHOT_PATH =
  /[^\s"'`()<>[\]]*\.flow-tmp\/ui-evidence\/[^\s"'`()<>[\]]*\.(?:png|jpe?g|webp)/gi;

function isUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Screenshots named as text in captured evidence (`.flow-tmp/ui-evidence/…`)
 * would publish as dead path strings; this appends each one that exists under
 * a root to `images` so it uploads like an explicit `--image`. Paths already
 * in `images` (compared by resolved absolute path) and missing files are
 * skipped. Pure apart from the injected `exists` probe.
 */
export function promoteEvidenceImages(
  output: string,
  images: PromotableImage[],
  roots: string[],
  exists: (p: string) => boolean = existsSync,
): PromotableImage[] {
  if (roots.length === 0) return images;
  const seen = new Set(images.map((i) => path.resolve(roots[0], i.path)));
  const out = [...images];
  for (const [found] of output.matchAll(SCREENSHOT_PATH)) {
    let abs: string | undefined;
    let emit = found;
    if (path.isAbsolute(found)) {
      if (roots.some((r) => isUnder(r, found)) && exists(found)) abs = found;
    } else if (/^(?:\.\/)?\.flow-tmp\//.test(found)) {
      const root = roots.find((r) => exists(path.resolve(r, found)));
      if (root !== undefined) {
        abs = path.resolve(root, found);
        if (root !== roots[0]) emit = abs;
      }
    }
    if (abs === undefined || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ path: emit, alt: path.basename(abs) });
  }
  return out;
}
