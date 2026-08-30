#!/usr/bin/env bun
/**
 * Resolves everything `/flow-pipeline` Step 6 needs to spawn the
 * Independent Verify-Retry-Loop Subagent, and advances `state.phase` to
 * `verifying` as a side effect of returning them.
 *
 * Replaces the former bash spawn-prep block
 * (`skills/pipeline/flow-pipeline/SKILL.md:1448-1483`), which PR #676's
 * baseline re-record measured the supervisor partially executing — running
 * its `rm -f` third statement while skipping the `--phase verifying` write
 * (its first) and the `VERIFY_MODEL`/`VERIFY_SUBAGENT` resolution outright,
 * 4 of 10 recorded runs. Folding all of it into one helper call means the
 * supervisor cannot obtain the values it needs to spawn the subagent
 * without also writing the phase.
 *
 * Also fixes a live "Don't make tmux pane/window state a load-bearing
 * input" violation: the block's `SLUG=$(tmux show-options -t "$TMUX_PANE"
 * -v -w @flow-slug)` returns empty under the default plain-shell launcher,
 * silently collapsing the whole `VERIFY_MODEL` precedence to `"sonnet"`.
 * This helper resolves the slug via `resolveSlugAmbient` (env-first, then
 * pane) instead.
 *
 * Usage:
 *   flow-verify-prep [--worktree <path>] [--skill-dir <path>] [--pr <n>]
 *
 * `--worktree` falls back to `state.worktree` when omitted. `--skill-dir`
 * degrades to the global plugin root
 * (`~/.flow/claude-home/.claude/skills/flow-module-core/skills/flow-pipeline`)
 * when omitted — a PATH-installed helper has no ambient `$SKILL_DIR`.
 * `--pr` is optional; `0` or an empty value means "no PR yet" (Step 6
 * runs before a PR exists) and skips the `state.pr` guard, same as
 * omitting the flag entirely.
 *
 * Output: a single JSON object on stdout.
 *   {
 *     "artifactPath": "<worktree>/.flow-tmp/verify-loop-result.json",
 *     "instructionsPath": "<skillDir>/references/verify-loop-instructions.md",
 *     "verifyModel": "sonnet" | <configured alias>,
 *     "verifySubagent": "flow-module-core:flow-verify" | "general-purpose"
 *   }
 *
 * Exit codes:
 *   0 — resolved (any outcome, including a general-purpose fallback)
 *   2 — bad CLI args, or no --worktree given and state.worktree is unset
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readState } from "./lib/state";
import { FLOW_STATE_DIR, FLOW_CLAUDE_HOME_SKILLS_DIR } from "./lib/paths";
import { resolveSlugAmbient } from "./lib/session-identity";
import { advancePhase } from "./lib/phase-advance";
import {
  readPhaseModel,
  defaultReadConfigFile,
  type ReadConfigFile,
} from "./lib/models-config";

const DEFAULT_SKILL_DIR = path.join(
  FLOW_CLAUDE_HOME_SKILLS_DIR,
  "flow-module-core",
  "skills",
  "flow-pipeline",
);

const DEFAULT_AGENT_DEFINITION = path.join(
  FLOW_CLAUDE_HOME_SKILLS_DIR,
  "flow-module-core",
  "agents",
  "flow-verify.md",
);

export type VerifyPrepResult = {
  artifactPath: string;
  instructionsPath: string;
  verifyModel: string;
  verifySubagent: string;
};

type ParsedArgs =
  | { worktree?: string; skillDir?: string; pr?: number }
  | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let worktree: string | undefined;
  let skillDir: string | undefined;
  let pr: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--worktree") {
      const v = argv[++i];
      if (v === undefined) return { error: "--worktree requires a value" };
      worktree = v;
    } else if (flag === "--skill-dir") {
      const v = argv[++i];
      if (v === undefined) return { error: "--skill-dir requires a value" };
      skillDir = v;
    } else if (flag === "--pr") {
      const v = argv[++i];
      if (v === undefined) return { error: "--pr requires a value" };
      // "0" and "" mean "no PR yet" (Step 6 runs before a PR is opened) —
      // leave `pr` undefined so `expectPr: parsed.pr ?? null` downstream
      // disables the guard, same as omitting --pr entirely. Still reject
      // genuinely malformed values (non-numeric, negative, non-integer).
      if (v === "" || v === "0") {
        // pr stays undefined
      } else {
        const parsed = Number(v);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { error: `--pr must be a positive integer, got '${v}'` };
        }
        pr = parsed;
      }
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  return { worktree, skillDir, pr };
}

function defaultExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export type Deps = {
  resolveSlug?: () => string | null;
  stateDir?: string;
  readConfigFile?: ReadConfigFile;
  exists?: (p: string) => boolean;
  rm?: (p: string) => void;
  mkdir?: (p: string) => void;
};

export function run(argv: string[], deps: Deps = {}): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-verify-prep: ${parsed.error}`);
    console.error(
      "usage: flow-verify-prep [--worktree <path>] [--skill-dir <path>] [--pr <n>]",
    );
    return 2;
  }

  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const exists = deps.exists ?? defaultExists;
  const rm =
    deps.rm ??
    ((p: string) => {
      try {
        fs.unlinkSync(p);
      } catch {
        // Absent is the common case (no prior verify cycle) — not an error.
      }
    });
  const mkdir =
    deps.mkdir ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));
  const readConfigFile = deps.readConfigFile ?? defaultReadConfigFile;

  const slug = resolveSlug();
  const state = slug ? readState(slug, stateDir) : null;

  const worktree = parsed.worktree || state?.worktree;
  if (!worktree) {
    console.error(
      "flow-verify-prep: no --worktree given and state.worktree is not set; pass --worktree <path>.",
    );
    return 2;
  }
  // `||`, not `??` — an explicit `--skill-dir ""` (e.g. an unset
  // $SKILL_DIR expanding to empty in the caller's shell) must fall back
  // to the global plugin root too, not collapse to a broken empty path.
  const skillDir = parsed.skillDir || DEFAULT_SKILL_DIR;

  const artifactPath = path.join(
    worktree,
    ".flow-tmp",
    "verify-loop-result.json",
  );
  const instructionsPath = path.join(
    skillDir,
    "references",
    "verify-loop-instructions.md",
  );

  mkdir(path.join(worktree, ".flow-tmp"));
  rm(artifactPath); // clear any stale artifact from a prior verify cycle

  // VERIFY_MODEL precedence (verify is the ONE asymmetry): state.modelVerify
  // > config.models.verify > "sonnet" — verify does NOT inherit the session
  // model. See references/model-routing.md.
  const verifyModel =
    state?.modelVerify ?? readPhaseModel("verify", readConfigFile) ?? "sonnet";

  // Two-tier VERIFY_SUBAGENT probe. Plugin-hosted agents are addressable
  // ONLY by the plugin-qualified name — a bare "flow-verify" subagent_type
  // fails Task-tool resolution outright. Resolve in two tiers: (1) plugin-
  // root definition present -> plugin-qualified name; (2) absent -> fall
  // back to general-purpose, loudly, so the pipeline never fails on an
  // unknown agent type.
  let verifySubagent = "general-purpose";
  if (exists(DEFAULT_AGENT_DEFINITION)) {
    verifySubagent = "flow-module-core:flow-verify";
  } else {
    console.error(
      "NOTICE — agent-fallback: flow-verify → general-purpose (definition not installed; tool-allowlist containment lost — run `flow install`).",
    );
  }

  // Side effect: advances state.phase to "verifying". The supervisor
  // cannot obtain the JSON below without this call running first.
  // Second `expectPr`-guarded call site alongside flow-fetch-pr-review /
  // flow-gate-decide / flow-merge-guard / flow-ci-check — `state.pr` IS
  // populated by the time Step 6 runs, so an unguarded write here can
  // silently advance the wrong pipeline's phase when `--pr` is passed.
  advancePhase("verifying", {
    slug,
    expectPr: parsed.pr ?? null,
    dir: stateDir,
  });

  const result: VerifyPrepResult = {
    artifactPath,
    instructionsPath,
    verifyModel,
    verifySubagent,
  };
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
