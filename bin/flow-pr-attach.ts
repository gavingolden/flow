#!/usr/bin/env bun
/**
 * Puts an agent-authored body's images on a PR through GitHub's native
 * attachments — the one sanctioned way to show a screenshot gallery on a PR,
 * so nothing improvises an image-hosting branch, gist, or outside host.
 *
 * Usage:
 *   flow-pr-attach --pr <n> --body-file <file> [--worktree <dir>] [--json]
 *
 * The body references images by relative path (`![alt](.flow-tmp/pr-images/a.png)`
 * or `<img src=".flow-tmp/pr-images/a.png" width="260">`). Every local image is
 * uploaded (`gh pr edit --attach`, gh >= 2.99.0, batches of 50), the references
 * are rewritten to the hosted URLs, and the body is pushed once. Same-repo
 * `?raw=true` links are re-hosted the same way; any other outside-hosted image
 * is reported but never blocks. The body file keeps its local paths except for
 * hosted URLs written back, so a re-run after a fix starts from your paths;
 * an unchanged image is never uploaded twice (sha256 ledger).
 *
 * Exit codes:
 *   0  body pushed and every local image hosted (an outside-host note is stderr only)
 *   1  body not pushed
 *   2  bad arguments, or a PR that is not this pipeline's own
 *   3  body pushed but at least one local image stayed local-only
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR } from "./lib/paths";
import { checkOwnPipelinePr } from "./lib/pipeline-pr-ownership";
import { resolveSlugAmbient } from "./lib/session-identity";
import { readState } from "./lib/state";
import {
  hasLocalImageRefs,
  pushBodyWithScreenshots,
  renderHostedBody,
  sha256File,
  type ExecResult,
} from "./lib/review-screenshots";
import { ensureFlowExcludes } from "./lib/worktree-marker";

export type ParsedArgs =
  | { pr: number; bodyFile: string; worktree?: string; json: boolean }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let pr: number | undefined;
  let bodyFile: string | undefined;
  let worktree: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a !== "--pr" && a !== "--body-file" && a !== "--worktree") {
      return { error: `unknown argument: ${a}` };
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      return { error: `${a} requires a value` };
    }
    if (a === "--pr") {
      if (!/^[1-9]\d*$/.test(v)) return { error: `invalid --pr value: ${v}` };
      pr = Number(v);
    } else if (a === "--body-file") bodyFile = v;
    else worktree = v;
  }
  if (pr === undefined) return { error: "--pr is required" };
  if (bodyFile === undefined) return { error: "--body-file is required" };
  return { pr, bodyFile, worktree, json };
}

export type Deps = {
  exec?: (argv: string[]) => ExecResult;
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
  hashFile?: (p: string) => string | null;
  writeBytes?: (p: string, bytes: Uint8Array) => void;
  removeFile?: (p: string) => void;
  /** Keeps `.flow-tmp/` out of git before any re-hosted bytes are written. */
  ensureExcludes?: (worktree: string) => void;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

function defaultExec(argv: string[]): ExecResult {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    exitCode: r.exitCode ?? 1,
  };
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function defaultWriteBytes(p: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
}

/** Inside a pipeline, the upload root must be that pipeline's own worktree. */
function worktreeNotOwned(worktree: string, deps: Deps): string | null {
  const slug = resolveSlugAmbient({ env: deps.env });
  if (slug === null) return null;
  const owned = readState(slug, deps.stateDir ?? FLOW_STATE_DIR)?.worktree;
  if (!owned) return null;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(worktree) === real(owned)
    ? null
    : `worktree-not-owned: ${worktree} is not this pipeline's worktree (${owned})`;
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const exec = deps.exec ?? defaultExec;
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const hashFile = deps.hashFile ?? sha256File;
  const writeBytes = deps.writeBytes ?? defaultWriteBytes;
  const removeFile =
    deps.removeFile ?? ((p: string) => fs.rmSync(p, { force: true }));
  const ensureExcludes = deps.ensureExcludes ?? ensureFlowExcludes;
  const fail = (code: number, message: string): number => {
    console.error(`flow-pr-attach: ${message}`);
    return code;
  };

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(
      "usage: flow-pr-attach --pr <n> --body-file <file> [--worktree <dir>] [--json]",
    );
    return fail(2, parsed.error);
  }
  const owned = checkOwnPipelinePr(parsed.pr, deps);
  if (!owned.ok) return fail(2, owned.reason);

  const bodyFile = path.resolve(parsed.bodyFile);
  const original = readFile(bodyFile);
  if (original === null) return fail(2, `cannot read body file: ${bodyFile}`);

  let worktree = parsed.worktree ? path.resolve(parsed.worktree) : "";
  if (worktree === "") {
    const top = exec([
      "git",
      "-C",
      path.dirname(bodyFile),
      "rev-parse",
      "--show-toplevel",
    ]);
    worktree = top.stdout.trim();
    if (top.exitCode !== 0 || worktree === "") {
      return fail(2, "cannot find the worktree; pass --worktree <dir>");
    }
  }
  const foreign = worktreeNotOwned(worktree, deps);
  if (foreign !== null) return fail(2, foreign);
  try {
    ensureExcludes(worktree);
  } catch (err) {
    return fail(
      2,
      `${worktree} is not a git checkout: ${err instanceof Error ? err.message : err}`,
    );
  }

  // The engine rewrites a working copy, so the input keeps its local paths.
  const working = path.join(worktree, ".flow-tmp", "pr-attach-body.md");
  writeFile(working, original);
  try {
    const repair = exec(["flow-md-validate", "--fix-pr-body", working]);
    if (repair.exitCode !== 0) {
      console.error(
        `flow-pr-attach: flow-md-validate --fix-pr-body failed (${repair.stderr.trim() || repair.exitCode}); pushing the body unrepaired`,
      );
    }
  } catch (err) {
    console.error(
      `flow-pr-attach: flow-md-validate unavailable (${err instanceof Error ? err.message : err}); pushing the body unrepaired`,
    );
  }

  let pushed: ReturnType<typeof pushBodyWithScreenshots>;
  try {
    pushed = pushBodyWithScreenshots(
      { exec, readFile, writeFile, hashFile, writeBytes },
      {
        prStr: String(parsed.pr),
        bodyFile: working,
        worktree,
        retryHint: "re-run flow-pr-attach to retry",
      },
    );
  } catch (err) {
    removeFile(working);
    return fail(
      1,
      `body not pushed: ${err instanceof Error ? err.message : err}`,
    );
  }
  const bodyPushed = pushed.edit.exitCode === 0;
  const localOnly = hasLocalImageRefs(readFile(working) ?? "");
  removeFile(working);

  const { edit, urlByTarget, ...counts } = pushed;
  if (bodyPushed) {
    const hosted = renderHostedBody(original, urlByTarget);
    if (hosted !== original) writeFile(bodyFile, hosted);
  }

  if (parsed.json) {
    console.log(JSON.stringify({ bodyPushed, ...counts }));
  } else if (bodyPushed) {
    console.log(
      `flow-pr-attach: PR #${parsed.pr} body pushed (${counts.uploaded} uploaded, ${counts.reused} reused, ${counts.rehosted} re-hosted, ${counts.batches} batch(es))`,
    );
  }
  for (const skip of counts.skips) {
    console.error(`flow-pr-attach: ${skip.step}: ${skip.reason}`);
  }
  if (!bodyPushed) {
    return fail(1, `gh pr edit failed: ${edit.stderr.trim() || edit.exitCode}`);
  }
  if (localOnly) {
    return fail(
      3,
      "body pushed, but at least one image stayed local-only (a placeholder shows on the PR) — fix the cause named above and re-run",
    );
  }
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
