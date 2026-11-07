/**
 * Upload-then-render screenshot push for `flow-review-finalize` and
 * `flow-pr-attach`.
 *
 * `gh pr edit <pr> --attach <abs>#<token>` (gh >= 2.99.0) uploads a local
 * image and, with no body flag, appends `![token](hosted-url)` to the PR body.
 * gh is used only as the uploader: flow reads each hosted URL back by its
 * unique token, rewrites markdown and `<img src>` references itself, and
 * pushes the final body once. The sha256 → URL ledger keeps a later pass in
 * the same worktree from re-uploading.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyExternalImages,
  countRepoRawLinks,
  fetchRepoImage,
  hasRepoRawLinks,
} from "./image-hosts";
import {
  ATTACH_MAX_FILES,
  collectLocalImages,
  harvestTokenUrls,
  hasLocalImageRefs,
  renderHostedBody,
  stripLocalImageRefs,
  uploadToken,
  type CollectedImages,
  type LocalImage,
} from "./image-refs";
import { ensureFlowExcludes } from "./worktree-marker";

export {
  ATTACH_MAX_FILES,
  collectLocalImages,
  harvestTokenUrls,
  hasLocalImageRefs,
  renderHostedBody,
  stripLocalImageRefs,
  uploadToken,
  type LocalImage,
} from "./image-refs";
export { classifyExternalImages } from "./image-hosts";

/** Final-body guard: a body this long is pushed without uploading anything. */
export const BODY_MAX_CHARS = 250000;
/**
 * Sizes a batch against the live body. A live 98,572-char PR body proves the
 * gh path accepts more than 65,536; gh's own rejection stays the authority.
 */
const TRANSIENT_BODY_MAX = 262144;
const EMBED_COST_CHARS = 120;
const ATTACH_MIN_VERSION = [2, 99, 0];

export type Ledger = Record<string, string>;
export type ScreenshotSkip =
  | "screenshots_gh_too_old"
  | "screenshots_body_too_large"
  | "screenshots_outside_worktree"
  | "screenshots_file_unusable"
  | "screenshots_upload_failed"
  | "screenshots_url_unresolved"
  | "screenshots_external_host";
type Skip = { step: ScreenshotSkip; reason: string };

export type ExecResult = { stdout: string; stderr: string; exitCode: number };
export type ScreenshotIo = {
  exec: (argv: string[]) => ExecResult;
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
  hashFile: (p: string) => string | null;
  /** Binary writer for re-hosted bytes; without it, same-repo links are only flagged. */
  writeBytes?: (p: string, bytes: Uint8Array) => void;
};
export type PushArgs = {
  prStr: string;
  bodyFile: string;
  worktree: string;
  /** Anything but `true` makes the engine probe `gh --version` itself when the body needs an upload. */
  attachSupported?: boolean;
  /** Names what to re-run, since the reason also prints where "re-run" is ambiguous. */
  retryHint?: string;
};
export type PushResult = {
  edit: ExecResult;
  uploaded: number;
  reused: number;
  rehosted: number;
  batches: number;
  /** Unique same-repo image links still in the pushed body (they load from the repo). */
  repoLinked: number;
  skips: Skip[];
  /** Hosted URL per body reference, so a caller can mirror the rewrite into its own copy. */
  urlByTarget: Map<string, string>;
};

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

/** Writes re-hosted bytes under the gitignored `.flow-tmp/` scratch dir only. */
export function writeScratchBytes(
  worktree: string,
  p: string,
  bytes: Uint8Array,
): void {
  ensureFlowExcludes(worktree);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
}

/** True when the body holds anything the engine would upload or re-host. */
export function needsAttach(body: string): boolean {
  return hasLocalImageRefs(body) || hasRepoRawLinks(body);
}

type Ctx = {
  io: ScreenshotIo;
  args: PushArgs;
  skips: Skip[];
  ledger: Ledger;
  urlByTarget: Map<string, string>;
  rehostErrors: Map<string, string>;
  hostedShas: Set<string>;
  stats: {
    uploaded: number;
    reused: number;
    rehosted: number;
    batches: number;
  };
};

function host(ctx: Ctx, image: LocalImage, url: string): void {
  ctx.hostedShas.add(image.sha);
  for (const t of image.targets) ctx.urlByTarget.set(t, url);
}

function viewBody(ctx: Ctx): ExecResult {
  return ctx.io.exec([
    "gh",
    "pr",
    "view",
    ctx.args.prStr,
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
}

/** Pushes `content` through a sibling file so the local body keeps its references. */
function pushSibling(ctx: Ctx, content: string): ExecResult {
  const sibling = `${ctx.args.bodyFile}.pushed.md`;
  ctx.io.writeFile(sibling, content);
  const result = ctx.io.exec([
    "gh",
    "pr",
    "edit",
    ctx.args.prStr,
    "--body-file",
    sibling,
  ]);
  try {
    fs.rmSync(sibling, { force: true });
  } catch {
    // best-effort cleanup — a leftover sibling file is harmless
  }
  return result;
}

function unusableSkips(found: CollectedImages): Skip[] {
  const out: Skip[] = [];
  if (found.outside.length > 0) {
    out.push({
      step: "screenshots_outside_worktree",
      reason: `${found.outside.length} screenshot(s) outside the worktree were not uploaded: ${found.outside[0]}`,
    });
  }
  const unusable = [...found.missing, ...found.unattachable];
  if (unusable.length > 0) {
    out.push({
      step: "screenshots_file_unusable",
      reason: `${unusable.length} screenshot(s) could not be uploaded (file unreadable or '#' in its path): ${unusable[0]}`,
    });
  }
  if (found.unsupported.length > 0) {
    out.push({
      step: "screenshots_file_unusable",
      reason: `${found.unsupported.length} screenshot(s) have an unsupported image type (png/jpg/gif/webp only): ${found.unsupported[0]}`,
    });
  }
  return out;
}

function prRepoOf(ctx: Ctx): string {
  const r = ctx.io.exec([
    "gh",
    "pr",
    "view",
    ctx.args.prStr,
    "--json",
    "url",
    "--jq",
    ".url",
  ]);
  const m = r.stdout
    .trim()
    .match(/^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/);
  return r.exitCode === 0 && m ? m[1] : "";
}

/** Fetch a same-repo image into `.flow-tmp/pr-images/rehosted/` for native upload. */
function rehost(
  ctx: Ctx,
  repo: string,
  r: { src: string; ref: string; path: string },
): LocalImage | string {
  if (!ctx.io.writeBytes) return "no binary writer available";
  const got = fetchRepoImage(ctx.io.exec, repo, r);
  if ("error" in got) return got.error;
  const sha = createHash("sha256").update(got.bytes).digest("hex");
  const name = path.basename(r.path).replace(/[^\w.-]/g, "_");
  const abs = path.join(
    ctx.args.worktree,
    ".flow-tmp",
    "pr-images",
    "rehosted",
    `${sha.slice(0, 16)}-${name}`,
  );
  try {
    ctx.io.writeBytes(abs, got.bytes);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return { targets: [r.src], abs, sha };
}

function uploadBatches(ctx: Ctx, queue: LocalImage[], liveBody: string): void {
  const { io, args, skips, stats } = ctx;
  let live = liveBody;
  let failed = 0;
  let unresolved = 0;
  let failure = "";
  while (queue.length > 0) {
    const room = Math.floor(
      (TRANSIENT_BODY_MAX - live.length) / EMBED_COST_CHARS,
    );
    if (room <= 0) {
      skips.push({
        step: "screenshots_body_too_large",
        reason: `PR body is ${live.length} chars, leaving no room to attach ${queue.length} more screenshot(s); they stay local-only`,
      });
      break;
    }
    const batch = queue.splice(0, Math.min(ATTACH_MAX_FILES, room));
    stats.batches++;
    const up = io.exec([
      "gh",
      "pr",
      "edit",
      args.prStr,
      ...batch.flatMap((i) => ["--attach", `${i.abs}#${uploadToken(i.sha)}`]),
    ]);
    // Read back even after a failed upload: gh may have attached some files.
    const view = viewBody(ctx);
    const urls =
      view.exitCode === 0
        ? harvestTokenUrls(
            view.stdout,
            batch.map((i) => uploadToken(i.sha)),
          )
        : new Map<string, string>();
    if (view.exitCode === 0) live = view.stdout;
    for (const image of batch) {
      const url = urls.get(uploadToken(image.sha));
      if (url) {
        ctx.ledger[image.sha] = url;
        host(ctx, image, url);
        stats.uploaded++;
      } else if (up.exitCode === 0) {
        unresolved++;
      } else {
        failed++;
      }
    }
    if (up.exitCode !== 0 || view.exitCode !== 0) {
      failure =
        up.stderr.trim() ||
        view.stderr.trim() ||
        "gh pr edit --attach / gh pr view failed";
      failed += queue.length;
      queue.length = 0;
    }
  }
  if (failed > 0) {
    skips.push({
      step: "screenshots_upload_failed",
      reason: `${failed} screenshot(s) not uploaded and left local-only — ${args.retryHint ?? "re-run to retry"} (${failure})`,
    });
  }
  if (unresolved > 0) {
    skips.push({
      step: "screenshots_url_unresolved",
      reason: `could not find ${unresolved} uploaded screenshot(s) in the PR body; they will re-upload next pass`,
    });
  }
}

/** Re-host same-repo links, then upload every pending image in batches. Returns the flagged outside-host links. */
function runUpload(
  ctx: Ctx,
  body: string,
  pending: LocalImage[],
  repo: string,
): string[] {
  const { io, skips, stats } = ctx;
  const found = classifyExternalImages(body, repo);
  // A rehostable src stays flagged until a hosted URL replaces it (see stillFlagged).
  const flagged = new Set([
    ...found.flagged,
    ...found.rehostable.map((r) => r.src),
  ]);
  const rehostShas = new Set<string>();
  for (const r of found.rehostable) {
    const got = rehost(ctx, repo, r);
    if (typeof got === "string") {
      ctx.rehostErrors.set(r.src, got);
      continue;
    }
    rehostShas.add(got.sha);
    const url = ctx.ledger[got.sha];
    if (url) {
      host(ctx, got, url);
      stats.reused++;
      continue;
    }
    const twin = pending.find((p) => p.sha === got.sha);
    if (twin) twin.targets.push(...got.targets);
    else pending.push(got);
  }
  if (pending.length > 0) {
    const view = viewBody(ctx);
    if (view.exitCode !== 0) {
      skips.push({
        step: "screenshots_upload_failed",
        reason: `${pending.length} screenshot(s) not uploaded and left local-only — ${ctx.args.retryHint ?? "re-run to retry"}; could not read the PR body (${view.stderr.trim() || view.exitCode})`,
      });
    } else {
      let live = view.stdout;
      // gh rewrites a body reference to an attached file in place instead of
      // appending an embed, so start from a body with no local references.
      if (hasLocalImageRefs(live)) {
        const reset = stripLocalImageRefs(
          renderHostedBody(body, ctx.urlByTarget),
        );
        const result = pushSibling(ctx, reset);
        if (result.exitCode === 0) live = reset;
      }
      uploadBatches(ctx, pending, live);
      if (stats.uploaded > 0) {
        io.writeFile(
          ledgerPath(ctx.args.worktree),
          JSON.stringify(ctx.ledger, null, 2) + "\n",
        );
      }
    }
  }
  stats.rehosted = [...rehostShas].filter((s) => ctx.hostedShas.has(s)).length;
  return [...flagged];
}

/**
 * The `body_edit` write: upload each not-yet-hosted screenshot, render the
 * hosted URLs into the body, and push it once. The final push always runs, so
 * no raw upload token stays on the PR; every screenshot problem degrades to a
 * named skip plus a visible placeholder where the image would have been.
 */
export function pushBodyWithScreenshots(
  io: ScreenshotIo,
  args: PushArgs,
): PushResult {
  const original = io.readFile(args.bodyFile) ?? "";
  const ctx: Ctx = {
    io,
    args,
    skips: [],
    ledger: parseLedger(io.readFile(ledgerPath(args.worktree))),
    urlByTarget: new Map(),
    rehostErrors: new Map(),
    hostedShas: new Set(),
    stats: { uploaded: 0, reused: 0, rehosted: 0, batches: 0 },
  };
  const found = collectLocalImages(original, args.worktree, io.hashFile);
  ctx.skips.push(...unusableSkips(found));
  const pending: LocalImage[] = [];
  for (const image of found.images) {
    const url = ctx.ledger[image.sha];
    if (url) {
      host(ctx, image, url);
      ctx.stats.reused++;
    } else {
      pending.push(image);
    }
  }

  const body = renderHostedBody(original, ctx.urlByTarget);
  const wantsUpload = pending.length > 0 || hasRepoRawLinks(body);
  let flagged = classifyExternalImages(body, "").flagged;
  let edit: ExecResult;
  let repoLinked = 0;
  let prRepo: string | undefined;
  const repoOf = (): string => (prRepo ??= prRepoOf(ctx));
  try {
    const attachOk =
      wantsUpload &&
      (args.attachSupported === true ||
        ghSupportsAttach(io.exec(["gh", "--version"]).stdout));
    if (wantsUpload && !attachOk) {
      ctx.skips.push({
        step: "screenshots_gh_too_old",
        reason:
          "gh is older than 2.99.0 (no --attach); screenshots are local-only — run `brew upgrade gh`",
      });
    } else if (wantsUpload && body.length > BODY_MAX_CHARS) {
      ctx.skips.push({
        step: "screenshots_body_too_large",
        reason: `body is ${body.length} chars (> ${BODY_MAX_CHARS}); screenshots are local-only`,
      });
    } else if (wantsUpload) {
      flagged = runUpload(
        ctx,
        body,
        pending,
        hasRepoRawLinks(body) ? repoOf() : "",
      );
    }
  } finally {
    const finalBody = renderHostedBody(original, ctx.urlByTarget);
    if (finalBody !== original) io.writeFile(args.bodyFile, finalBody);
    const pushed = stripLocalImageRefs(finalBody);
    edit =
      pushed === finalBody
        ? io.exec([
            "gh",
            "pr",
            "edit",
            args.prStr,
            "--body-file",
            args.bodyFile,
          ])
        : pushSibling(ctx, pushed);
    if (hasRepoRawLinks(pushed)) {
      const repo = repoOf();
      repoLinked =
        repo === ""
          ? countRepoRawLinks(pushed)
          : countRepoRawLinks(pushed, repo);
    }
  }
  const stillFlagged = flagged.filter((src) => !ctx.urlByTarget.has(src));
  if (stillFlagged.length > 0) {
    const shown = stillFlagged
      .slice(0, 3)
      .map((src) => {
        const err = ctx.rehostErrors.get(src);
        return err ? `${src} (${err})` : src;
      })
      .join(", ");
    ctx.skips.push({
      step: "screenshots_external_host",
      reason: `${stillFlagged.length} image(s) still embedded from outside GitHub attachments (not private to the PR): ${shown}${stillFlagged.length > 3 ? ", …" : ""}`,
    });
  }
  return {
    edit,
    ...ctx.stats,
    repoLinked,
    skips: ctx.skips,
    urlByTarget: ctx.urlByTarget,
  };
}
