#!/usr/bin/env bun
/**
 * `flow eval` — runs the eval harness fixtures across `defaults` and `pr7`
 * configs, prints a delta report, and exits non-zero on regression.
 *
 * See `evals/README.md` for the fixture schema and how a run works.
 *
 * Usage:
 *   flow eval                           full suite, both configs
 *   flow eval --fixture <name>          one fixture
 *   flow eval --config <defaults|pr7>   one config (no comparison; always exit 0)
 *   flow eval --keep-tmpdir             leave the scratch repos in evals/.runs/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFlowSource } from "./lib/paths";
import { runFixture } from "./lib/eval-runner";
import { renderReport, decideExitCode } from "./lib/eval-report";
import type { Config } from "./lib/eval-config";

export type EvalArgs = {
  fixture?: string;
  configs: Config[];
  keepTmpdir: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): EvalArgs {
  const out: EvalArgs = { configs: ["defaults", "pr7"], keepTmpdir: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--keep-tmpdir") out.keepTmpdir = true;
    else if (a === "--fixture") {
      const v = argv[++i];
      if (!v) throw new Error("--fixture requires a value");
      out.fixture = v;
    } else if (a === "--config") {
      const v = argv[++i];
      if (v !== "defaults" && v !== "pr7") {
        throw new Error(`--config must be 'defaults' or 'pr7', got '${v}'`);
      }
      out.configs = [v];
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

export function discoverFixtures(evalsDir: string, only?: string): string[] {
  const fixturesDir = path.join(evalsDir, "fixtures");
  if (!fs.existsSync(fixturesDir)) return [];
  const all = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(fixturesDir, n, "prompt.md")))
    .sort();
  if (only) {
    if (!all.includes(only)) {
      throw new Error(`fixture not found: ${only}\navailable: ${all.join(", ") || "(none)"}`);
    }
    return [only];
  }
  return all;
}

const HELP = `flow eval — run the eval harness

Usage:
  flow eval                           full suite, both configs
  flow eval --fixture <name>          run one fixture
  flow eval --config <defaults|pr7>   one config (no comparison)
  flow eval --keep-tmpdir             leave evals/.runs/<ts>/ scratch repos
  flow eval --help                    show this help

Exits non-zero only when 'pr7' regresses by > 1 fixture vs 'defaults'.
`;

export async function main(argv: string[]): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`flow eval: ${(err as Error).message}`);
    console.error(HELP);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const flowSource = resolveFlowSource();
  const evalsDir = path.join(flowSource, "evals");

  let fixtures: string[];
  try {
    fixtures = discoverFixtures(evalsDir, args.fixture);
  } catch (err) {
    console.error(`flow eval: ${(err as Error).message}`);
    return 2;
  }
  if (fixtures.length === 0) {
    console.error(`flow eval: no fixtures found under ${evalsDir}/fixtures/`);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = path.join(evalsDir, ".runs", stamp);
  console.error(`running ${fixtures.length} fixture(s) × ${args.configs.length} config(s) → ${runRoot}`);

  const results = [];
  for (const fixture of fixtures) {
    for (const config of args.configs) {
      console.error(`  ${config}/${fixture} …`);
      const artefactsDir = path.join(runRoot, config, fixture);
      try {
        const r = await runFixture({
          fixtureDir: path.join(evalsDir, "fixtures", fixture),
          config,
          flowSource,
          artefactsDir,
        });
        console.error(`    ${r.pass ? "PASS" : "FAIL"} (impl ${r.implCost.usd.toFixed(4)} judge ${r.soft.judgeCost.usd.toFixed(4)})`);
        results.push(r);
      } catch (err) {
        console.error(`    ERROR: ${(err as Error).message}`);
        return 1;
      }
    }
  }

  console.log("");
  console.log(renderReport({ fixtures, results }));

  if (!args.keepTmpdir) {
    // Per-run repos are large (node_modules, etc. if any). Drop them but keep
    // the artefact files (jsonl logs, diffs, verdicts) for post-mortem.
    for (const r of results) {
      const repo = path.join(r.artefactsDir, "repo");
      if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  return decideExitCode(results);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
