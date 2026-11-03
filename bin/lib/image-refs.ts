/**
 * Image-reference scanning and rewriting for PR bodies: markdown
 * `![alt](target)` and HTML `<img src>` (double, single, or unquoted `src`;
 * self-closing or not; attributes split across lines). Syntax quoted inside
 * code spans or fences is never an image, so every scan skips `codeRanges`.
 */
import * as path from "node:path";
import { codeRanges, inCode } from "./md-code-ranges";

export const ATTACH_MAX_FILES = 50;

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMG_TAG_RE = /<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const ATTR_RE =
  /\s([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/i;

export type ImageRef = {
  kind: "md" | "html";
  alt: string;
  /** Markdown destination, or the `src` attribute value. */
  target: string;
  /** Range of `target` within the body. */
  start: number;
  end: number;
  /** Range of the whole reference (`![..](..)` or `<img ..>`). */
  tagStart: number;
  tagEnd: number;
};

function htmlRef(tag: string, at: number): ImageRef | null {
  const inner = tag.slice(0, -1);
  let src: { value: string; start: number } | null = null;
  let alt = "";
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (name !== "src" && name !== "alt") continue;
    const matchEnd = m.index + m[0].length;
    const quoted = m[2] ?? m[3];
    let value = quoted ?? m[4] ?? "";
    const valueStart = matchEnd - value.length - (quoted === undefined ? 0 : 1);
    if (name === "alt") {
      alt = value;
      continue;
    }
    if (
      m[4] !== undefined &&
      value.endsWith("/") &&
      matchEnd === inner.length
    ) {
      value = value.slice(0, -1);
    }
    src = { value, start: valueStart };
  }
  if (src === null || src.value === "") return null;
  const start = at + src.start;
  return {
    kind: "html",
    alt,
    target: src.value,
    start,
    end: start + src.value.length,
    tagStart: at,
    tagEnd: at + tag.length,
  };
}

/** Every image reference in `body`, code included, in body order. */
function allRefs(body: string): ImageRef[] {
  const out: ImageRef[] = [];
  for (const m of body.matchAll(MD_IMAGE_RE)) {
    const at = m.index ?? 0;
    const end = at + m[0].length - 1;
    out.push({
      kind: "md",
      alt: m[1],
      target: m[2],
      start: end - m[2].length,
      end,
      tagStart: at,
      tagEnd: end + 1,
    });
  }
  for (const m of body.matchAll(IMG_TAG_RE)) {
    const ref = htmlRef(m[0], m.index ?? 0);
    if (ref) out.push(ref);
  }
  return out.sort((a, b) => a.tagStart - b.tagStart);
}

/** Image references in prose; syntax quoted inside code is not an image. */
export function imageRefs(body: string): ImageRef[] {
  const ranges = codeRanges(body);
  return allRefs(body).filter((r) => !inCode(ranges, r.tagStart));
}

export function isLocalTarget(target: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
    !target.startsWith("#") &&
    !target.startsWith("//")
  );
}

export function hasLocalImageRefs(body: string): boolean {
  return imageRefs(body).some((r) => isLocalTarget(r.target));
}

function safeDecode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function placeholder(target: string): string {
  const name = path
    .basename(safeDecode(target))
    .replace(/[\\`*_[\]<>]/g, "\\$&");
  return `_(screenshot not uploaded: ${name})_`;
}

function replaceRanges(
  body: string,
  edits: { start: number; end: number; text: string }[],
): string {
  let out = body;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Swap every local image reference for a visible placeholder; links and
 * plain-text screenshot captions stay, so a stripped body still names each
 * picture. */
export function stripLocalImageRefs(body: string): string {
  return replaceRanges(
    body,
    imageRefs(body)
      .filter((r) => isLocalTarget(r.target))
      .map((r) => ({
        start: r.tagStart,
        end: r.tagEnd,
        text: placeholder(r.target),
      })),
  );
}

/** Swap each reference's target (or `src`) for its hosted URL, touching
 * nothing else in the tag so `width`, `alt` and `style` survive. */
export function renderHostedBody(
  body: string,
  urlByTarget: Map<string, string>,
): string {
  return replaceRanges(
    body,
    imageRefs(body)
      .filter((r) => urlByTarget.has(r.target))
      .map((r) => ({
        start: r.start,
        end: r.end,
        text: urlByTarget.get(r.target) as string,
      })),
  );
}

export type LocalImage = { targets: string[]; abs: string; sha: string };

export type CollectedImages = {
  images: LocalImage[];
  /** Targets resolving outside the worktree (never uploadable). */
  outside: string[];
  /** Targets whose file could not be read. */
  missing: string[];
  /** Targets whose absolute path holds `#`, ambiguous in gh's `file#alt` arg. */
  unattachable: string[];
  /** Local targets that are not png/jpg/gif/webp, which gh cannot attach as images. */
  unsupported: string[];
};

/** Local images grouped by content hash, so `./a.png` and `a.png` — or two
 * copies of one file — share a single upload. */
export function collectLocalImages(
  body: string,
  worktree: string,
  hashFile: (p: string) => string | null,
): CollectedImages {
  const out: CollectedImages = {
    images: [],
    outside: [],
    missing: [],
    unattachable: [],
    unsupported: [],
  };
  const bySha = new Map<string, LocalImage>();
  const seen = new Set<string>();
  for (const ref of imageRefs(body)) {
    if (!isLocalTarget(ref.target) || seen.has(ref.target)) continue;
    seen.add(ref.target);
    const abs = path.resolve(worktree, safeDecode(ref.target));
    const rel = path.relative(worktree, abs);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      out.outside.push(ref.target);
      continue;
    }
    if (!IMAGE_FILE_RE.test(abs)) {
      out.unsupported.push(ref.target);
      continue;
    }
    if (abs.includes("#")) {
      out.unattachable.push(ref.target);
      continue;
    }
    const sha = hashFile(abs);
    if (sha === null) {
      out.missing.push(ref.target);
      continue;
    }
    const known = bySha.get(sha);
    if (known) {
      known.targets.push(ref.target);
    } else {
      const image = { targets: [ref.target], abs, sha };
      bySha.set(sha, image);
      out.images.push(image);
    }
  }
  return out;
}

/** The unique alt text `gh pr edit --attach <file>#<token>` embeds the upload under. */
export function uploadToken(sha: string): string {
  return `flow-img-${sha.slice(0, 16)}`;
}

/** Hosted URL per upload token, read from the embeds gh appended to the PR
 * body: `![token](url)` or `<img alt="token" src="url">`. */
export function harvestTokenUrls(
  remoteBody: string,
  tokens: string[],
): Map<string, string> {
  const wanted = new Set(tokens);
  const out = new Map<string, string>();
  for (const r of allRefs(remoteBody)) {
    if (wanted.has(r.alt) && /^https:\/\//.test(r.target)) {
      out.set(r.alt, r.target);
    }
  }
  return out;
}
