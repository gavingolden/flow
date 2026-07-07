/**
 * Single source of truth for the per-phase / per-fan-out model + effort
 * routing that `flow config models` audits. Declares every rendered spawn
 * site (session + the ten fan-out sub-agents) and a pure `resolveRouting`
 * that walks each site's precedence chain.
 *
 * The precedence chains encoded here mirror
 * `skills/pipeline/flow-pipeline/references/model-routing.md` exactly; the
 * drift lint in `model-routing-table.test.ts` pins the two together so this
 * table can never silently diverge from the chain the pipeline actually runs.
 *
 * `MODEL_ALIASES` / `EFFORT_LEVELS` / `PHASE_MODEL_FLAGS` are imported from
 * `state.ts` — the phase→flag map is NOT re-typed here (a second copy would
 * break the single-source-of-truth the Task `model:` enum depends on).
 */

import {
  PHASE_MODEL_FLAGS,
  type EffortLevel,
  type ModelAlias,
  type PipelineState,
} from "./state";

/** Terminal fallback kind when neither a state override nor config resolves. */
export type Fallback = "inherited" | "builtin-sonnet" | "pinned-haiku";

export type SpawnSite = {
  /** User-facing row label (kebab-case), e.g. `fix-applier`. */
  phase: string;
  /**
   * The `PipelineState` field a `--model-<phase>` (or `--model`) flag writes,
   * when this site has one. `scout`/`coder` share `modelImplement`; the
   * gatekeeper and epic-judge have none (pinned / run-state respectively).
   */
  stateField?: keyof PipelineState & string;
  /** The `config.models.<key>` this site's primary config grain reads. */
  configKey?: string;
  /**
   * A finer config grain that layers ABOVE `stateField` (wins when set) —
   * `scout`/`coder` only. No CLI flag exists for these.
   */
  fineGrainAbove?: string;
  fallback: Fallback;
  /** Only `flow-verify` + `flow-fix-applier` pin effort (frontmatter). */
  effortPin?: EffortLevel;
};

/**
 * Every rendered site. Order is the render order. `session` + `gatekeeper`
 * are prose-only in `model-routing.md` (not precedence-table rows); the drift
 * lint treats them as table-exempt.
 */
export const SPAWN_SITES: readonly SpawnSite[] = [
  {
    phase: "session",
    stateField: "model",
    configKey: "default",
    fallback: "inherited",
  },
  {
    phase: "planning",
    stateField: "modelPlanning",
    configKey: "planning",
    fallback: "inherited",
  },
  {
    phase: "scout",
    stateField: "modelImplement",
    configKey: "implement",
    fineGrainAbove: "scout",
    fallback: "inherited",
  },
  {
    phase: "coder",
    stateField: "modelImplement",
    configKey: "implement",
    fineGrainAbove: "coder",
    fallback: "inherited",
  },
  // verify + fix-applier fall back to a LITERAL sonnet, not the session model:
  // both are mechanical gate/apply work that must not silently inherit Opus/Fable.
  {
    phase: "verify",
    stateField: "modelVerify",
    configKey: "verify",
    fallback: "builtin-sonnet",
    effortPin: "low",
  },
  {
    phase: "review",
    stateField: "modelReview",
    configKey: "review",
    fallback: "inherited",
  },
  {
    phase: "fix-applier",
    stateField: "modelFixApplier",
    configKey: "fixApplier",
    fallback: "builtin-sonnet",
    effortPin: "low",
  },
  {
    phase: "consolidator",
    stateField: "modelConsolidator",
    configKey: "consolidator",
    fallback: "inherited",
  },
  {
    phase: "merge-resolver",
    stateField: "modelMergeResolver",
    configKey: "mergeResolver",
    fallback: "inherited",
  },
  // gatekeeper is pinned haiku by design (cheap cost-routing) — no flag, no
  // config grain, never inherits. config.models.gatekeeper is reachable but
  // deliberately NOT wired here.
  { phase: "gatekeeper", fallback: "pinned-haiku" },
  // epic-judge's per-run override lives in ~/.flow/epics/<slug>/run.json, not
  // feature state.json — so it has no feature-state field here.
  { phase: "epic-judge", configKey: "epicJudge", fallback: "inherited" },
] as const;

/** Deduped list of every `config.models.<key>` the sites read. */
export const CONFIG_KEYS: readonly string[] = [
  ...new Set(
    SPAWN_SITES.flatMap((s) =>
      [s.fineGrainAbove, s.configKey].filter((k): k is string => !!k),
    ),
  ),
];

/** Injected, already-validated `config.models` table (key → alias). */
export type ConfigModels = Partial<Record<string, ModelAlias>>;

export type ResolvedRow = {
  phase: string;
  /** Resolved alias, or `""` when the site inherits the session model. */
  model: ModelAlias | "";
  source: string;
  effort: string;
};

const FLAG_BY_FIELD = new Map<string, string>([
  ...PHASE_MODEL_FLAGS.map((f) => [f.field, f.flag] as const),
  ["model", "--model"],
]);

function stateSource(field: string): string {
  return `state (${FLAG_BY_FIELD.get(field) ?? `--${field}`})`;
}

function fallbackRow(fallback: Fallback): {
  model: ModelAlias | "";
  source: string;
} {
  switch (fallback) {
    case "builtin-sonnet":
      return { model: "sonnet", source: "built-in (sonnet)" };
    case "pinned-haiku":
      return { model: "haiku", source: "pinned" };
    case "inherited":
      return { model: "", source: "inherited" };
  }
}

function resolveEffort(
  site: SpawnSite,
  state: PipelineState | null | undefined,
): string {
  if (site.effortPin) return `${site.effortPin} (pinned)`;
  return state?.effort ?? "inherited";
}

/**
 * Pure resolver: walk each site's precedence chain against the injected
 * `state` (a feature `state.json`, or null/undefined for the global view) and
 * `config` (the validated `config.models` table). No I/O — the CLI shim does
 * the tolerant reads and passes the results in.
 */
export function resolveRouting(input: {
  state: PipelineState | null | undefined;
  config: ConfigModels;
}): ResolvedRow[] {
  const { state, config } = input;
  return SPAWN_SITES.map((site) => {
    const resolved = resolveModel(site, state, config);
    return {
      phase: site.phase,
      ...resolved,
      effort: resolveEffort(site, state),
    };
  });
}

function resolveModel(
  site: SpawnSite,
  state: PipelineState | null | undefined,
  config: ConfigModels,
): { model: ModelAlias | ""; source: string } {
  // fine-grain config (scout/coder) wins above the state override
  if (site.fineGrainAbove) {
    const v = config[site.fineGrainAbove];
    if (v)
      return { model: v, source: `config (models.${site.fineGrainAbove})` };
  }
  if (site.stateField) {
    const v = state?.[site.stateField];
    if (typeof v === "string" && v) {
      return { model: v as ModelAlias, source: stateSource(site.stateField) };
    }
  }
  if (site.configKey) {
    const v = config[site.configKey];
    if (v) return { model: v, source: `config (models.${site.configKey})` };
  }
  return fallbackRow(site.fallback);
}
