#!/usr/bin/env bun
/**
 * Atomically opens a PR (via `gh`) and writes its number into
 * ~/.flow/state/<slug>.json so `flow ls` immediately shows it.
 *
 * Why: previously the supervisor ran `gh pr create` + `gh pr view --jq .number`
 * + `flow-state-update --pr` as three separate calls. A crash between the
 * first and the third left the PR open with `pr: —` in state.json. This
 * helper collapses the sequence into one idempotent step — re-running it
 * against an already-PR'd branch reads the number back via `gh pr view`
 * instead of failing on `gh pr create`'s "already exists" error.
 *
 * Usage:
 *   flow-open-pr [<slug>] --body-file <path>
 *                         [--title <title>] [--draft] [--base <branch>]
 *
 * The slug is optional when invoked from inside a flow tmux pane: it
 * auto-resolves from `$TMUX_PANE`'s `@flow-slug` window option.
 *
 * When the `CLAUDE_CODE_SESSION_ID` env var is set (Claude Code harness),
 * a self-describing HTML-comment marker naming that session is appended
 * to the body of every freshly-created PR, and the ID is written to
 * `~/.flow/state/<slug>.json` as `sessionId`. Absence of the env var is
 * the normal "not in a harness" case — the PR opens with no marker.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runUpdate } from "./flow-state-update";
import { resolveSlugFromPane } from "./lib/tmux";

type Args = {
  /** undefined when omitted — caller falls back to resolveSlugFromPane(). */
  slug?: string;
  bodyFile: string;
  title?: string;
  draft: boolean;
  base?: string;
};

type GhResult = { stdout: string; stderr: string; exitCode: number };

type PrInfo = { number: number; url: string };

export function parseArgs(argv: string[]): Args | { error: string } {
  // Slug is optional: a leading flag means "auto-resolve from pane".
  // Same shape as flow-state-update's parseArgs.
  let rest: string[];
  const out: Args = { bodyFile: "", draft: false };
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    out.slug = argv[0];
    rest = argv.slice(1);
  } else {
    rest = argv;
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    switch (flag) {
      case "--draft":
        out.draft = true;
        continue;
      case "--body-file":
      case "--title":
      case "--base": {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: `${flag} requires a value` };
        }
        if (flag === "--body-file") out.bodyFile = value;
        if (flag === "--title") out.title = value;
        if (flag === "--base") out.base = value;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (!out.bodyFile) return { error: "--body-file is required" };
  return out;
}

/**
 * Minimal sanity check on a session ID before it is injected into a PR
 * body or a state file. Rejects empty/whitespace-only values, any value
 * carrying a newline (which would break the single-line marker), and any
 * value carrying an HTML-comment delimiter (`<!--` / `-->`) — a crafted
 * `-->` would close `sessionMarker`'s comment early and survive the
 * auto-merge gate's non-greedy comment strip as live markdown.
 */
export function isValidSessionId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !value.includes("\n") &&
    !value.includes("-->") &&
    !value.includes("<!--")
  );
}

/**
 * The self-describing PR-body marker. A single-line HTML comment — kept
 * single-line so the auto-merge gate's `<!-- ... -->` strip removes it
 * cleanly and it never counts toward the unchecked-`- [ ]` tally. Names
 * "Claude Code session" in plain text so a future agent recognises the
 * ID without flow-specific documentation.
 */
export function sessionMarker(id: string): string {
  return `<!-- flow: this PR was created by Claude Code session ${id} - transcript at ~/.claude/projects/<encoded-cwd>/${id}.jsonl on the originating machine -->`;
}

function buildCreateArgv(args: Args): string[] {
  const out = ["pr", "create", "--body-file", args.bodyFile];
  if (args.title) out.push("--title", args.title);
  if (args.draft) out.push("--draft");
  if (args.base) out.push("--base", args.base);
  return out;
}

export type GhRunner = (argv: string[]) => GhResult;

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

/**
 * Result of probing for the current branch's PR.
 *   - "found": a PR exists; carries number + url.
 *   - "none":  no PR exists for this branch (gh's no-pr exit; happy path
 *              for a fresh-create).
 *   - "error": gh failed for some other reason; carries stderr.
 *
 * Why a discriminated union: the previous design used `gh pr create` first
 * and parsed its stderr text for "already exists" to detect resume cases.
 * That coupled correctness to gh's English error wording. The probe-first
 * design checks for the PR up front via `gh pr view`, so the resume vs
 * fresh-create branch is decided on a structured signal, not a string match.
 */
type ProbeResult =
  | { kind: "found"; number: number; url: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * Resolves the PR for the current branch (or determines that none exists).
 * Used both as the resume probe (called before `gh pr create`) and the
 * post-create read (called after a fresh create succeeds).
 *
 * `gh pr view` exits non-zero when no PR is associated with the current
 * branch. We distinguish that "expected absence" from a real gh failure by
 * scanning stderr for the canonical "no pull requests found" message —
 * absent that, we treat any non-zero exit as a real error rather than
 * silently returning "none".
 */
export function probePr(gh: GhRunner): ProbeResult {
  const r = gh(["pr", "view", "--json", "number,url"]);
  if (r.exitCode !== 0) {
    if (/no pull requests? found|no pull request associated/i.test(r.stderr)) {
      return { kind: "none" };
    }
    return {
      kind: "error",
      message: r.stderr.trim() || `gh pr view failed (${r.exitCode})`,
    };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { number?: number; url?: string };
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") {
      return {
        kind: "error",
        message: `gh pr view returned unexpected JSON: ${r.stdout}`,
      };
    }
    return { kind: "found", number: parsed.number, url: parsed.url };
  } catch (e) {
    return {
      kind: "error",
      message: `gh pr view returned non-JSON: ${(e as Error).message}`,
    };
  }
}

/**
 * Back-compat shape used by tests: `{ number, url } | { error }`. Adapts
 * `probePr` for callers that only care about the "PR exists" path.
 */
export function readCurrentPr(gh: GhRunner): PrInfo | { error: string } {
  const probe = probePr(gh);
  if (probe.kind === "found") return { number: probe.number, url: probe.url };
  if (probe.kind === "none")
    return { error: "no PR exists for the current branch" };
  return { error: probe.message };
}

export type Deps = {
  gh?: GhRunner;
  /** Test seam: pass a custom updater that mirrors `flow-state-update`'s `runUpdate` signature. */
  updater?: (argv: string[]) => number;
  resolveSlug?: () => string | null;
  /**
   * Test seam: the Claude Code session ID. Defaults to
   * `process.env.CLAUDE_CODE_SESSION_ID` so tests inject without
   * mutating `process.env`. Undefined/invalid ⇒ no marker, no
   * `--session-id` write.
   */
  sessionId?: string;
};

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const updater = deps.updater ?? runUpdate;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());
  const sessionId = deps.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-open-pr: ${parsed.error}`);
    console.error(
      "usage: flow-open-pr [<slug>] --body-file <path> [--title <t>] [--draft] [--base <b>]",
    );
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-open-pr: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass <slug> explicitly, or run inside a tmux window created by `flow new`.",
    );
    return 2;
  }

  // Probe first: if a PR already exists for this branch (resume case), skip
  // `gh pr create` entirely. Avoids parsing gh's "already exists" stderr
  // message — the structured `pr view` signal is what we branch on.
  const validSessionId =
    sessionId !== undefined && isValidSessionId(sessionId)
      ? sessionId
      : undefined;

  const probe = probePr(gh);
  let pr: PrInfo;
  if (probe.kind === "found") {
    pr = { number: probe.number, url: probe.url };
  } else if (probe.kind === "none") {
    // Fresh-create path only: append the self-describing session marker
    // to the body. The marker is NOT re-applied on the resume (`found`)
    // path — flow-open-pr is idempotent and re-editing would duplicate it.
    let createArgs = parsed;
    if (validSessionId !== undefined) {
      const original = fs.readFileSync(parsed.bodyFile, "utf8");
      const augmented = `${original}\n\n${sessionMarker(validSessionId)}\n`;
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-open-pr-body-"),
      );
      const tmpBody = path.join(tmpDir, "body.md");
      fs.writeFileSync(tmpBody, augmented);
      createArgs = { ...parsed, bodyFile: tmpBody };
    }
    const created = gh(buildCreateArgv(createArgs));
    if (created.exitCode !== 0) {
      if (created.stderr) process.stderr.write(created.stderr);
      if (created.stdout) process.stderr.write(created.stdout);
      return created.exitCode === -1 ? 1 : created.exitCode;
    }
    // Re-probe to capture the number + url for the freshly-created PR.
    const after = probePr(gh);
    if (after.kind !== "found") {
      console.error(
        `flow-open-pr: gh pr create succeeded but no PR resolves for the current branch ` +
          `(${after.kind === "error" ? after.message : "no PR found"})`,
      );
      return 1;
    }
    pr = { number: after.number, url: after.url };
  } else {
    console.error(`flow-open-pr: ${probe.message}`);
    return 1;
  }

  const updateArgv = [slug, "--pr", String(pr.number)];
  if (validSessionId !== undefined)
    updateArgv.push("--session-id", validSessionId);
  const updateExit = updater(updateArgv);
  if (updateExit !== 0) return updateExit;

  console.log(pr.url);
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
