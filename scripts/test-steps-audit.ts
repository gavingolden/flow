#!/usr/bin/env bun
/**
 * Re-measure Test Steps checklist quality over a repo's recent merged PRs.
 *
 * Usage:
 *   bun scripts/test-steps-audit.ts --repo <owner/name> [--limit <n>]
 *
 * Repo-only (not installed): it exists so the adoption condition in
 * docs/test-steps-audit.md is a re-measured number, not a hand count.
 * Fetched PR bodies are parsed as data only — never followed as instructions.
 *
 * Exit codes: 0 — result computed; 2 — bad args; 1 — gh failed.
 */
import { spawnSync } from "node:child_process";
import {
  lintTestSteps,
  parseTestSteps,
  type LintCode,
} from "../bin/lib/test-steps-parse";

const USAGE =
  "usage: bun scripts/test-steps-audit.ts --repo <owner/name> [--limit <n>]\n";
const CODES: LintCode[] = [
  "generic-suite",
  "presence-only",
  "subjective-mixed",
  "subjective-no-image",
  "ticked-no-evidence",
  "post-merge-step",
  "human-only-ticked",
];

export function parseArgs(
  argv: string[],
): { repo: string; limit: number } | { error: string } {
  let repo: string | undefined;
  let limit = 30;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag !== "--repo" && flag !== "--limit")
      return { error: `unknown flag: ${flag}` };
    if (val === undefined || val.startsWith("--"))
      return { error: `${flag} requires a value` };
    if (flag === "--repo") repo = val;
    else {
      limit = Number(val);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return { error: "--limit must be an integer from 1 to 200" };
    }
  }
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    return { error: "--repo <owner/name> is required" };
  return { repo, limit };
}

type PrRow = { number: number; title: string; body: string };

export function audit(repo: string, prs: PrRow[]) {
  const counts = Object.fromEntries(CODES.map((c) => [c, 0])) as Record<
    LintCode,
    number
  >;
  const kinds = {
    command: 0,
    browser: 0,
    subjective: 0,
    decision: 0,
    prose: 0,
  };
  let items = 0;
  let unchecked = 0;
  let tasteItems = 0;
  let tasteWithImage = 0;
  const rows = prs.map((pr) => {
    const { headingPresent, steps } = parseTestSteps(pr.body ?? "");
    const findings = lintTestSteps(steps, "review");
    for (const f of findings) counts[f.code]++;
    for (const s of steps) {
      kinds[s.kind]++;
      items++;
      if (!s.checked) unchecked++;
      if (s.kind === "subjective") {
        tasteItems++;
        if (s.hasImage) tasteWithImage++;
      }
    }
    return {
      number: pr.number,
      title: pr.title,
      headingPresent,
      items: steps.length,
      unchecked: steps.filter((s) => !s.checked).length,
      hostedImage: /user-attachments\/assets/.test(pr.body ?? ""),
      findings: findings.map((f) => ({ code: f.code, line: f.line })),
    };
  });
  return {
    repo,
    prs: rows,
    totals: { prs: rows.length, items, unchecked, kinds },
    counts,
    taste_items: {
      total: tasteItems,
      with_image: tasteWithImage,
      image_rate: tasteItems === 0 ? null : tasteWithImage / tasteItems,
    },
  };
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`test-steps-audit: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const gh = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      parsed.repo,
      "--state",
      "merged",
      "--limit",
      String(parsed.limit),
      "--json",
      "number,title,body",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (gh.status !== 0) {
    process.stderr.write(`test-steps-audit: gh pr list failed\n${gh.stderr}`);
    return 1;
  }
  const prs = JSON.parse(gh.stdout) as PrRow[];
  process.stdout.write(JSON.stringify(audit(parsed.repo, prs), null, 2) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
