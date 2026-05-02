#!/usr/bin/env bun
/**
 * Flip a merged PR's roadmap row + status line from `🚧 in review (#N)`
 * (or any other state containing `(#N)`) to `✅ shipped (#N)`. The commit
 * goes straight to main via `gh api PUT /contents/...` — atomic, race-
 * detected, no local working tree involved. Idempotent: re-running on an
 * already-shipped row is a no-op.
 *
 * Used by `/flow-pipeline` step 10.5 (post-merge sweep). Also runnable by
 * hand to backfill drifted rows.
 *
 * Usage:
 *   flow-roadmap-mark-shipped --pr <N> [--repo <owner/repo>] [--path docs/roadmap.md]
 *                              [--ref main] [--dry-run]
 *
 * Exit codes:
 *   0 — success (changed or no-op)
 *   2 — argument error / no matching row / ambiguous match
 *   3 — PUT conflict (main moved twice between fetch and PUT)
 *   4 — gh API call failed (auth, network, 5xx)
 */

export type GhResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (args: string[], stdin?: string) => GhResult;

export const defaultGh: GhRunner = (args, stdin) => {
  // Bun.spawnSync throws on ENOENT (gh missing from PATH) and on a few other
  // pre-launch failures. Convert to a non-zero GhResult so run()'s
  // RunResult contract is preserved instead of bubbling a stack trace
  // through the supervisor's step 10.5 call.
  try {
    const r = Bun.spawnSync(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    });
    return {
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      exitCode: r.exitCode ?? 1,
    };
  } catch (err) {
    const e = err as { message?: string };
    return {
      stdout: "",
      stderr: e.message ?? `failed to spawn gh: ${String(err)}`,
      exitCode: 1,
    };
  }
};

export type Args = {
  pr: number;
  repo?: string;
  path: string;
  ref: string;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  let pr: number | undefined;
  let repo: string | undefined;
  let pathArg = "docs/roadmap.md";
  let ref = "main";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--pr": {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
          return { error: `--pr must be a positive integer, got '${value}'` };
        }
        pr = n;
        break;
      }
      case "--repo":
        repo = value;
        break;
      case "--path":
        pathArg = value;
        break;
      case "--ref":
        ref = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (pr === undefined) return { error: "--pr is required" };
  return { pr, repo, path: pathArg, ref, dryRun };
}

export type Transform = {
  next: string;
  rowMatches: number;
  statusMatches: number;
  /** First Item N number extracted from a matched table row, for the commit message. */
  itemNumber: number | null;
};

/**
 * Pure transform: find every line containing `(#N)` and force its status
 * cell or `Status:` line to the canonical `✅ shipped (#N)` form. Re-running
 * on an already-shipped roadmap yields the same content (callers detect
 * the no-op via string equality).
 */
export function transformRoadmap(content: string, pr: number): Transform {
  const ref = `(#${pr})`;
  const lines = content.split("\n");
  let rowMatches = 0;
  let statusMatches = 0;
  let itemNumber: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(ref)) continue;
    if (line.startsWith("|")) {
      const cells = line.split("|");
      let cellIdx = -1;
      for (let j = 0; j < cells.length; j++) {
        if (cells[j].includes(ref)) {
          cellIdx = j;
          break;
        }
      }
      if (cellIdx === -1) continue;
      cells[cellIdx] = ` ✅ shipped (#${pr}) `;
      lines[i] = cells.join("|");
      rowMatches++;
      if (itemNumber === null) {
        const m = line.match(/\*\*Item\s+(\d+)\b/);
        if (m) itemNumber = Number.parseInt(m[1], 10);
      }
    } else if (/^Status:/.test(line)) {
      lines[i] = `Status: ✅ shipped (#${pr}).`;
      statusMatches++;
    }
  }
  return { next: lines.join("\n"), rowMatches, statusMatches, itemNumber };
}

export type RunOk = {
  ok: true;
  changed: boolean;
  commitSha?: string;
  itemNumber: number | null;
};
export type RunErr = { ok: false; code: 2 | 3 | 4; message: string };
export type RunResult = RunOk | RunErr;

export async function run(args: Args, gh: GhRunner = defaultGh): Promise<RunResult> {
  const repo = args.repo ?? detectRepo(gh);
  if (!repo) {
    return {
      ok: false,
      code: 4,
      message: "could not auto-detect repo via `gh repo view --json nameWithOwner`",
    };
  }

  const fetched = fetchContent(gh, repo, args.path, args.ref);
  if (!fetched.ok) return fetched;

  const transform = transformRoadmap(fetched.content, args.pr);

  if (transform.rowMatches === 0 && transform.statusMatches === 0) {
    return {
      ok: false,
      code: 2,
      message: `no row found for PR #${args.pr} in ${args.path} on ${args.ref}`,
    };
  }
  if (transform.rowMatches > 1) {
    return {
      ok: false,
      code: 2,
      message: `multiple table rows match PR #${args.pr}; refusing to flip ambiguously`,
    };
  }
  if (transform.statusMatches > 1) {
    return {
      ok: false,
      code: 2,
      message: `multiple Status: lines match PR #${args.pr}; refusing to flip ambiguously`,
    };
  }

  if (transform.next === fetched.content) {
    return { ok: true, changed: false, itemNumber: transform.itemNumber };
  }

  if (args.dryRun) {
    console.log(diffLines(fetched.content, transform.next));
    return { ok: true, changed: false, itemNumber: transform.itemNumber };
  }

  const message = commitMessage(transform.itemNumber, args.pr);
  const put = putContent(gh, repo, args.path, args.ref, transform.next, fetched.sha, message);
  if (put.ok) {
    return { ok: true, changed: true, commitSha: put.commitSha, itemNumber: transform.itemNumber };
  }
  if (!put.conflict) {
    return { ok: false, code: 4, message: put.message };
  }

  // 409: main moved between our GET and PUT. Re-fetch + re-transform once.
  const refetch = fetchContent(gh, repo, args.path, args.ref);
  if (!refetch.ok) {
    return { ok: false, code: 3, message: `409 retry: re-fetch failed (${refetch.message})` };
  }
  const reTransform = transformRoadmap(refetch.content, args.pr);
  if (reTransform.next === refetch.content) {
    return { ok: true, changed: false, itemNumber: reTransform.itemNumber };
  }
  const retry = putContent(
    gh,
    repo,
    args.path,
    args.ref,
    reTransform.next,
    refetch.sha,
    commitMessage(reTransform.itemNumber, args.pr),
  );
  if (retry.ok) {
    return {
      ok: true,
      changed: true,
      commitSha: retry.commitSha,
      itemNumber: reTransform.itemNumber,
    };
  }
  return {
    ok: false,
    code: 3,
    message: `409 conflict on retry; main moved twice between fetch and PUT`,
  };
}

function detectRepo(gh: GhRunner): string | null {
  const r = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out || null;
}

type FetchOk = { ok: true; content: string; sha: string };
type FetchErr = { ok: false; code: 4; message: string };

function fetchContent(gh: GhRunner, repo: string, path: string, ref: string): FetchOk | FetchErr {
  const r = gh([
    "api",
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  ]);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      code: 4,
      message: `gh api GET failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
    };
  }
  let parsed: { content?: string; sha?: string; encoding?: string };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { ok: false, code: 4, message: "could not parse gh api GET response as JSON" };
  }
  if (parsed.encoding !== "base64" || !parsed.sha || parsed.content === undefined) {
    return {
      ok: false,
      code: 4,
      message: `unexpected GET response shape (encoding=${parsed.encoding}, sha=${parsed.sha})`,
    };
  }
  return {
    ok: true,
    content: Buffer.from(parsed.content, "base64").toString("utf8"),
    sha: parsed.sha,
  };
}

type PutOk = { ok: true; commitSha: string };
type PutErr = { ok: false; conflict: boolean; message: string };

function putContent(
  gh: GhRunner,
  repo: string,
  path: string,
  ref: string,
  next: string,
  sha: string,
  message: string,
): PutOk | PutErr {
  const body = JSON.stringify({
    message,
    content: Buffer.from(next, "utf8").toString("base64"),
    sha,
    branch: ref,
  });
  const r = gh(
    ["api", "-X", "PUT", `/repos/${repo}/contents/${path}`, "--input", "-"],
    body,
  );
  if (r.exitCode === 0) {
    let commitSha = "";
    try {
      const parsed = JSON.parse(r.stdout) as { commit?: { sha?: string } };
      commitSha = parsed.commit?.sha ?? "";
    } catch {
      // Tolerate non-JSON success output; we only need it for the log line.
    }
    return { ok: true, commitSha };
  }
  const stderr = r.stderr.trim();
  // gh surfaces 409 as "HTTP 409: ... does not match" in stderr.
  const conflict = /\b409\b/.test(stderr) || /does not match/.test(stderr);
  return { ok: false, conflict, message: stderr || `gh api PUT exit ${r.exitCode}` };
}

export function commitMessage(itemNumber: number | null, pr: number): string {
  const subject = itemNumber !== null ? `Item ${itemNumber}` : "row";
  return `chore(roadmap): mark ${subject} shipped (#${pr})`;
}

export function diffLines(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      if (aLines[i] !== undefined) out.push(`- ${aLines[i]}`);
      if (bLines[i] !== undefined) out.push(`+ ${bLines[i]}`);
    }
  }
  return out.join("\n");
}

function usage(): string {
  return (
    "usage: flow-roadmap-mark-shipped --pr <N> [--repo <owner/repo>]\n" +
    "                                  [--path docs/roadmap.md] [--ref main] [--dry-run]"
  );
}

export async function main(argv: string[], gh: GhRunner = defaultGh): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-roadmap-mark-shipped: ${parsed.error}`);
    console.error(usage());
    return 2;
  }
  const result = await run(parsed, gh);
  if (result.ok) {
    if (result.changed) {
      const tag = result.commitSha ? ` (${result.commitSha.slice(0, 7)})` : "";
      console.log(`flow-roadmap-mark-shipped: marked PR #${parsed.pr} shipped${tag}`);
    } else {
      console.log(
        `flow-roadmap-mark-shipped: PR #${parsed.pr} already shipped (no-op)`,
      );
    }
    return 0;
  }
  console.error(`flow-roadmap-mark-shipped: ${result.message}`);
  return result.code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
