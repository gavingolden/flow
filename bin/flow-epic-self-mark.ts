#!/usr/bin/env bun
/**
 * `flow-epic-self-mark [--slug <slug>] [--commit] [--push] [--resolve-conflict] [--json]`
 * `flow-epic-self-mark --epic-slug <e> --feature <id> --pr <n> [--commit] [--push] [--json]`
 * `flow-epic-self-mark --seed --epic-slug <e> [--json]`
 *
 * Writes the pipeline's OWN row on the committed epic status board from its
 * feature branch, so the row rides in the pull request and lands with it. The
 * ambient form binds the slug (`--slug` or `$FLOW_SLUG`) to an epic feature
 * and runs against the state's recorded worktree, so a supervisor can call it
 * as a standalone command from any directory. Exit 0 on written / unchanged /
 * not-bound, 1 on a refusal, 2 on usage.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { readState } from "./lib/state";
import { flowStateDir } from "./lib/paths";
import { currentBranch } from "./lib/epic-metadata-commit";
import {
  seedEpicBoard,
  selfMarkEpicRow,
  type SelfMarkRefusal,
  type SelfMarkResult,
} from "./lib/epic-self-mark";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { isValidSlug } from "./lib/slug";
import { resolveEpicBinding } from "./lib/epic-binding";
import {
  defaultGh,
  defaultGit,
  type GhRunner,
  type GitRunner,
} from "./lib/resume-probes";

const USAGE =
  "usage: flow-epic-self-mark [--slug <slug>] [--commit] [--push] [--resolve-conflict] [--json]\n" +
  "       flow-epic-self-mark --epic-slug <epic> --feature <id> --pr <n> [--commit] [--push] [--json]\n" +
  "       flow-epic-self-mark --seed --epic-slug <epic> [--json]\n" +
  "  --commit            commit the board row (path-scoped)\n" +
  "  --push              also `git push origin HEAD` (implies --commit; never forces)\n" +
  "  --resolve-conflict  mid-merge: take the incoming board, apply the own row, stage it (no commit)\n" +
  "  --seed              write an all-not-started board (no own row, no commit)";

const REMEDY: Record<SelfMarkRefusal, string> = {
  "binding-conflict":
    "fix the pipeline's epic tag or `flow epic bind` so exactly one feature matches",
  "on-base-branch":
    "run from the pipeline's feature branch, not the base branch",
  "detached-head": "check out the pipeline's branch",
  "no-pr": "open the PR first or pass --pr",
  "no-binding":
    "pass --slug <the pipeline's slug> (or run with FLOW_SLUG set) so the conflict resolves against its own row",
  "extra-local-commits":
    "push the branch normally (`git push`) so the gate sees the extra commits, then rerun",
  "pr-not-merged": "the PR must be MERGED or this branch's own open PR",
  "unknown-feature": "the feature id is not in the epic manifest",
  "manifest-unreadable":
    "check the epic manifest exists and validates on this branch",
  "board-unreadable":
    "repair .flow/epics/<epic>/status.json (valid JSON, version 1)",
  "epic-id-mismatch": "the board's epicId differs from the manifest's",
  "not-conflicted":
    "--resolve-conflict only applies while the board is unmerged",
  "commit-failed": "resolve the git error and rerun with --commit",
  "push-failed":
    "rerun `flow-epic-self-mark --commit --push` once the push can succeed",
};

type Deps = {
  gh?: GhRunner;
  git?: GitRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  epicsDir?: string;
};

type Args = {
  slug?: string;
  epicSlug?: string;
  feature?: string;
  pr?: number;
  commit: boolean;
  push: boolean;
  resolveConflict: boolean;
  seed: boolean;
  json: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args | string {
  const out: Args = {
    commit: false,
    push: false,
    resolveConflict: false,
    seed: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--push") out.commit = out.push = true;
    else if (a === "--resolve-conflict") out.resolveConflict = true;
    else if (a === "--seed") out.seed = true;
    else if (a === "--json") out.json = true;
    else if (a === "--slug" || a === "--epic-slug" || a === "--feature") {
      const v = value();
      if (v === undefined) return `${a} requires a value`;
      if (a !== "--feature" && !isValidSlug(v)) return `invalid ${a} '${v}'`;
      if (a === "--slug") out.slug = v;
      else if (a === "--epic-slug") out.epicSlug = v;
      else out.feature = v;
    } else if (a === "--pr") {
      const v = value();
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n <= 0) {
        return "--pr requires a positive integer";
      }
      out.pr = n;
    } else return `unrecognized argument '${a}'`;
  }
  return out;
}

function validateShape(a: Args): string | null {
  if (a.seed) {
    if (!a.epicSlug) return "--seed requires --epic-slug";
    if (a.feature || a.pr || a.slug || a.commit || a.resolveConflict) {
      return "--seed takes only --epic-slug and --json";
    }
    return null;
  }
  const explicit = a.epicSlug !== undefined;
  if (explicit && (!a.feature || a.pr === undefined)) {
    return "--epic-slug requires --feature and --pr";
  }
  if (!explicit && a.feature) return "--feature requires --epic-slug";
  if (explicit && a.slug) return "--slug cannot be combined with --epic-slug";
  return null;
}

function report(r: SelfMarkResult, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  if (r.outcome === "refused") {
    const remedy = r.reason ? REMEDY[r.reason] : "";
    process.stderr.write(
      `flow-epic-self-mark: refused (${r.reason}): ${r.detail ?? ""}${remedy ? `\n  remedy: ${remedy}` : ""}\n`,
    );
    return 1;
  }
  if (!json && r.outcome !== "not-bound") {
    const flags = `${r.committed ? " committed" : ""}${r.pushed ? " pushed" : ""}`;
    process.stdout.write(
      `flow-epic-self-mark: ${r.outcome} ${r.epicSlug}/${r.featureId} (#${r.pr ?? "?"})${flags}\n`,
    );
  }
  return 0;
}

export function main(argv: string[], deps: Deps = {}): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    process.stderr.write(`flow-epic-self-mark: ${parsed}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const bad = validateShape(parsed);
  if (bad) {
    process.stderr.write(`flow-epic-self-mark: ${bad}\n${USAGE}\n`);
    return 2;
  }
  const git = deps.git ?? defaultGit;
  const gh = deps.gh ?? defaultGh;
  const baseCwd = deps.cwd ?? process.cwd();
  const ambient = resolveSlugFromEnv(deps.env ?? process.env);

  // Inside a pipeline the helper is pre-approved (no classifier review), so it
  // must refuse to act for any pipeline or feature other than its own.
  if (ambient && !parsed.seed) {
    if (parsed.slug && parsed.slug !== ambient) {
      return refuseUsage(
        `--slug ${parsed.slug} is not this pipeline (${ambient})`,
      );
    }
    if (parsed.epicSlug) {
      const own = resolveEpicBinding({
        slug: ambient,
        stateDir: deps.stateDir,
        epicsDir: deps.epicsDir,
      });
      if (
        own.kind !== "bound" ||
        own.epicSlug !== parsed.epicSlug ||
        own.featureId !== parsed.feature
      ) {
        return refuseUsage(
          `${parsed.epicSlug}/${parsed.feature} is not this pipeline's own feature; the explicit form is a manual repair, run it from a plain terminal`,
        );
      }
    }
  }

  if (parsed.seed) {
    return report(
      seedEpicBoard({ cwd: baseCwd, epicSlug: parsed.epicSlug!, git }),
      parsed.json,
    );
  }

  const common = {
    commit: parsed.commit,
    push: parsed.push,
    resolveConflict: parsed.resolveConflict,
    gh,
    git: deps.git,
    stateDir: deps.stateDir,
    epicsDir: deps.epicsDir,
  };
  if (parsed.epicSlug) {
    return report(
      selfMarkEpicRow({
        ...common,
        cwd: baseCwd,
        explicit: {
          epicSlug: parsed.epicSlug,
          featureId: parsed.feature!,
          pr: parsed.pr!,
        },
      }),
      parsed.json,
    );
  }

  const slug = parsed.slug ?? ambient;
  if (!slug) {
    return parsed.resolveConflict
      ? report(
          {
            outcome: "refused",
            reason: "no-binding",
            detail: "no pipeline slug to bind for --resolve-conflict",
            committed: false,
            pushed: false,
          },
          parsed.json,
        )
      : report(notBound(), parsed.json);
  }
  const state = readState(slug, deps.stateDir ?? flowStateDir());
  const cwd =
    state?.worktree && fs.existsSync(state.worktree) ? state.worktree : baseCwd;
  const base = { ...common, cwd, slug };
  let result = selfMarkEpicRow({ ...base, pr: parsed.pr ?? state?.pr });
  if (result.reason === "no-pr") {
    const pr = lookupPr(deps.gh ?? ghIn(cwd), git, cwd);
    if (pr !== undefined) result = selfMarkEpicRow({ ...base, pr });
  }
  return report(result, parsed.json);
}

function refuseUsage(msg: string): number {
  process.stderr.write(`flow-epic-self-mark: refused: ${msg}\n`);
  return 2;
}

function notBound(): SelfMarkResult {
  return { outcome: "not-bound", committed: false, pushed: false };
}

const ghIn =
  (cwd: string): GhRunner =>
  (argv) => {
    const r = spawnSync("gh", argv, { cwd, encoding: "utf8" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.status ?? -1,
    };
  };

function lookupPr(
  gh: GhRunner,
  git: GitRunner,
  cwd: string,
): number | undefined {
  const branch = currentBranch(cwd, git);
  if (!branch) return undefined;
  const r = gh(["pr", "view", branch, "--json", "number"]);
  if (r.exitCode !== 0) return undefined;
  try {
    const n = (JSON.parse(r.stdout) as { number?: unknown }).number;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
