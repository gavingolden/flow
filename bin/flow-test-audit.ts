#!/usr/bin/env bun
/**
 * Re-runnable test-value scorer. Discovers every test file under vitest's
 * `include` globs, scores each file against the v1 axes (see
 * `docs/test-quality-methodology.md`), and emits JSON, a markdown table,
 * or a regenerated `.flow/test-tiers.json` manifest.
 *
 * `scoreFiles`/`toTiers` are the PURE scoring core, defined in
 * `./lib/test-audit-core` and re-exported here so `import { scoreFiles,
 * toTiers } from "./flow-test-audit"` keeps working while this file stays
 * under the 200-line budget.
 *
 * Usage:
 *   flow-test-audit                       # runs vitest, prints a markdown table
 *   flow-test-audit --json                # {files, median} envelope on stdout
 *   flow-test-audit --write-tiers          # writes .flow/test-tiers.json
 *   flow-test-audit --from-json <path>     # re-score a saved vitest report
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import picomatch from "picomatch";
import {
  scoreFiles,
  toTiers,
  median,
  type FileScore,
} from "./lib/test-audit-core";

export { scoreFiles, toTiers, type FileScore };

function toRepoRelative(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
}

type RawTestResult = {
  name: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: Array<{ duration?: number }>;
};

function timingsFromReport(
  report: { testResults?: RawTestResult[] },
  cwd: string,
): Map<string, { wallMs: number; assertions: number }> {
  const timings = new Map<string, { wallMs: number; assertions: number }>();
  for (const t of report.testResults ?? []) {
    const relPath = toRepoRelative(t.name, cwd);
    const wallMs =
      t.startTime !== undefined && t.endTime !== undefined
        ? t.endTime - t.startTime
        : 0;
    const assertions = t.assertionResults?.length ?? 0;
    timings.set(relPath, { wallMs, assertions });
  }
  return timings;
}

async function loadIncludeGlobs(cwd: string): Promise<string[]> {
  try {
    const config = await import(path.resolve(cwd, "vitest.config.ts"));
    const include = config.default?.test?.include;
    if (Array.isArray(include) && include.every((s) => typeof s === "string")) {
      return include as string[];
    }
  } catch {
    // Fall through — a missing/malformed config degrades to the known default.
  }
  return ["bin/**/*.test.ts", "skills/**/*.test.ts"];
}

function filterToIncludeGlobs(paths: string[], globs: string[]): string[] {
  // picomatch, not Bun.Glob: this module is imported directly by
  // bin/flow-test-audit.test.ts, which vitest runs under Node, not Bun —
  // a Bun-only global here would throw "Bun is not defined" under `npm
  // run test`. picomatch is the codebase's existing Node-compatible glob
  // matcher (see bin/lib/copilot-classify.ts).
  const isMatch = picomatch(globs);
  return paths.filter((p) => isMatch(p));
}

function readSources(paths: string[], cwd: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    if (existsSync(abs)) sources.set(p, readFileSync(abs, "utf8"));
  }
  return sources;
}

function runVitestJson(cwd: string): { testResults?: RawTestResult[] } {
  const outFile = path.join(cwd, ".flow-tmp", "vitest-audit-report.json");
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--reporter=json", "--outputFile", outFile],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0 && !existsSync(outFile)) {
    throw new Error(`vitest run failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(readFileSync(outFile, "utf8"));
}

function toMarkdown(scores: FileScore[], medianVal: number): string {
  const rows = [...scores].sort((a, b) => b.wallMs - a.wallMs);
  const header =
    "| file | ms/assert | assertions | quadrant | tier |\n" +
    "|---|---|---|---|---|";
  const body = rows
    .map(
      (s) =>
        `| ${s.path} | ${s.msPerAssertion.toFixed(1)} | ${s.assertions} | ${s.quadrant} | ${s.tier} |`,
    )
    .join("\n");
  return `Repo median: ${medianVal.toFixed(2)} ms/assert\n\n${header}\n${body}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const fromJsonIdx = argv.indexOf("--from-json");
  const report =
    fromJsonIdx !== -1
      ? JSON.parse(
          readFileSync(path.resolve(cwd, argv[fromJsonIdx + 1]), "utf8"),
        )
      : runVitestJson(cwd);

  const timings = timingsFromReport(report, cwd);
  const globs = await loadIncludeGlobs(cwd);
  const inScope = filterToIncludeGlobs([...timings.keys()], globs);
  const scopedTimings = new Map(
    inScope.map((p) => [p, timings.get(p)!] as const),
  );
  const sources = readSources(inScope, cwd);
  const scores = scoreFiles({ timings: scopedTimings, sources });
  const medianVal = median(scores.map((s) => s.msPerAssertion));

  if (argv.includes("--write-tiers")) {
    const tiers = toTiers(scores);
    writeFileSync(
      path.join(cwd, ".flow", "test-tiers.json"),
      JSON.stringify(tiers, null, 2) + "\n",
    );
    console.log(
      `flow-test-audit: wrote .flow/test-tiers.json (${scores.length} files scored)`,
    );
    return 0;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ files: scores, median: medianVal }, null, 2));
    return 0;
  }
  console.log(toMarkdown(scores, medianVal));
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
