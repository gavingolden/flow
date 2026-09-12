/**
 * Single source of truth for the per-phase / per-fan-out model + effort
 * routing that `flow config models` audits. Declares every rendered spawn
 * site (session + every fan-out sub-agent, see `SPAWN_SITES`) and a pure
 * `resolveRouting` that walks each site's precedence chain.
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
  MODEL_PRICE_RANK,
  INHERITANCE_CAP_ALIAS,
  type ModelAlias,
  type PipelineState,
} from "./state";
import { REVIEW_LENS_NAMES } from "./models-config";

/** Terminal fallback kind when neither a state override nor config resolves. */
export type Fallback =
  | "inherited"
  | "builtin-sonnet"
  | "pinned-haiku"
  | "session-capped-opus";

export type SpawnSite = {
  /** User-facing row label (kebab-case), e.g. `fix-applier`. */
  phase: string;
  /**
   * The `PipelineState` field a `--model-<phase>` (or `--model`) flag writes,
   * when this site has one. `scout`/`coder` share `modelImplement`.
   */
  stateField?: keyof PipelineState & string;
  /** The `config.models.<key>` this site's primary config grain reads. */
  configKey?: string;
  /**
   * A finer config grain that layers ABOVE `stateField` (wins when set). No
   * CLI flag exists for these. Two shapes: a FLAT top-level key (`scout` /
   * `coder`) that is also folded into `CONFIG_KEYS` and resolved by the CLI
   * shim's flat `models[key]` read, or a DOTTED nested path
   * (`reviewLenses.<lens>`) that is deliberately kept OUT of `CONFIG_KEYS` —
   * `CONFIG_KEYS` feeds `readPhaseModel`'s flat `models[key]` read, which
   * cannot see a nested object — and instead resolved by `resolveModel`'s
   * `resolveFineGrain` helper against the nested `config.reviewLenses`
   * object the CLI shim populates via `readReviewLensModel`.
   */
  fineGrainAbove?: string;
  fallback: Fallback;
};

/**
 * Every rendered site. Order is the render order. `session` is
 * prose-only in `model-routing.md` (not a precedence-table row); the drift
 * lint treats it as table-exempt.
 *
 * No row pins `effort`. The Task tool has no per-spawn effort argument, so a
 * frontmatter (or table) effort pin would be unoverridable even though the
 * same row's `model` is only a configurable default. Effort therefore
 * always follows the session's effort, resolved by the caller on
 * `state.effort > launch.effort config > built-in` and injected as
 * `resolveRouting`'s `effort` argument.
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
  {
    phase: "review",
    stateField: "modelReview",
    configKey: "review",
    fallback: "inherited",
  },
  // One row per review lens plus intent-guess, built off `REVIEW_LENS_NAMES`
  // (models-config.ts) so this table and the warning text can't drift apart.
  // Each inherits the session model, capped: a session model priced above
  // `INHERITANCE_CAP_ALIAS` falls back to opus rather than reaching seven
  // review spawns at once.
  ...REVIEW_LENS_NAMES.map(
    (lens): SpawnSite => ({
      phase: `review-lens:${lens}`,
      stateField: "modelReview",
      configKey: "review",
      fineGrainAbove: `reviewLenses.${lens}`,
      fallback: "session-capped-opus",
    }),
  ),
  // fix-applier falls back to a LITERAL sonnet, not the session model:
  // mechanical apply-commit-push work that must not silently inherit Opus/Fable.
  {
    phase: "fix-applier",
    stateField: "modelFixApplier",
    configKey: "fixApplier",
    fallback: "builtin-sonnet",
  },
  // ui-driver falls back to a LITERAL sonnet like fix-applier: a manifest-driven
  // browser drive is template execution that must not silently inherit Opus/Fable.
  // Config-only (no CLI flag), so no stateField — same shape as scout/coder's
  // fine-grain, which are likewise flagless.
  {
    phase: "ui-driver",
    configKey: "uiDriver",
    fallback: "builtin-sonnet",
  },
  {
    phase: "consolidator",
    stateField: "modelConsolidator",
    configKey: "consolidator",
    fallback: "session-capped-opus",
  },
  {
    phase: "merge-resolver",
    stateField: "modelMergeResolver",
    configKey: "mergeResolver",
    fallback: "inherited",
  },
] as const;

/**
 * Deduped list of every FLAT `config.models.<key>` the sites read. Dotted
 * `fineGrainAbove` paths (`reviewLenses.<lens>`) are deliberately excluded —
 * see the `fineGrainAbove` doc comment above — and resolved by
 * `resolveFineGrain` instead.
 */
export const CONFIG_KEYS: readonly string[] = [
  ...new Set(
    SPAWN_SITES.flatMap((s) =>
      [s.fineGrainAbove, s.configKey].filter(
        (k): k is string => !!k && !k.includes("."),
      ),
    ),
  ),
];

/**
 * Injected, already-validated `config.models` table (key → alias), plus the
 * one nested grain (`reviewLenses.<lens>`) `resolveFineGrain` reads.
 */
export type ConfigModels = Partial<
  Record<string, ModelAlias | Partial<Record<string, ModelAlias>>>
>;

export type ResolvedRow = {
  phase: string;
  /** Resolved alias, or `""` when the site inherits the session model. */
  model: ModelAlias | "";
  source: string;
  effort: string;
  effortSource: string;
};

const FLAG_BY_FIELD = new Map<string, string>([
  ...PHASE_MODEL_FLAGS.map((f) => [f.field, f.flag] as const),
  ["model", "--model"],
]);

function stateSource(field: string): string {
  return `state (${FLAG_BY_FIELD.get(field) ?? `--${field}`})`;
}

function fallbackRow(
  fallback: Fallback,
  state: PipelineState | null | undefined,
): {
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
    case "session-capped-opus": {
      const sessionModel = state?.model as ModelAlias | undefined;
      if (!sessionModel) return { model: "", source: "inherited" };
      if (
        MODEL_PRICE_RANK[sessionModel] > MODEL_PRICE_RANK[INHERITANCE_CAP_ALIAS]
      ) {
        return {
          model: INHERITANCE_CAP_ALIAS,
          source: `capped at ${INHERITANCE_CAP_ALIAS} (session model priced above the cap)`,
        };
      }
      // At or below the cap: a deliberate cheap/mid session is NOT escalated —
      // render the actual inherited value rather than a blank "inherited".
      return { model: sessionModel, source: "inherited (session model)" };
    }
  }
}

/**
 * Pure resolver: walk each site's precedence chain against the injected
 * `state` (a feature `state.json`, or null/undefined for the global view) and
 * `config` (the validated `config.models` table). No I/O — the CLI shim does
 * the tolerant reads and passes the results in.
 *
 * `effort` is likewise injected rather than derived here (keeping this
 * module I/O-free): when the caller supplies `input.effort`, the `session`
 * row carries it verbatim and every other row follows the session
 * (`= session` / `follows session`) — the Task tool exposes no per-spawn
 * effort argument, so no row can pin its own. When `input.effort` is
 * omitted, behaviour is unchanged from before this field existed:
 * `state?.effort ?? "inherited"` on every row.
 */
export function resolveRouting(input: {
  state: PipelineState | null | undefined;
  config: ConfigModels;
  effort?: { value: string; source: string };
}): ResolvedRow[] {
  const { state, config, effort } = input;
  return SPAWN_SITES.map((site) => {
    const resolved = resolveModel(site, state, config);
    if (effort) {
      const isSession = site.phase === "session";
      return {
        phase: site.phase,
        ...resolved,
        effort: isSession ? effort.value : "= session",
        effortSource: isSession ? effort.source : "follows session",
      };
    }
    return {
      phase: site.phase,
      ...resolved,
      effort: state?.effort ?? "inherited",
      effortSource:
        state?.effort !== undefined
          ? "this run (fixed at launch)"
          : "inherited",
    };
  });
}

/**
 * Resolves a `fineGrainAbove` grain against `config`. A flat key (`scout` /
 * `coder`, no dot) reads `config[key]` directly. A dotted key
 * (`reviewLenses.<lens>`) walks one level into the nested object the CLI
 * shim populates via `readReviewLensModel` — see the `fineGrainAbove` doc
 * comment on `SpawnSite` for why this can't go through `CONFIG_KEYS`.
 */
function resolveFineGrain(
  config: ConfigModels,
  key: string,
): ModelAlias | undefined {
  const dot = key.indexOf(".");
  if (dot === -1) {
    const v = config[key];
    return typeof v === "string" ? v : undefined;
  }
  const outer = config[key.slice(0, dot)];
  if (typeof outer !== "object" || outer === null) return undefined;
  const inner = outer[key.slice(dot + 1)];
  return typeof inner === "string" ? inner : undefined;
}

function resolveModel(
  site: SpawnSite,
  state: PipelineState | null | undefined,
  config: ConfigModels,
): { model: ModelAlias | ""; source: string } {
  // fine-grain config (scout/coder, or nested reviewLenses.<lens>) wins
  // above the state override
  if (site.fineGrainAbove) {
    const v = resolveFineGrain(config, site.fineGrainAbove);
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
    if (typeof v === "string")
      return { model: v, source: `config (models.${site.configKey})` };
  }
  return fallbackRow(site.fallback, state);
}
