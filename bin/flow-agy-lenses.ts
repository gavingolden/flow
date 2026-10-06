#!/usr/bin/env bun
/**
 * Delegated review lenses for `/flow-pr-review`: runs the review lenses a
 * recorded recall check cleared (or the user opted in via `delegate.lenses`)
 * on Claude Opus through the user's idle Google AI Ultra quota (agy) instead
 * of as Claude Task agents, and tells the supervisor which lenses it could
 * NOT deliver so it Task-spawns exactly those. No lens is ever silently
 * dropped: delegated ∪ fallback == the agy-routed lenses.
 *
 * Modeled on `bin/flow-gemini-lens.ts` (the additive Gemini lens): pre-clean,
 * write-only-on-success, branch on `ran` / a schema-valid payload (never the
 * exit code — agy can exit 0 with an empty body), a `Deps` seam for tests.
 *
 *   flow-agy-lenses --worktree <dir> --skill-dir <flow-pr-review skill dir>
 *                   --lenses <csv> [--plan-only] [--slug <slug>] [--config <path>]
 *
 * `--plan-only` prints `{routes}` and exits with NO agy call (instant): the
 * supervisor uses it to Task-spawn the `task`-routed lenses in parallel with
 * the agy wave. The full run prints
 * `{model, routes, delegated, fallback, cooldownArmed}` and writes the same
 * record (merged across waves of one review) to `.flow-tmp/agy-lenses-result.json`.
 *
 * Prompt inputs come from the on-disk review-prep artifacts. `paths.fetch` is
 * deliberately NEVER read: it carries reviewer comments, and showing those to
 * a lens breaks Step 3's anti-anchoring rule. The PR title/body/base branch
 * come from one `gh pr view`; the repo checklist from the BASE branch via
 * `git show origin/<base>`, never the working tree.
 *
 * Exit codes: 0 on every graceful path (callers branch on the envelope); 2 on
 * a usage error.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeLensArtifact,
  classifyUnusableLensRun,
  projectLensFindings,
  AGENT_FINDINGS_JSON_SCHEMA,
} from "./lib/agy-lens-core";
import {
  armCooldown,
  quotaResetMs,
  readCooldown,
  shouldArmCooldown,
} from "./lib/agy-cooldown";
import { classifyAgyFailure } from "./lib/agy-failure-class";
import {
  mergeAgyLensesRecord,
  parseAgyLensesRecord,
  type AgyLensesEnvelope,
  type AgyLensesRecord,
  type DelegatedLensResult,
  type FallbackLensResult,
} from "./lib/agy-lenses-record";
import {
  DELEGATABLE_LENSES,
  DELEGATED_LENS_TIMEOUT,
  resolveDelegateModel,
  resolveDelegatedLenses,
  type DelegatableLens,
} from "./lib/delegate-models";
import { classifyDelegateSkip } from "./lib/delegate-skip-class";
import { planLensRoutes, type LensRoute } from "./lib/delegated-lens-plan";
import { buildDelegatedLensPrompt } from "./lib/lens-prompt";
import {
  defaultReadConfigFile,
  readPhaseModel,
  readReviewLensModel,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
} from "./lib/models-config";
import {
  CONFIG_KEYS,
  resolveRouting,
  type ConfigModels,
} from "./lib/model-routing-table";
import { resolveSlugAmbient } from "./lib/session-identity";
import { readState, type ModelAlias, type PipelineState } from "./lib/state";
import {
  run as runFanoutCli,
  type EntryResult,
  type FanoutResult,
  type ManifestEntry,
} from "./flow-delegate-fanout";
import { route as routeStaticAnalysis } from "./flow-pr-agent-lens";

export type Args = {
  worktree: string;
  skillDir: string;
  lenses: DelegatableLens[];
  planOnly: boolean;
  slug?: string;
  config?: string;
};

const USAGE =
  "usage: flow-agy-lenses --worktree <dir> --skill-dir <flow-pr-review skill dir> --lenses <csv> [--plan-only] [--slug <slug>] [--config <path>]";

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> & { lensesCsv?: string } = { planOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--plan-only") {
      out.planOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--worktree":
        out.worktree = value;
        break;
      case "--skill-dir":
        out.skillDir = value;
        break;
      case "--lenses":
        out.lensesCsv = value;
        break;
      case "--slug":
        out.slug = value;
        break;
      case "--config":
        out.config = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (out.worktree === undefined) return { error: "--worktree is required" };
  if (out.skillDir === undefined) return { error: "--skill-dir is required" };
  if (out.lensesCsv === undefined) return { error: "--lenses is required" };
  const lenses: DelegatableLens[] = [];
  for (const name of out.lensesCsv.split(",").map((s) => s.trim())) {
    if (name === "") continue;
    const known = DELEGATABLE_LENSES.find((l) => l === name);
    if (known === undefined) {
      return {
        error: `unknown lens '${name}' — expected one of: ${DELEGATABLE_LENSES.join(", ")}`,
      };
    }
    if (!lenses.includes(known)) lenses.push(known);
  }
  if (lenses.length === 0) return { error: "--lenses names no lens" };
  return {
    worktree: out.worktree,
    skillDir: out.skillDir,
    lenses,
    planOnly: out.planOnly ?? false,
    slug: out.slug,
    config: out.config,
  };
}

export type PrMeta = {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
};

export type Deps = {
  readConfig: ReadConfigFile;
  resolveSlug: () => string | null;
  loadState: (slug: string) => PipelineState | null;
  // null when the file is absent or unreadable.
  readFile: (path: string) => string | null;
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (dir: string) => void;
  ghPrView: (pr: number, cwd: string) => PrMeta | null;
  gitShow: (spec: string, cwd: string) => string | null;
  runFanout: (
    manifest: ManifestEntry[],
    opts: { concurrency: number; manifestPath: string; outPath: string },
  ) => Promise<FanoutResult>;
  readCooldown: () => { live: boolean; until?: string };
  armCooldown: (classes: string[], resetMs: number | null) => void;
  writeOut: (line: string) => void;
};

const tmp = (worktree: string, name: string) =>
  join(worktree, ".flow-tmp", name);

function fileConfigReader(path: string): ReadConfigFile {
  return () => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };
}

// The Task path's model for a lens, so a Fable session is detectable. A
// resolved "" is the uncapped-inherit case (bug-detection): the session model
// from state, when there is one.
function taskModelResolver(
  read: ReadConfigFile,
  state: PipelineState | null,
): (lens: DelegatableLens) => string | null {
  const config: ConfigModels = {};
  for (const key of CONFIG_KEYS) config[key] = readPhaseModel(key, read);
  const reviewLenses: Partial<Record<string, ModelAlias>> = {};
  for (const l of REVIEW_LENS_NAMES) {
    const v = readReviewLensModel(l, read);
    if (v) reviewLenses[l] = v;
  }
  config.reviewLenses = reviewLenses;
  const rows = resolveRouting({ state, config });
  return (lens) => {
    const row = rows.find((r) => r.phase === `review-lens:${lens}`);
    if (row?.model) return row.model;
    return state?.model ?? null;
  };
}

type PrepInputs = {
  pr: number;
  agentPromptsMd: string;
  conventionalCommentsMd: string;
  meta: PrMeta;
  repoChecklistMd: string | null;
  commitMessages: string;
  diff: string;
  intentComments: string;
  changedFiles: string[];
  reviewScope: string;
  reviewStartedAt: string | null;
  tension: boolean;
  staticAnalysis: unknown;
  productBrief: { path: string | null; text: string | null };
};

function deltaScopeText(scope: Record<string, unknown>): string {
  const base7 = String(scope.base_sha ?? "").slice(0, 7);
  const head7 = String(scope.head_sha ?? "").slice(0, 7);
  const files = Array.isArray(scope.delta_files)
    ? (scope.delta_files as string[])
    : [];
  return `Delta re-entry: the diff below covers only ${base7}..${head7} (${files.length} files). Read every listed file in full; findings must still cite PR-touched lines. If a delta hunk changes a contract used by unchanged PR files, report it as a finding — do not assume the earlier review covered it.\n${files.join("\n")}`;
}

// Throws on a missing critical input; the caller turns that into a per-wave
// `agy-prep-failed` fallback for every agy-routed lens.
function loadInputs(args: Args, deps: Deps): PrepInputs {
  const need = (path: string): string => {
    const text = deps.readFile(path);
    if (text === null) throw new Error(`missing ${path}`);
    return text;
  };
  const prep = JSON.parse(need(tmp(args.worktree, "review-prep.json")));
  const paths = prep.paths as Record<string, string>;
  const scope = JSON.parse(deps.readFile(paths.review_scope) ?? "{}") as Record<
    string,
    unknown
  >;
  const meta = deps.ghPrView(prep.pr, args.worktree);
  if (meta === null) throw new Error("gh pr view failed");
  const diff = need(paths.diff);
  const changedFiles = Array.isArray(scope.pr_files)
    ? (scope.pr_files as string[])
    : (diff.match(/^diff --git a\/(\S+)/gm) ?? []).map((l) =>
        l.replace(/^diff --git a\//, ""),
      );
  let staticAnalysis: unknown = null;
  try {
    staticAnalysis = JSON.parse(need(paths.static_analysis));
  } catch {
    staticAnalysis = null;
  }
  const brief = scope.product_brief as
    | { found?: boolean; path?: string }
    | undefined;
  const briefPath = brief?.found === true ? (brief.path ?? null) : null;
  return {
    pr: prep.pr,
    agentPromptsMd: need(join(args.skillDir, "references", "agent-prompts.md")),
    conventionalCommentsMd: need(
      join(args.skillDir, "references", "conventional-comments.md"),
    ),
    meta,
    repoChecklistMd: deps.gitShow(
      `origin/${meta.baseRefName}:.flow/review-checklist.md`,
      args.worktree,
    ),
    commitMessages: deps.readFile(paths.commits) ?? "(none)",
    diff,
    intentComments: deps.readFile(paths.intent_comments) ?? "(none)",
    changedFiles,
    reviewScope:
      scope.scope === "delta" ? deltaScopeText(scope) : "Full PR diff.",
    reviewStartedAt:
      typeof scope.started_at === "string" ? scope.started_at : null,
    tension: prep.prompt_interpretation_tension === true,
    staticAnalysis,
    productBrief: {
      path: briefPath,
      text: briefPath === null ? null : deps.readFile(briefPath),
    },
  };
}

function staticFacts(sa: unknown, lens: DelegatableLens): string {
  if (sa === null) {
    return "(static analysis was not available this run — reason from the diff alone)";
  }
  try {
    return JSON.stringify(routeStaticAnalysis(sa as never, lens));
  } catch {
    return "(static analysis could not be routed for this lens — reason from the diff alone)";
  }
}

// An environment skip never spent quota, so it must never arm the cooldown;
// anything dispatched is classified from the delegate's own diagnostics.
function failureClass(skipReason: string, e: Partial<EntryResult>): string {
  if (classifyDelegateSkip(skipReason) === "environment") return "environment";
  return classifyAgyFailure({
    skipReason,
    stderrTail: e.stderrTail,
    agyError: e.agyError,
    agyStatus: e.agyStatus,
  });
}

async function runDelegated(
  args: Args,
  deps: Deps,
  variant: string,
  agyLenses: DelegatableLens[],
): Promise<{
  delegated: DelegatedLensResult[];
  fallback: FallbackLensResult[];
  classes: string[];
  failureTexts: string[];
  startedAt: string | null;
}> {
  const delegated: DelegatedLensResult[] = [];
  const fallback: FallbackLensResult[] = [];
  const classes: string[] = [];
  const failureTexts: string[] = [];
  const failAll = (reason: string, startedAt: string | null) => {
    for (const lens of agyLenses) {
      fallback.push({
        lens,
        reason,
        skipClass: classifyDelegateSkip(reason),
      });
      classes.push("environment");
    }
    return { delegated, fallback, classes, failureTexts, startedAt };
  };

  let inputs: PrepInputs;
  try {
    inputs = loadInputs(args, deps);
  } catch {
    return failAll("agy-prep-failed", null);
  }

  const schemaPath = tmp(args.worktree, "agy-lenses.schema.json");
  const manifestPath = tmp(args.worktree, "agy-lenses.manifest.json");
  const fanoutOut = tmp(args.worktree, "agy-lenses.fanout.json");
  const scratch = [schemaPath, manifestPath, fanoutOut];
  const manifest: ManifestEntry[] = [];
  const manifestLenses: DelegatableLens[] = [];
  try {
    deps.mkdirp(join(args.worktree, ".flow-tmp"));
    deps.writeFile(schemaPath, JSON.stringify(AGENT_FINDINGS_JSON_SCHEMA));
    for (const lens of agyLenses) {
      try {
        const promptPath = tmp(args.worktree, `agy-lens-${lens}.prompt`);
        const checklistMd = deps.readFile(
          join(args.skillDir, "references", "checklists", `${lens}.md`),
        );
        if (checklistMd === null) throw new Error("missing checklist");
        deps.writeFile(
          promptPath,
          buildDelegatedLensPrompt({
            lens,
            agentPromptsMd: inputs.agentPromptsMd,
            checklistMd,
            conventionalCommentsMd: inputs.conventionalCommentsMd,
            repoChecklistMd: inputs.repoChecklistMd,
            prNumber: inputs.pr,
            prTitle: inputs.meta.title,
            prBody: inputs.meta.body,
            commitMessages: inputs.commitMessages,
            changedFiles: inputs.changedFiles,
            diff: inputs.diff,
            staticAnalysisFacts: staticFacts(inputs.staticAnalysis, lens),
            intentComments: inputs.intentComments,
            reviewScope: inputs.reviewScope,
            promptInterpretationTension: inputs.tension,
            productBriefPath: inputs.productBrief.path,
            productBriefText: inputs.productBrief.text,
            worktree: args.worktree,
          }),
        );
        scratch.push(promptPath, tmp(args.worktree, `agy-lens-${lens}.raw`));
        manifest.push({
          task: `agy-lens-${lens}`,
          model: variant,
          promptFile: promptPath,
          timeout: DELEGATED_LENS_TIMEOUT,
          addDirs: [args.worktree],
          out: tmp(args.worktree, `agy-lens-${lens}.raw`),
          outputFormat: "json",
          jsonSchema: schemaPath,
        });
        manifestLenses.push(lens);
      } catch {
        fallback.push({
          lens,
          reason: "agy-prep-failed",
          skipClass: "environment",
        });
        classes.push("environment");
      }
    }
  } catch {
    for (const p of scratch) deps.removeFile(p);
    fallback.length = 0;
    classes.length = 0;
    return failAll("agy-prep-failed", inputs.reviewStartedAt);
  }

  let result: FanoutResult | null = null;
  if (manifest.length > 0) {
    try {
      result = await deps.runFanout(manifest, {
        concurrency: manifest.length,
        manifestPath,
        outPath: fanoutOut,
      });
    } catch {
      result = null;
    }
  }

  manifestLenses.forEach((lens, i) => {
    const e = result?.entries[i];
    if (e === undefined) {
      fallback.push({
        lens,
        reason: "agy-fanout-failed",
        skipClass: "ran-unusable",
      });
      classes.push("environment");
      return;
    }
    if (!e.ran) {
      const reason = e.skipReason ?? "agy-skip";
      fallback.push({ lens, reason, skipClass: classifyDelegateSkip(reason) });
      classes.push(failureClass(reason, e));
      failureTexts.push(e.agyError ?? "", e.stderrTail ?? "");
      return;
    }
    let raw = "";
    try {
      raw = deps.readFile(e.artifactPath ?? manifest[i]!.out!) ?? "";
    } catch {
      raw = "";
    }
    const decoded = decodeLensArtifact(raw);
    if (!decoded.ok) {
      const reason = `agy-${classifyUnusableLensRun(raw, e)}`;
      fallback.push({ lens, reason, skipClass: "ran-unusable" });
      classes.push("empty-artifact");
      return;
    }
    try {
      deps.writeFile(
        tmp(args.worktree, `agent-output-${lens}.json`),
        JSON.stringify(projectLensFindings(decoded.value), null, 2),
      );
    } catch {
      fallback.push({
        lens,
        reason: "agy-finalize-failed",
        skipClass: "environment",
      });
      classes.push("environment");
      return;
    }
    delegated.push({
      lens,
      findingCount: decoded.value.findings.length,
      decodedVia: decoded.via,
      durationSec: Math.round(e.durationSeconds ?? (e.durationMs ?? 0) / 1000),
    });
  });

  for (const p of scratch) deps.removeFile(p);
  return {
    delegated,
    fallback,
    classes,
    failureTexts,
    startedAt: inputs.reviewStartedAt,
  };
}

export async function run(
  argv: string[],
  depsOverride?: Partial<Deps>,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-agy-lenses: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const deps = resolveDeps(parsed, depsOverride);

  const variant = resolveDelegateModel("claudeLenses", deps.readConfig);
  const slug = parsed.slug ?? deps.resolveSlug();
  const state = slug ? deps.loadState(slug) : null;
  const routes: LensRoute[] = planLensRoutes({
    lenses: parsed.lenses,
    variant,
    delegated: resolveDelegatedLenses(deps.readConfig),
    taskModelFor: taskModelResolver(deps.readConfig, state),
    cooldownLive: deps.readCooldown().live,
  });

  if (parsed.planOnly) {
    deps.writeOut(JSON.stringify({ routes }));
    return 0;
  }

  const agyLenses = routes.filter((r) => r.route === "agy").map((r) => r.lens);
  // Pre-clean: a stale agent-output from an earlier run on this reused
  // worktree must never be consumed as this run's lens output.
  for (const lens of agyLenses) {
    deps.removeFile(tmp(parsed.worktree, `agent-output-${lens}.json`));
  }

  let delegated: DelegatedLensResult[] = [];
  let fallback: FallbackLensResult[] = [];
  let cooldownArmed = false;
  let startedAt: string | null = null;
  if (agyLenses.length > 0 && variant !== null) {
    const r = await runDelegated(parsed, deps, variant, agyLenses);
    delegated = r.delegated;
    fallback = r.fallback;
    startedAt = r.startedAt;
    // Every agy-routed lens failing is the signature of exhausted or
    // throttled quota; hold the next reviews on Claude for a while.
    if (delegated.length === 0 && shouldArmCooldown(r.classes)) {
      try {
        deps.armCooldown(r.classes, quotaResetMs(r.failureTexts));
        cooldownArmed = true;
      } catch {
        cooldownArmed = false;
      }
    }
  }

  const record: AgyLensesRecord = {
    review_started_at: startedAt ?? readStartedAt(parsed, deps),
    model: variant,
    routes,
    delegated,
    fallback,
    cooldownArmed,
  };
  const resultPath = tmp(parsed.worktree, "agy-lenses-result.json");
  try {
    deps.mkdirp(join(parsed.worktree, ".flow-tmp"));
    deps.writeFile(
      resultPath,
      JSON.stringify(
        mergeAgyLensesRecord(
          parseAgyLensesRecord(deps.readFile(resultPath)),
          record,
        ),
        null,
        2,
      ),
    );
  } catch {
    // The envelope below is the contract; the record only feeds telemetry.
  }
  const envelope: AgyLensesEnvelope = {
    model: variant,
    routes,
    delegated,
    fallback,
    cooldownArmed,
  };
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

function readStartedAt(args: Args, deps: Deps): string | null {
  try {
    const prep = JSON.parse(
      deps.readFile(tmp(args.worktree, "review-prep.json")) ?? "{}",
    );
    const scope = JSON.parse(deps.readFile(prep.paths.review_scope) ?? "{}");
    return typeof scope.started_at === "string" ? scope.started_at : null;
  } catch {
    return null;
  }
}

function spawnText(argv: string[], cwd: string): string | null {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null;
}

async function defaultRunFanout(
  manifest: ManifestEntry[],
  opts: { concurrency: number; manifestPath: string; outPath: string },
): Promise<FanoutResult> {
  writeFileSync(opts.manifestPath, JSON.stringify(manifest));
  let captured = "";
  const code = await runFanoutCli(
    [
      "--manifest",
      opts.manifestPath,
      "--concurrency",
      String(opts.concurrency),
      "--max-calls",
      String(manifest.length),
      "--out",
      opts.outPath,
    ],
    {
      // The fanout's aggregate JSON must never reach this helper's stdout:
      // the supervisor parses ONE envelope from it.
      writeOut: (line) => {
        captured = line;
      },
      progress: () => {},
    },
  );
  if (code !== 0) throw new Error(`flow-delegate-fanout exited ${code}`);
  return JSON.parse(captured) as FanoutResult;
}

function resolveDeps(args: Args, o?: Partial<Deps>): Deps {
  return {
    readConfig:
      o?.readConfig ??
      (args.config ? fileConfigReader(args.config) : defaultReadConfigFile),
    resolveSlug: o?.resolveSlug ?? (() => resolveSlugAmbient()),
    loadState: o?.loadState ?? ((slug) => readState(slug)),
    readFile:
      o?.readFile ??
      ((p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      }),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    ghPrView:
      o?.ghPrView ??
      ((pr, cwd) => {
        const out = spawnText(
          [
            "gh",
            "pr",
            "view",
            String(pr),
            "--json",
            "number,title,body,baseRefName",
          ],
          cwd,
        );
        if (out === null) return null;
        try {
          return JSON.parse(out) as PrMeta;
        } catch {
          return null;
        }
      }),
    gitShow:
      o?.gitShow ?? ((spec, cwd) => spawnText(["git", "show", spec], cwd)),
    runFanout: o?.runFanout ?? defaultRunFanout,
    readCooldown: o?.readCooldown ?? (() => readCooldown()),
    armCooldown:
      o?.armCooldown ??
      ((classes, resetMs) =>
        armCooldown(classes, undefined, undefined, resetMs)),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
  };
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
