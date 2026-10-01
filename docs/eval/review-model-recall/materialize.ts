#!/usr/bin/env bun
/**
 * `build-prompt.ts materialize <pr> --data-dir <D>` — writes the per-PR
 * inputs the packed/pointer arms read, shaped like a review's `.flow-tmp/`:
 *
 *   <D>/pr-<pr>/.flow-tmp/{pr-review-fetch.md, pr-commits.md, diff.txt,
 *     intent-comments.md, static-analysis.json, review-scope.json}
 *   <D>/ref-<pr>.json        top-level inline review comments (the judge's
 *                            reference set), [{path, line, body}]
 *   <D>/ref-acted-<pr>.json  1-based indices into ref-<pr>.json of the
 *                            comments judged "acted"
 *
 * ACTED PROXY: resolved-thread state is 0/0 on the committed PRs, so a
 * reference comment counts as acted when its `path` is touched by a later
 * fix-applier commit on the same PR — a commit whose subject carries
 * `(pr-review #<pr>)` (FIX_APPLIER_COMMIT_MARKER).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIX_APPLIER_COMMIT_MARKER } from "../../../bin/lib/ci-decision";

type Ref = { path: string; line: number | null; body: string };

const COMMITS_JQ =
  '.commits[] | "\\(.oid[0:7]) \\(.messageHeadline)\\n\\(.messageBody)\\n---"';

function cmd(argv: string[]): string {
  const env = { ...process.env } as Record<string, string>;
  delete env.FLOW_SLUG;
  delete env.TMUX_PANE;
  const r = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${argv.join(" ")}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

function tryCmd(argv: string[], fallback: string): string {
  try {
    return cmd(argv);
  } catch {
    return fallback;
  }
}

/** Mirrors flow-review-scope's per-file cap: a block over 300 lines keeps
 * head 200 + a marker + tail 100, so the brief is sized like a real review's. */
export function truncateDiff(diff: string): string {
  return diff
    .split(/^(?=diff --git )/m)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.length <= 300) return block;
      const cut = lines.length - 300;
      return [
        ...lines.slice(0, 200),
        `... [truncated ${cut} lines] ...`,
        ...lines.slice(-100),
      ].join("\n");
    })
    .join("");
}

export function actedIndices(refs: Ref[], touched: Set<string>): number[] {
  return refs.flatMap((r, i) => (touched.has(r.path) ? [i + 1] : []));
}

export function isFixApplierSubject(subject: string, pr: string): boolean {
  return (
    FIX_APPLIER_COMMIT_MARKER.test(subject) &&
    subject.includes(`(pr-review #${pr})`)
  );
}

function fixApplierFiles(pr: string): Set<string> {
  const commits = JSON.parse(cmd(["gh", "pr", "view", pr, "--json", "commits"]))
    .commits as { oid: string; messageHeadline: string }[];
  const touched = new Set<string>();
  for (const c of commits) {
    if (!isFixApplierSubject(c.messageHeadline, pr)) continue;
    const files = JSON.parse(
      cmd([
        "gh",
        "api",
        `repos/{owner}/{repo}/commits/${c.oid}`,
        "--jq",
        "[.files[].filename]",
      ]),
    ) as string[];
    for (const f of files) touched.add(f);
  }
  return touched;
}

export function materialize(pr: string, dataDir: string): void {
  const flowTmp = join(dataDir, `pr-${pr}`, ".flow-tmp");
  mkdirSync(flowTmp, { recursive: true });
  const put = (name: string, body: string) =>
    writeFileSync(join(flowTmp, name), body);

  put("pr-review-fetch.md", cmd(["flow-fetch-pr-review", pr]));
  put(
    "pr-commits.md",
    cmd(["gh", "pr", "view", pr, "--json", "commits", "-q", COMMITS_JQ]),
  );
  const diff = cmd(["gh", "pr", "diff", pr]);
  put("diff.txt", truncateDiff(diff));
  put(
    "intent-comments.md",
    tryCmd(
      ["flow-fetch-intent-comments", pr],
      "(none — author posted no intent annotations)",
    ),
  );
  const skipped = (reason: string) => ({
    ran: false,
    skipped_reason: reason,
    duration_ms: 0,
  });
  const reason = "not supplied in this measurement harness";
  put(
    "static-analysis.json",
    JSON.stringify({
      types: [],
      security: [],
      dependencies: [],
      lint: [],
      meta: {
        types: skipped(reason),
        security: skipped(reason),
        dependencies: skipped(reason),
        lint: skipped(reason),
      },
    }),
  );
  const files = diff
    .split("\n")
    .filter((l) => l.startsWith("+++ b/"))
    .map((l) => l.slice("+++ b/".length).trim());
  const lenses = [
    "bug-detection",
    "security",
    "pattern-consistency",
    "performance",
    "supply-chain",
    "test-coverage",
    "product",
  ];
  put(
    "review-scope.json",
    JSON.stringify({
      version: 1,
      started_at: new Date().toISOString(),
      scope: "full",
      reason: "measurement harness",
      base_sha: null,
      head_sha: "unknown",
      pr_files: files,
      delta_files: [],
      delta_ratio: null,
      gates: Object.fromEntries(
        lenses.map((l) => [l, { run: true, reason: "harness" }]),
      ),
      gates_enabled: false,
      delta_enabled: false,
      forced_full: false,
      product_brief: { found: false },
      tier: "standard",
      tier_reasons: [],
    }),
  );

  const raw = cmd([
    "gh",
    "api",
    "--paginate",
    `repos/{owner}/{repo}/pulls/${pr}/comments`,
    "--jq",
    ".[] | select(.in_reply_to_id == null) | {path, line, body}",
  ]);
  const refs: Ref[] = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  writeFileSync(join(dataDir, `ref-${pr}.json`), JSON.stringify(refs, null, 1));
  const acted = actedIndices(refs, fixApplierFiles(pr));
  writeFileSync(join(dataDir, `ref-acted-${pr}.json`), JSON.stringify(acted));
  console.log(
    `materialized PR #${pr}: ${refs.length} reference comments, ${acted.length} acted (proxy)`,
  );
}
