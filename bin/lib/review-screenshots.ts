/**
 * Screenshot upload planning for `flow-review-finalize`'s body write.
 *
 * `gh pr edit --attach <file>#<alt>` (gh >= 2.99.0) uploads a local image
 * and rewrites the body's matching `![alt](relative/path)` reference to the
 * hosted URL — but only in the PR, never in the local body file. The ledger
 * therefore stores sha256 → hosted URL, so a later review pass in the same
 * worktree substitutes the URL instead of re-uploading.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const BODY_MAX_CHARS = 60000;
export const ATTACH_MAX_FILES = 50;
const ATTACH_MIN_VERSION = [2, 99, 0];
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export type Ledger = Record<string, string>;
export type AttachItem = { target: string; arg: string; sha: string };
export type ScreenshotSkip =
  | "screenshots_gh_too_old"
  | "screenshots_body_too_large"
  | "screenshots_too_many";

export function ghSupportsAttach(versionOutput: string): boolean {
  const m = versionOutput.match(/gh version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (got[i] !== ATTACH_MIN_VERSION[i]) return got[i] > ATTACH_MIN_VERSION[i];
  }
  return true;
}

export function ledgerPath(worktree: string): string {
  return path.join(worktree, ".flow-tmp", "ui-evidence", "uploaded.json");
}

export function parseLedger(raw: string | null): Ledger {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function sha256File(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function isLocalTarget(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#");
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Resolve a local image target, rejecting anything that escapes the worktree or isn't an image file. */
function resolveLocalImage(worktree: string, target: string): string | null {
  const abs = path.resolve(worktree, decodeURI(target));
  const rel = path.relative(worktree, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!IMAGE_FILE_RE.test(abs)) return null;
  return abs;
}

export function hasLocalImageRefs(body: string): boolean {
  return [...body.matchAll(IMAGE_RE)].some((m) => isLocalTarget(m[2]));
}

/** Drop local image references (whole line when alone on it); links stay. */
export function stripLocalImageRefs(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const m = line.trim().match(/^!\[[^\]]*\]\(([^)\s]+)\)$/);
      return !(m && isLocalTarget(m[1]));
    })
    .join("\n")
    .replace(IMAGE_RE, (whole, _alt, target) =>
      isLocalTarget(target) ? "" : whole,
    );
}

export type ScreenshotPlan = {
  /** Body with ledger-known references swapped for their hosted URLs. */
  body: string;
  /** Same, with every remaining local image reference removed. */
  bodyWithoutImages: string;
  attach: AttachItem[];
  skip?: { step: ScreenshotSkip; reason: string };
};

export function planScreenshots(input: {
  body: string;
  worktree: string;
  attachSupported: boolean;
  ledger: Ledger;
  hashFile: (p: string) => string | null;
}): ScreenshotPlan {
  const shaByTarget = new Map<string, string>();
  for (const m of input.body.matchAll(IMAGE_RE)) {
    if (!isLocalTarget(m[2]) || shaByTarget.has(m[2])) continue;
    const abs = resolveLocalImage(input.worktree, m[2]);
    if (abs === null) continue;
    const sha = input.hashFile(abs);
    if (sha !== null) shaByTarget.set(m[2], sha);
  }

  const body = input.body.replace(IMAGE_RE, (whole, alt, target) => {
    const url = input.ledger[shaByTarget.get(target) ?? ""];
    return url ? `![${alt}](${url})` : whole;
  });
  const bodyWithoutImages = stripLocalImageRefs(body);

  const attach: AttachItem[] = [];
  for (const m of body.matchAll(IMAGE_RE)) {
    const sha = shaByTarget.get(m[2]);
    if (sha === undefined || attach.some((a) => a.target === m[2])) continue;
    const abs = resolveLocalImage(input.worktree, m[2]);
    if (abs === null) continue;
    const alt = m[1].replace(/#/g, " ");
    attach.push({ target: m[2], arg: alt ? `${abs}#${alt}` : abs, sha });
  }

  if (attach.length === 0) return { body, bodyWithoutImages, attach };
  if (attach.length > ATTACH_MAX_FILES) {
    return {
      body,
      bodyWithoutImages,
      attach: [],
      skip: {
        step: "screenshots_too_many",
        reason: `${attach.length} screenshots (> ${ATTACH_MAX_FILES}); image references left out, screenshots are local-only`,
      },
    };
  }
  if (!input.attachSupported) {
    return {
      body,
      bodyWithoutImages,
      attach: [],
      skip: {
        step: "screenshots_gh_too_old",
        reason:
          "gh is older than 2.99.0 (no --attach); screenshots are local-only — run `brew upgrade gh`",
      },
    };
  }
  if (body.length > BODY_MAX_CHARS) {
    return {
      body,
      bodyWithoutImages,
      attach: [],
      skip: {
        step: "screenshots_body_too_large",
        reason: `body is ${body.length} chars (> ${BODY_MAX_CHARS}); image references left out, screenshots are local-only`,
      },
    };
  }
  return { body, bodyWithoutImages, attach };
}

/**
 * After a successful attach, pair each local reference with the hosted URL
 * gh wrote in its place. gh keeps image order and alt text, so the n-th
 * image in the pushed body is the n-th image in the PR body. Any shape
 * surprise returns no pairs — the file is simply re-uploaded next pass.
 */
export function hostedUrls(
  pushedBody: string,
  remoteBody: string,
  attach: AttachItem[],
): Map<string, string> {
  const local = [...pushedBody.matchAll(IMAGE_RE)];
  const remote = [...remoteBody.matchAll(IMAGE_RE)];
  const out = new Map<string, string>();
  if (local.length !== remote.length) return out;
  local.forEach((m, i) => {
    const url = remote[i][2];
    if (attach.some((a) => a.target === m[2]) && /^https:\/\//.test(url)) {
      out.set(m[2], url);
    }
  });
  return out;
}

export function applyHostedUrls(
  body: string,
  urls: Map<string, string>,
): string {
  return body.replace(IMAGE_RE, (whole, alt, target) => {
    const url = urls.get(target);
    return url ? `![${alt}](${url})` : whole;
  });
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/**
 * The `body_edit` write: push the body, attaching each not-yet-uploaded
 * screenshot. The body is always written — every screenshot problem
 * degrades to a named skip plus a push without image references.
 */
export function pushBodyWithScreenshots(
  io: {
    exec: (argv: string[]) => ExecResult;
    readFile: (p: string) => string | null;
    writeFile: (p: string, content: string) => void;
    hashFile: (p: string) => string | null;
  },
  args: {
    prStr: string;
    bodyFile: string;
    worktree: string;
    attachSupported: boolean;
  },
): {
  edit: ExecResult;
  uploaded: number;
  skips: { step: string; reason: string }[];
} {
  const original = io.readFile(args.bodyFile) ?? "";
  const ledgerFile = ledgerPath(args.worktree);
  const ledger = parseLedger(io.readFile(ledgerFile));
  const plan = planScreenshots({
    body: original,
    worktree: args.worktree,
    attachSupported: args.attachSupported,
    ledger,
    hashFile: io.hashFile,
  });
  const skips: { step: string; reason: string }[] = [];
  let uploaded = 0;
  if (plan.skip) skips.push(plan.skip);
  if (plan.body !== original) io.writeFile(args.bodyFile, plan.body);

  // A body pushed without its images goes through a sibling file so
  // the local body keeps its references for a later pass.
  const noImagesFile = `${args.bodyFile}.noimg.md`;
  const pushWithoutImages = (): ExecResult => {
    io.writeFile(noImagesFile, plan.bodyWithoutImages);
    const result = io.exec([
      "gh",
      "pr",
      "edit",
      args.prStr,
      "--body-file",
      noImagesFile,
    ]);
    try {
      fs.rmSync(noImagesFile, { force: true });
    } catch {
      // best-effort cleanup — a leftover sibling file is harmless
    }
    return result;
  };

  let edit: ExecResult;
  if (plan.skip) {
    edit = pushWithoutImages();
  } else {
    edit = io.exec([
      "gh",
      "pr",
      "edit",
      args.prStr,
      "--body-file",
      args.bodyFile,
      ...plan.attach.flatMap((a) => ["--attach", a.arg]),
    ]);
    if (edit.exitCode !== 0 && plan.attach.length > 0) {
      // gh may have written the body with only some attachments; the
      // retry makes the PR body deterministic again.
      skips.push({
        step: "screenshots_upload_failed",
        reason: `screenshots are local-only — re-run review to retry (${edit.stderr || "gh pr edit --attach failed"})`,
      });
      edit = pushWithoutImages();
    } else if (edit.exitCode === 0 && plan.attach.length > 0) {
      uploaded = plan.attach.length;
      const view = io.exec([
        "gh",
        "pr",
        "view",
        args.prStr,
        "--json",
        "body",
        "--jq",
        ".body",
      ]);
      const urls =
        view.exitCode === 0
          ? hostedUrls(plan.body, view.stdout, plan.attach)
          : new Map<string, string>();
      if (urls.size > 0) {
        for (const a of plan.attach) {
          const url = urls.get(a.target);
          if (url) ledger[a.sha] = url;
        }
        io.writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
        io.writeFile(args.bodyFile, applyHostedUrls(plan.body, urls));
      } else {
        skips.push({
          step: "screenshots_url_unresolved",
          reason:
            view.exitCode === 0
              ? "could not match hosted URLs in the PR body; screenshots will re-upload next pass"
              : `gh pr view failed (${view.stderr.trim() || view.exitCode}); screenshots will re-upload next pass`,
        });
      }
    }
  }
  return { edit, uploaded, skips };
}
