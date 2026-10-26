#!/usr/bin/env bun
/**
 * Mechanics of the UI critique-and-fix loop that `/flow-verify` runs for UI
 * PRs with a look-and-feel sign-off. Every subcommand prints one JSON object
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

import { selectGallery, validateFindings } from "./lib/ui-critique";
import {
  buildCritiquePrompt,
  extractLayoutIntent,
  parseJsonReply,
} from "./lib/ui-critique-prompt";
import {
  critDir,
  opAccept,
  opGate,
  opPersistent,
  opRecord,
  opRender,
  opRoundBegin,
  opRoundEnd,
  readJson,
  readLog,
  writeLog,
  type Flags,
  type OpResult,
  type OpsDeps,
} from "./lib/ui-critique-ops";
import type { SectionShot } from "./lib/ui-driver-schema";

export const CRITIC_MODEL = "opus";
export const CRITIC_EFFORT = "high";
export const CRITIC_MAX_BUDGET_USD = 3;
export const CRITIC_TIMEOUT_SEC = 600;
const CRITIC_MAX_TURNS = 40;

const RULE_REFS = [
  "references/rendered-critique.md",
  "references/visual-design.md",
  "references/layout.md",
  "references/accessibility.md",
] as const;

/** The `flow-claude-headless` stdout envelope, as far as we read it. */
export type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifact?: string;
  total_cost_usd?: number;
};

export type Deps = OpsDeps & {
  spawnHeadless: (argv: string[], opts: { cwd: string }) => HeadlessEnvelope;
  mkdtemp: () => string;
  removeDir: (dir: string) => void;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
};

const USAGE = `usage: flow-ui-critique <subcommand> [flags]
  gate        --body-file <p> --worktree <w> [--driver-result <p>]
  round-begin --worktree <w> --kind smell|critique
  round-end   --worktree <w> --decision keep|revert --reason <text> [--cost <usd>] [--residual-file <p>]
  record      --worktree <w> --outcome clean|list-only|skipped --reason <text> [--residual-file <p>] [--omitted <n>] [--cost <usd>] [--complete]
  persistent  --worktree <w> (--record <driver-result> | --check)
  critique    --driver-result <p> --plan <p> [--smells <p>] --phase round-0|post-round --out <p> [--worktree <w>]
  accept      --compare <p> --targeted <p> [--after <p>] [--after-driver <p>]
  render      --worktree <w> --body-file <p> [--push-copy <p>] [--skip <reason>]`;

const BOOLEAN_FLAGS = new Set(["complete", "check"]);
const SPEC: Record<string, { required: string[]; optional: string[] }> = {
  gate: { required: ["body-file", "worktree"], optional: ["driver-result"] },
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

function critique(f: Flags, deps: Deps): OpResult {
  const w = typeof f.worktree === "string" ? f.worktree : process.cwd();
  const phase = f.phase;
  if (phase !== "round-0" && phase !== "post-round") {
    return { ran: false, skipReason: "bad-phase" };
  }
  // The $3 per-call cap is enforced by the headless child; the call count
  // lives here because this subcommand is pre-approved without classifier
  // review, so a looping caller must not be able to re-spend.
  const prior = readLog(deps, w);
  if (prior.completed) return { ran: false, skipReason: "already-ran" };
  if (prior.critiqueCalls.includes(phase)) {
    return { ran: false, skipReason: "phase-already-critiqued" };
  }
  const driver = readJson(deps, String(f["driver-result"])) as {
    section_shots?: SectionShot[];
    route_snapshots?: { route: string; path: string }[];
  } | null;
  const gallery = selectGallery(driver?.section_shots ?? []);
  if (gallery.shots.length === 0) {
    return { ran: false, skipReason: "no-section-shots" };
  }

  // The headless critic may only be able to Read inside its working
  // directory, so the rule docs are copied under the worktree and the
  // copies' paths are what the prompt lists.
  const rulesDir = path.join(critDir(w), "rules");
  deps.mkdirp(rulesDir);
  const ruleDocPaths: string[] = [];
  for (const ref of RULE_REFS) {
    const src = deps.resolveSkillPath("flow-ui-ux", ref);
    if (src === null || !deps.fileExists(src)) {
      return { ran: false, skipReason: "rule-doc-missing" };
    }
    const dest = path.join(rulesDir, path.basename(ref));
    deps.copyFile(src, dest);
    ruleDocPaths.push(dest);
  }

  const findings =
    typeof f.smells === "string" ? readJson(deps, f.smells) : null;
  const routes = (
    findings as { routes?: { heuristicSmells?: string[] }[] } | null
  )?.routes;
  const prompt = buildCritiquePrompt({
    shots: gallery.shots,
    snapshots: driver?.route_snapshots ?? [],
    layoutIntent: extractLayoutIntent(deps.readFile(String(f.plan)) ?? ""),
    ruleDocPaths,
    smells: (routes ?? []).flatMap((r) => r.heuristicSmells ?? []).slice(0, 40),
    phase,
  });

  writeLog(deps, w, {
    ...prior,
    critiqueCalls: [...prior.critiqueCalls, phase],
    omittedSections: Math.max(prior.omittedSections, gallery.omittedSections),
  });
  const recordSpend = (usd: unknown): void => {
    if (typeof usd !== "number" || !(usd > 0)) return;
    const cur = readLog(deps, w);
    writeLog(deps, w, { ...cur, costUsd: cur.costUsd + usd });
  };
  const scratch = deps.mkdtemp();
  const promptPath = path.join(scratch, "ui-critique-prompt.md");
  const childOut = path.join(
    w,
    ".flow-tmp",
    `headless-ui-critique-${phase}.json`,
  );
  let envelope: HeadlessEnvelope;
  try {
    deps.writeFile(promptPath, prompt);
    deps.mkdirp(path.join(w, ".flow-tmp"));
    envelope = deps.spawnHeadless(
      [
        "--prompt-file",
        promptPath,
        "--model",
        CRITIC_MODEL,
        "--effort",
        CRITIC_EFFORT,
        "--allowed-tools",
        "Read",
        "--max-budget-usd",
        String(CRITIC_MAX_BUDGET_USD),
        "--max-turns",
        String(CRITIC_MAX_TURNS),
        "--timeout-sec",
        String(CRITIC_TIMEOUT_SEC),
        "--task",
        `ui-critique-${phase}`,
        "--out",
        childOut,
      ],
      { cwd: w },
    );
  } finally {
    deps.removeDir(scratch);
  }
  recordSpend(envelope.total_cost_usd);
  if (envelope.ran !== true) {
    return { ran: false, skipReason: envelope.skipReason ?? "headless-error" };
  }

  const artifact = envelope.artifact ? readJson(deps, envelope.artifact) : null;
  const text = (artifact as { result?: unknown } | null)?.result;
  const validated = validateFindings(
    typeof text === "string" ? parseJsonReply(text) : null,
    gallery.shots.map((s) => s.path),
  );
  if (!validated.ok) {
    return {
      ran: false,
      skipReason: "unparseable-result",
      total_cost_usd: envelope.total_cost_usd,
    };
  }
  const out = String(f.out);
  deps.mkdirp(path.dirname(out));
  deps.writeFile(
    out,
    JSON.stringify(
      {
        findings: validated.findings,
        dropped: validated.dropped,
        omittedSections: gallery.omittedSections,
      },
      null,
      2,
    ) + "\n",
  );
  const counts = { defect: 0, major: 0, minor: 0 };
  for (const x of validated.findings) counts[x.severity]++;
  return {
    ran: true,
    findingsPath: out,
    counts,
    dropped: validated.dropped,
    omittedSections: gallery.omittedSections,
    total_cost_usd: envelope.total_cost_usd,
  };
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
