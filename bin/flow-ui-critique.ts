#!/usr/bin/env bun
/**
 * Mechanics of the UI critique-and-fix loop that `/flow-verify` runs for every
 * PR whose diff changes a rendered file. Every subcommand prints one JSON object
 * on stdout. Bad arguments exit 2; any runtime failure exits 0 with
 * `{"ran":false,"skipReason":…}` so the loop degrades to a named skip instead
 * of failing verify.
 *
 *   gate          eligibility + mode (pre-drive, or post-drive with --driver-result)
 *   round-begin   snapshot the pre-round artifacts and record the round open
 *   round-end     close the round (restoring the artifacts on a revert)
 *   record        non-round outcomes: clean | list-only | skipped
 *   persistent    page-check defects that survive every verify attempt
 *   critique      the one model call: a capped, read-only critic over the gallery
 *   accept        keep/revert from the page-check comparison + the two critiques
 *   render        write the `## UI review` section and the DECISION item
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { opGate } from "./lib/ui-critique-gate-op";
import {
  opAccept,
  opPersistent,
  opRecord,
  opRender,
  opRoundBegin,
  opRoundEnd,
  type Flags,
  type OpResult,
} from "./lib/ui-critique-ops";
import {
  critique,
  type Deps,
  type HeadlessEnvelope,
} from "./lib/ui-critique-run";
import { resolvePlaywright } from "./lib/playwright-resolve";
import { branchChangedFiles } from "./lib/ui-review-diff";

const USAGE = `usage: flow-ui-critique <subcommand> [flags]
  gate        --body-file <p> --worktree <w> [--driver-result <p>] [--changed-files <p>] [--plan <p>] [--manifest <p>]
  round-begin --worktree <w> --kind smell|critique
  round-end   --worktree <w> --decision keep|revert --reason <text> [--cost <usd>] [--residual-file <p>]
  record      --worktree <w> --outcome clean|list-only|skipped --reason <text> [--residual-file <p>] [--omitted <n>] [--cost <usd>] [--complete]
  persistent  --worktree <w> (--record <driver-result> | --check)
  critique    --driver-result <p> --plan <p> [--smells <p>] --phase round-0|post-round|review-8c --out <p> [--worktree <w>]
  accept      --compare <p> --targeted <p> [--after <p>] [--after-driver <p>]
  render      --worktree <w> --body-file <p> [--push-copy <p>] [--skip <reason>]`;

const BOOLEAN_FLAGS = new Set(["complete", "check"]);
const SPEC: Record<string, { required: string[]; optional: string[] }> = {
  gate: {
    required: ["body-file", "worktree"],
    optional: ["driver-result", "changed-files", "plan", "manifest"],
  },
  "round-begin": { required: ["worktree", "kind"], optional: [] },
  "round-end": {
    required: ["worktree", "decision", "reason"],
    optional: ["cost", "residual-file"],
  },
  record: {
    required: ["worktree", "outcome", "reason"],
    optional: ["residual-file", "omitted", "cost", "complete"],
  },
  persistent: { required: ["worktree"], optional: ["record", "check"] },
  critique: {
    required: ["driver-result", "plan", "phase", "out"],
    optional: ["smells", "worktree"],
  },
  accept: {
    required: ["compare", "targeted"],
    optional: ["after", "after-driver"],
  },
  render: {
    required: ["worktree", "body-file"],
    optional: ["push-copy", "skip"],
  },
};

export function parseArgs(
  argv: string[],
): { sub: string; flags: Flags } | { error: string } {
  const [sub, ...rest] = argv;
  const spec = sub === undefined ? undefined : SPEC[sub];
  if (!sub || !spec) return { error: `unknown subcommand: ${sub ?? "(none)"}` };
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(/^--(.+)$/);
    if (!m || !allowed.has(m[1])) return { error: `unknown flag: ${rest[i]}` };
    if (BOOLEAN_FLAGS.has(m[1])) {
      flags[m[1]] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) {
      return { error: `--${m[1]} requires a value` };
    }
    flags[m[1]] = value;
  }
  const missing = spec.required.find((k) => flags[k] === undefined);
  if (missing) return { error: `--${missing} is required` };
  if (sub === "persistent" && !flags.record === !flags.check) {
    return { error: "persistent needs exactly one of --record or --check" };
  }
  return { sub, flags };
}

const OPS: Record<string, (f: Flags, d: Deps) => OpResult> = {
  gate: opGate,
  "round-begin": opRoundBegin,
  "round-end": opRoundEnd,
  record: opRecord,
  persistent: opPersistent,
  render: opRender,
  accept: opAccept,
  critique,
};

export function run(argv: string[], deps: Deps): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.writeOut(USAGE);
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    deps.writeErr(`flow-ui-critique: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  let result: OpResult;
  try {
    result = OPS[parsed.sub](parsed.flags, deps);
  } catch (e) {
    result = {
      ran: false,
      skipReason: "runtime-error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  deps.writeOut(JSON.stringify(result));
  return 0;
}

function sh(argv: string[], cwd?: string): string | null {
  const r = Bun.spawnSync(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : null;
}

export function defaultDeps(): Deps {
  const fileExists = (p: string) => existsSync(p);
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, c) => writeFileSync(p, c),
    copyFile: (a, b) => copyFileSync(a, b),
    fileExists,
    mkdirp: (d) => void mkdirSync(d, { recursive: true }),
    gitHead: (w) => sh(["git", "rev-parse", "HEAD"], w),
    resolveSkillPath: (skill, ref) =>
      sh(["flow-module-status", "--skill-path", skill, "--ref", ref]),
    home: process.env.HOME ?? "",
    now: () => new Date().toISOString(),
    repo: (w) => {
      const common = sh(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        w,
      );
      return common ? path.basename(path.dirname(common)) : "unknown";
    },
    slug: (w) => process.env.FLOW_SLUG ?? path.basename(w),
    changedFiles: (w) => branchChangedFiles(w),
    resolvePlaywright: (w) => resolvePlaywright(w),
    spawnHeadless: (argv, opts) => {
      const r = Bun.spawnSync(["flow-claude-headless", ...argv], {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const line =
        new TextDecoder()
          .decode(r.stdout)
          .trim()
          .split("\n")
          .filter(Boolean)
          .pop() ?? "{}";
      try {
        return JSON.parse(line) as HeadlessEnvelope;
      } catch {
        return { ran: false, skipReason: "headless-error" };
      }
    },
    mkdtemp: () => mkdtempSync(path.join(tmpdir(), "flow-ui-critique-")),
    removeDir: (d) => void rmSync(d, { recursive: true, force: true }),
    writeOut: (line) => console.log(line),
    writeErr: (line) => process.stderr.write(line),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2), defaultDeps()));
}
