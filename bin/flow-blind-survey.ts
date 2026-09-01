#!/usr/bin/env bun
/**
 * Two model-pinned agy judges over a goal-only brief, for `/flow-pipeline`
 * Step 3's blind method survey.
 *
 * Unlike `flow-plan-review` (which pressure-tests the PRD's already-chosen
 * design), this helper runs BEFORE discovery drafts a plan: each judge sees
 * only a goal-only brief — never the user's proposed mechanism, never the
 * raw description — and independently recommends how to accomplish the
 * goal on its merits. `bin/lib/blind-survey-prompt.ts`'s `briefLeaksCorpus`
 * guard refuses to run the survey at all when the brief the supervisor
 * assembled leaks a verbatim run of the user's own words back in — that
 * would silently un-blind the judge.
 *
 * Sibling of `flow-plan-review.ts`'s SYNCHRONOUS deep-tier body only — the
 * survey always runs exactly two judges (there is no standard/deep tier
 * distinction here), and it never grows the async `--start`/`--check`
 * spine that file carries: this call is bounded by the supervisor's own
 * Bash-tool timeout (see JUDGE_A_TIMEOUT/JUDGE_B_TIMEOUT below), foreground,
 * one shot.
 *
 * Skip vocabulary: `brief-unreadable` / `description-unreadable` (the two
 * input files), `brief-not-blind` (the blindness guard fired — no fanout
 * call is made), `worktree-not-provided` / `worktree-not-found`,
 * `fanout-error` (the fanout call itself came back empty — binary missing,
 * a usage-error exit, or an unparsable aggregate line — distinct from a
 * per-entry failure because neither judge task even reached the
 * aggregate), `agy-not-found` / `agy-not-authenticated` / `agy-error`
 * (propagated from a `ran:false` fanout entry that IS present in the
 * aggregate), `judge-timeout` (a fanout entry's `agy-timeout`, mapped the
 * way `flow-plan-review`'s `mapReviewerSkipReason` maps its own
 * reviewer-timeout), `judge-empty` (a judge's artifact is missing or under
 * 40 chars — too short to be a real recommendation), and the local
 * IO-throw defensive skips `survey-prep-failed` / `survey-finalize-failed`.
 * Branch on the envelope's `ran` field, never the exit code — every
 * non-usage path exits 0.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { buildSurveyPrompt, briefLeaksCorpus } from "./lib/blind-survey-prompt";
import {
  DELEGATE_MODEL_DEFAULTS,
  resolveDelegateModel,
} from "./lib/delegate-models";

// Both judges read the repository (their sole `--add-dir`), so each call is
// an AGENTIC run, not a single completion — bounded explicitly rather than
// relying on flow-delegate's own default. This helper is a SYNCHRONOUS
// Bash-tool call under the supervisor's 600 000 ms (10 minute) cap, so the
// two caps' SUM must leave real headroom under that ceiling: 3m + 6m = 9m,
// vs a 10m cap. Measured live: the dogfood run of this same prompt shape
// (goal-only brief, repo read access) finished in 12s / 46s on a light
// brief — well inside 3m. JUDGE_B_TIMEOUT is doubled to 6m rather than
// matched to JUDGE_A_TIMEOUT because `flow-plan-review`'s own deep-tier
// second (Opus) reviewer measured 4m30-4m50 engaged with repo reads on a
// full PRD — a heavier prompt than this survey's goal-only brief, but the
// same model family and the same "reads the repo" shape, so 6m keeps
// meaningful margin over that measured ceiling without threatening the
// 9m-under-10m budget.
export const JUDGE_A_TIMEOUT = "3m";
export const JUDGE_B_TIMEOUT = "6m";

export const SKIP_REASONS = [
  "brief-unreadable",
  "description-unreadable",
  "brief-not-blind",
  "worktree-not-provided",
  "worktree-not-found",
  "fanout-error",
  "agy-not-found",
  "agy-not-authenticated",
  "agy-error",
  "judge-timeout",
  "judge-empty",
  "survey-prep-failed",
  "survey-finalize-failed",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type Args = {
  briefFile: string;
  descriptionFile: string;
  out: string;
  // OPTIONAL by design, mirroring flow-plan-review.ts's own --worktree:
  // a caller that omits it hits the worktree-not-provided run()-time skip
  // below rather than a parseArgs usage error — parseArgs stays the light
  // required-flag validator.
  worktree?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--brief-file":
        out.briefFile = value;
        break;
      case "--description-file":
        out.descriptionFile = value;
        break;
      case "--out":
        out.out = value;
        break;
      case "--worktree":
        out.worktree = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  const REQUIRED_FLAG = {
    briefFile: "--brief-file",
    descriptionFile: "--description-file",
    out: "--out",
  } as const;
  for (const k of Object.keys(
    REQUIRED_FLAG,
  ) as (keyof typeof REQUIRED_FLAG)[]) {
    if (out[k] === undefined) {
      return { error: `${REQUIRED_FLAG[k]} is required` };
    }
  }
  return {
    briefFile: out.briefFile as string,
    descriptionFile: out.descriptionFile as string,
    out: out.out as string,
    worktree: out.worktree,
  };
}

// The one-line aggregate `flow-delegate-fanout` emits, as consumed here.
// Defined locally rather than imported so this module does not couple to
// the fanout module's surface (mirrors bin/flow-plan-review.ts's own local
// `FanoutAggregate` type).
export type FanoutAggregate = {
  entries?: Array<{
    task: string;
    model?: string | null;
    ran?: boolean;
    artifactPath?: string;
    skipReason?: string;
  }>;
  anyRan?: boolean;
  allSkipped?: boolean;
};

type FanoutEntry = NonNullable<FanoutAggregate["entries"]>[number];

type SurveyManifestEntry = {
  task: string;
  model: string;
  promptFile: string;
  timeout: string;
  addDirs: string[];
  out: string;
};

type JudgeStatus = {
  model: string;
  ran: boolean;
  skipReason?: SkipReason;
  prose?: string;
};

// `flow-delegate`'s own `agy-timeout` is layer-correct for the delegate
// helper's generic vocabulary; this module owns the `judge-`-prefixed
// vocabulary, so it maps here — mirrors flow-plan-review.ts's
// mapReviewerSkipReason. Every other skipReason (including undefined)
// passes through unchanged.
function mapJudgeSkipReason(
  delegateSkipReason: string | undefined,
): SkipReason {
  if (delegateSkipReason === "agy-timeout") return "judge-timeout";
  return (delegateSkipReason as SkipReason | undefined) ?? "agy-not-found";
}

// Minimum artifact length to count as a real recommendation rather than a
// truncated/empty run — deliberately simpler than flow-plan-review.ts's
// lens-engagement classifier: this survey has no lens rubric to check
// against, just a length floor.
const MIN_ARTIFACT_CHARS = 40;

function resolveJudge(
  deps: Deps,
  entry: FanoutEntry | undefined,
  model: string,
): JudgeStatus {
  if (!entry || entry.ran !== true) {
    return {
      model,
      ran: false,
      skipReason: mapJudgeSkipReason(entry?.skipReason),
    };
  }
  try {
    const prose = deps.readFile(entry.artifactPath ?? "");
    if (prose.trim().length < MIN_ARTIFACT_CHARS) {
      return { model, ran: false, skipReason: "judge-empty" };
    }
    return { model, ran: true, prose };
  } catch {
    return { model, ran: false, skipReason: "judge-empty" };
  }
}

export type Deps = {
  // Runs flow-delegate-fanout against a prepared manifest file and returns
  // its parsed one-line aggregate envelope.
  runFanout: (input: {
    manifestPath: string;
    outPath: string;
    concurrency: number;
  }) => FanoutAggregate;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  // True when `path` exists and is a directory. Backs the worktree gate.
  dirExists: (path: string) => boolean;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(JSON.stringify({ error: parsed.error }));
    console.error(
      "usage: flow-blind-survey --brief-file <path> --description-file <path> --out <path> --worktree <dir>",
    );
    return 2;
  }

  // Scratch: two prompt files, the fanout manifest + its aggregate, and
  // each judge's own raw artifact — all siblings of --out. --out itself is
  // only ever (re)written on a ran:true finish, so a stale one from a prior
  // run is cleared up front, before any gate can short-circuit.
  const promptA = `${parsed.out}.judge-a.prompt`;
  const promptB = `${parsed.out}.judge-b.prompt`;
  const manifestPath = `${parsed.out}.fanout-manifest.json`;
  const fanoutOutPath = `${parsed.out}.fanout.json`;
  const judgeAOut = `${parsed.out}.judge-a.md`;
  const judgeBOut = `${parsed.out}.judge-b.md`;
  deps.removeFile(parsed.out);

  const cleanScratch = () => {
    for (const p of [
      promptA,
      promptB,
      manifestPath,
      fanoutOutPath,
      judgeAOut,
      judgeBOut,
    ]) {
      deps.removeFile(p);
    }
  };

  const skip = (skipReason: SkipReason): number => {
    cleanScratch();
    return emit(deps, { ran: false, skipReason });
  };

  let brief: string;
  try {
    brief = deps.readFile(parsed.briefFile);
  } catch {
    return skip("brief-unreadable");
  }
  if (brief.trim() === "") {
    return skip("brief-unreadable");
  }

  let corpus: string;
  try {
    corpus = deps.readFile(parsed.descriptionFile);
  } catch {
    return skip("description-unreadable");
  }
  if (corpus.trim() === "") {
    return skip("description-unreadable");
  }

  if (briefLeaksCorpus(brief, corpus)) {
    // No fanout call — the whole point of the guard is to never spend agy
    // quota (or leak the un-blinded brief to a judge) on a brief that
    // failed blindness.
    return skip("brief-not-blind");
  }

  if (!parsed.worktree) {
    return skip("worktree-not-provided");
  }
  if (!deps.dirExists(parsed.worktree)) {
    return skip("worktree-not-found");
  }

  // Resolved at call time (matching flow-plan-review / flow-research-run),
  // never at module load: a module-load read hits the real
  // ~/.flow/config.json before any test can inject an override, defeating
  // the injectable-config-reader seam.
  const first = resolveDelegateModel("blindSurvey") as string;
  let second = resolveDelegateModel("blindSurveySecond") as string;

  // Cross-model diversity guard, mirroring flow-research-run.ts's
  // resolveModels: a config override that collapses judge B onto judge A's
  // model would silently turn "two independent judges" into one judge run
  // twice, so fall back to the OTHER pinned default instead.
  if (second === first) {
    const defaultFirst = DELEGATE_MODEL_DEFAULTS.blindSurvey as string;
    const defaultSecond = DELEGATE_MODEL_DEFAULTS.blindSurveySecond as string;
    second = first === defaultSecond ? defaultFirst : defaultSecond;
    console.error(
      `flow-blind-survey: blindSurveySecond resolved equal to blindSurvey ("${first}"); falling back to "${second}".`,
    );
  }

  try {
    deps.mkdirp(dirname(parsed.out));
    const prompt = buildSurveyPrompt({ brief, worktreePath: parsed.worktree });
    deps.writeFile(promptA, prompt);
    deps.writeFile(promptB, prompt);
  } catch {
    return skip("survey-prep-failed");
  }

  const manifest: SurveyManifestEntry[] = [
    {
      task: "blind-survey-judge-a",
      model: first,
      promptFile: promptA,
      timeout: JUDGE_A_TIMEOUT,
      addDirs: [parsed.worktree],
      out: judgeAOut,
    },
    {
      task: "blind-survey-judge-b",
      model: second,
      promptFile: promptB,
      timeout: JUDGE_B_TIMEOUT,
      addDirs: [parsed.worktree],
      out: judgeBOut,
    },
  ];

  try {
    deps.writeFile(manifestPath, JSON.stringify(manifest));
  } catch {
    return skip("survey-prep-failed");
  }

  // concurrency 1 — SERIAL, and load-bearing: flow-plan-review.ts measured
  // 3/3 lost reviewers (a repo-reading agy session dying under contention)
  // when it ran two concurrent repo-reading agy sessions; this survey reads
  // the same repository with the same access shape, so it keeps the same
  // serialisation rather than re-risking that contention for speed.
  const aggregate = deps.runFanout({
    manifestPath,
    outPath: fanoutOutPath,
    concurrency: 1,
  });
  const entries = aggregate.entries ?? [];
  // An empty aggregate means the fanout call itself never produced a
  // per-task entry for either judge — the fanout binary is missing, it
  // exited with a usage error, or its stdout line failed to parse (all
  // three collapse into resolveDeps' default runFanout catch, which
  // returns `{ allSkipped: true, entries: [] }`). That is a distinct
  // failure from a non-empty aggregate carrying a `ran:false` entry with
  // its own agy-* skipReason, so it gets its own vocabulary rather than
  // being misattributed as `agy-not-found` via resolveJudge's per-entry
  // `entry === undefined` fallback below.
  if (entries.length === 0) {
    return skip("fanout-error");
  }
  const judgeA = resolveJudge(
    deps,
    entries.find((e) => e.task === manifest[0]!.task),
    first,
  );
  const judgeB = resolveJudge(
    deps,
    entries.find((e) => e.task === manifest[1]!.task),
    second,
  );

  if (!judgeA.ran && !judgeB.ran) {
    return skip(judgeA.skipReason ?? "agy-not-found");
  }

  const statusLine = (label: string, model: string, status: JudgeStatus) =>
    status.ran
      ? `${label}=${model} ran`
      : `${label}=${model} skipped:${status.skipReason}`;

  const survey = [
    "<!-- flow-blind-survey v1 -->",
    "# Blind method survey",
    "",
    `Judges: ${statusLine("A", first, judgeA)}, ${statusLine("B", second, judgeB)}`,
    "",
    "## Goal brief (as sent)",
    "",
    brief.trim(),
    "",
    `## Judge A — ${first}`,
    "",
    judgeA.ran
      ? (judgeA.prose ?? "").trim()
      : `_Judge A skipped: ${judgeA.skipReason}_`,
    "",
    `## Judge B — ${second}`,
    "",
    judgeB.ran
      ? (judgeB.prose ?? "").trim()
      : `_Judge B skipped: ${judgeB.skipReason}_`,
  ].join("\n");

  try {
    deps.writeFile(parsed.out, survey);
  } catch {
    cleanScratch();
    return emit(deps, { ran: false, skipReason: "survey-finalize-failed" });
  }

  cleanScratch();
  const judges = [
    {
      model: first,
      ran: judgeA.ran,
      ...(judgeA.skipReason ? { skipReason: judgeA.skipReason } : {}),
    },
    {
      model: second,
      ran: judgeB.ran,
      ...(judgeB.skipReason ? { skipReason: judgeB.skipReason } : {}),
    },
  ];
  return emit(deps, {
    ran: true,
    surveyPath: parsed.out,
    skipReason: null,
    judges,
  });
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    runFanout:
      o?.runFanout ??
      ((input) => {
        try {
          const r = Bun.spawnSync(
            [
              "flow-delegate-fanout",
              "--manifest",
              input.manifestPath,
              "--concurrency",
              String(input.concurrency),
              "--out",
              input.outPath,
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
          );
          const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
          const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
          return JSON.parse(line) as FanoutAggregate;
        } catch {
          return { allSkipped: true, entries: [] };
        }
      }),
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    dirExists:
      o?.dirExists ?? ((p) => existsSync(p) && statSync(p).isDirectory()),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
