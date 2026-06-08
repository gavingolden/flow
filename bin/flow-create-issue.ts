#!/usr/bin/env bun
/**
 * Creates a GitHub issue against the current repo, idempotent on title.
 *
 * Why: pr-review's deferral path and flow-pipeline's post-merge sweep
 * both need a deterministic way to file a follow-up issue. Building the
 * `gh issue create` invocation by hand at the call site loses idempotency
 * (a re-run of pr-review on the same PR would file the same issue twice)
 * and JSON discipline. This helper makes the shape deterministic.
 *
 * Current-repo only: there is no `--repo` flag in v1. Cross-repo issue
 * creation was rejected at planning time — auto-filing on someone else's
 * tracker without consent is a bad default. Third-party regressions get
 * filed locally with a `third-party` label and a body that names the
 * upstream project; the user can mirror manually after the fact.
 *
 * Idempotency: pre-flights `gh issue list --state open --search 'in:title
 * "<title>"'` (substring match in GitHub's search) and post-filters
 * client-side for an exact title match. On hit, the existing URL is
 * returned with `action: "existing"` and `gh issue create` is not called.
 *
 * Usage:
 *   flow-create-issue --title <title> --body-file <path>
 *                     [--label l1,l2,l3] [--dry-run]
 */

import { spawnSync } from "node:child_process";

type Args = {
  title: string;
  bodyFile: string;
  labels: string[];
  dryRun: boolean;
};

type GhResult = { stdout: string; stderr: string; exitCode: number };

export type GhRunner = (argv: string[]) => GhResult;

type Action = "created" | "existing" | "would-create";

type Output = {
  action: Action;
  url: string;
  number: number;
  title: string;
};

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { title: "", bodyFile: "", labels: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--dry-run":
        out.dryRun = true;
        continue;
      case "--title":
      case "--body-file":
      case "--label": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: `${flag} requires a value` };
        }
        if (flag === "--title") out.title = value;
        if (flag === "--body-file") out.bodyFile = value;
        if (flag === "--label") {
          out.labels = value
            .split(",")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        }
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (!out.title) return { error: "--title is required" };
  if (!out.bodyFile) return { error: "--body-file is required" };
  return out;
}

type ProbeResult =
  | { kind: "found"; number: number; url: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * Pre-flight idempotency probe: search OPEN issues for a title match.
 *
 * GitHub's `in:title` is a substring match across the title field, so
 * "foo" would also match "foo bar" and "the foo". The post-filter on
 * the parsed JSON is what makes this an exact-title check — without
 * it, two candidate issues with overlapping titles would spuriously
 * dedupe.
 */
export function probeExistingIssue(title: string, gh: GhRunner): ProbeResult {
  const r = gh([
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `in:title "${title}"`,
    "--json",
    "number,title,url",
    "--limit",
    "100",
  ]);
  if (r.exitCode !== 0) {
    return {
      kind: "error",
      message: r.stderr.trim() || `gh issue list failed (${r.exitCode})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      kind: "error",
      message: `gh issue list returned non-JSON: ${(e as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      kind: "error",
      message: `gh issue list returned non-array: ${r.stdout}`,
    };
  }
  for (const entry of parsed) {
    const obj = entry as { number?: number; title?: string; url?: string };
    if (
      typeof obj.number === "number" &&
      typeof obj.title === "string" &&
      typeof obj.url === "string" &&
      obj.title === title
    ) {
      return { kind: "found", number: obj.number, url: obj.url };
    }
  }
  return { kind: "none" };
}

/**
 * Post-create read: the freshly-created issue's URL is the last line of
 * `gh issue create`'s stdout. The number is in the URL path. Parse both
 * out so the caller never has to follow up with `gh issue view`.
 */
function parseCreateOutput(
  stdout: string,
): { number: number; url: string } | { error: string } {
  const url = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!/^https:\/\/github\.com\//.test(url)) {
    return {
      error: `gh issue create stdout did not end with a github.com URL: ${stdout}`,
    };
  }
  const match = url.match(/\/issues\/(\d+)$/);
  if (!match) {
    return { error: `gh issue create URL has no /issues/<n> suffix: ${url}` };
  }
  return { number: Number(match[1]), url };
}

type LabelResult = { kind: "ok" } | { kind: "error"; message: string };

/**
 * Ensure every label exists on the current repo before `gh issue create`.
 *
 * `gh issue create --label <name>` rejects labels the repo doesn't have, so
 * a fresh repo (one that never had the flow-agent/deferred-review/
 * out-of-scope-discovery labels created) fails on the first call. `gh label
 * create <name> --force` provisions a missing label and updates an existing
 * one, so the call is idempotent and needs no `gh label list` pre-check. A
 * non-zero exit (e.g. no `repo` write scope) aborts before `gh issue create`
 * rather than letting the create call fail later on the unknown label.
 */
export function ensureLabels(labels: string[], gh: GhRunner): LabelResult {
  for (const label of labels) {
    const r = gh(["label", "create", label, "--force"]);
    if (r.exitCode !== 0) {
      return {
        kind: "error",
        message:
          r.stderr.trim() || `gh label create ${label} failed (${r.exitCode})`,
      };
    }
  }
  return { kind: "ok" };
}

function buildCreateArgv(args: Args): string[] {
  const out = [
    "issue",
    "create",
    "--title",
    args.title,
    "--body-file",
    args.bodyFile,
  ];
  for (const label of args.labels) out.push("--label", label);
  return out;
}

export type Deps = {
  gh?: GhRunner;
};

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-create-issue: ${parsed.error}`);
    console.error(
      "usage: flow-create-issue --title <t> --body-file <p> [--label l1,l2] [--dry-run]",
    );
    return 2;
  }

  if (parsed.dryRun) {
    const out: Output = {
      action: "would-create",
      url: "",
      number: 0,
      title: parsed.title,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }

  const probe = probeExistingIssue(parsed.title, gh);
  if (probe.kind === "error") {
    console.error(`flow-create-issue: ${probe.message}`);
    return 1;
  }
  if (probe.kind === "found") {
    const out: Output = {
      action: "existing",
      url: probe.url,
      number: probe.number,
      title: parsed.title,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }

  if (parsed.labels.length > 0) {
    const labelResult = ensureLabels(parsed.labels, gh);
    if (labelResult.kind === "error") {
      console.error(`flow-create-issue: ${labelResult.message}`);
      return 1;
    }
  }

  const created = gh(buildCreateArgv(parsed));
  if (created.exitCode !== 0) {
    if (created.stderr) process.stderr.write(created.stderr);
    if (created.stdout) process.stderr.write(created.stdout);
    return created.exitCode === -1 ? 1 : created.exitCode;
  }
  const result = parseCreateOutput(created.stdout);
  if ("error" in result) {
    console.error(`flow-create-issue: ${result.error}`);
    return 1;
  }
  const out: Output = {
    action: "created",
    url: result.url,
    number: result.number,
    title: parsed.title,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
