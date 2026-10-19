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
  EFFORT_LEVELS,
  type EffortLevel,
  type ModelAlias,
  type PipelineState,
} from "./state";
import { REVIEW_LENS_NAMES, type ReviewLensName } from "./models-config";
import { EFFORT_CONFIG_KEYS, type ConfigEfforts } from "./efforts-config";

/** Terminal fallback kind when neither a state override nor config resolves. */
export type Fallback =
  | "inherited"
  | "builtin-sonnet"
  | "pinned-haiku"
  | "pinned-opus"
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
  /**
   * The built-in per-spawn effort for this site when `efforts.<key>` is
   * unset. `capAtSession` caps it at the session's effort (a `low` session
   * never gets a higher-effort mechanical sub-agent); without it the level
   * applies regardless of the session. Sites without a default follow the
   * session. Mirrored as the `effort:` floor in the site's agent definition.
   */
  effortDefault?: { level: EffortLevel; capAtSession: boolean };
};

const LENS_FALLBACK: Partial<Record<ReviewLensName, Fallback>> = {
  product: "pinned-opus",
  "bug-detection": "inherited",
};

/**
 * Every rendered site. Order is the render order. `session` is
 * prose-only in `model-routing.md` (not a precedence-table row); the drift
 * lint treats it as table-exempt.
 *
 * Effort resolves per spawn like the model (`resolveSpawnEffort`):
 * `efforts.<key>` config > the site's built-in `effortDefault` > the
 * session's effort. Three rows carry a built-in default: `fix-applier` and
 * `ui-driver` (mechanical work, `medium` capped at the session) and
 * `review-lens:product` (`medium`, uncapped). Every other row follows the
 * session. `flow-spawn-effort` is the spawn-time entry point; it needs
 * Claude Code 2.1.292+ and otherwise the agent files' `effort:` floor applies.
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
  // expensive review spawns at once. Two exceptions. `product` is a literal opus on
  // every session (a Sonnet session is NOT passed through) and a built-in medium
  // effort. `bug-detection` inherits uncapped: the recall check in
  // docs/eval/fable-vs-opus-subagents.md found Fable re-found 8.7% vs 3.9%
  // (p = 0.0065) at $2.50 vs $0.71 a review.
  ...REVIEW_LENS_NAMES.map(
    (lens): SpawnSite => ({
      phase: `review-lens:${lens}`,
      stateField: "modelReview",
      configKey: "review",
      fineGrainAbove: `reviewLenses.${lens}`,
      fallback: LENS_FALLBACK[lens] ?? "session-capped-opus",
      ...(lens === "product"
        ? { effortDefault: { level: "medium" as const, capAtSession: false } }
        : {}),
    }),
  ),
  // fix-applier falls back to a LITERAL sonnet, not the session model:
  // mechanical apply-commit-push work that must not silently inherit Opus/Fable.
  {
    phase: "fix-applier",
    stateField: "modelFixApplier",
    configKey: "fixApplier",
    fallback: "builtin-sonnet",
    effortDefault: { level: "medium", capAtSession: true },
  },
  // ui-driver falls back to a LITERAL sonnet like fix-applier: a manifest-driven
  // browser drive is template execution that must not silently inherit Opus/Fable.
  // Config-only (no CLI flag), so no stateField — same shape as scout/coder's
  // fine-grain, which are likewise flagless.
  {
    phase: "ui-driver",
    configKey: "uiDriver",
    fallback: "builtin-sonnet",
    effortDefault: { level: "medium", capAtSession: true },
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
    case "pinned-opus":
      return { model: "opus", source: "pinned (opus)" };
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

function asEffortLevel(v: unknown): EffortLevel | "" {
  return typeof v === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : "";
}

/**
 * The `efforts.<key>` a site reads: its per-role key (the fine-grain key when
 * it has one — `scout` / `coder` / `reviewLenses.<lens>` — else its config
 * key). The `review` / `implement` group grains and the `session` row's
 * `default` have no effort key, so they return `undefined`.
 */
function effortKeyFor(site: SpawnSite): string | undefined {
  const key = site.fineGrainAbove ?? site.configKey;
  if (!key) return undefined;
  return EFFORT_CONFIG_KEYS.includes(key) || key.startsWith("reviewLenses.")
    ? key
    : undefined;
}

function lookupEffort(
  efforts: ConfigEfforts,
  key: string,
): EffortLevel | undefined {
  const dot = key.indexOf(".");
  if (dot === -1) {
    const v = efforts[key];
    return typeof v === "string" ? v : undefined;
  }
  const outer = efforts[key.slice(0, dot)];
  if (typeof outer !== "object" || outer === null) return undefined;
  return outer[key.slice(dot + 1)];
}

/**
 * Pure per-spawn effort resolver: `efforts.<key>` config (never capped by the
 * session) > the site's built-in `effortDefault` (capped at the session's
 * effort when `capAtSession`; an unknown session `""` keeps the level) > `""`,
 * meaning "omit the argument and follow the session".
 */
export function resolveSpawnEffort(
  site: SpawnSite,
  efforts: ConfigEfforts,
  sessionEffort: EffortLevel | "",
): { effort: EffortLevel | ""; source: string } {
  const key = effortKeyFor(site);
  if (key) {
    const configured = lookupEffort(efforts, key);
    if (configured) {
      return { effort: configured, source: `config (efforts.${key})` };
    }
  }
  const def = site.effortDefault;
  if (def) {
    if (!def.capAtSession) {
      return { effort: def.level, source: `built-in (${site.phase})` };
    }
    const capped =
      sessionEffort &&
      EFFORT_LEVELS.indexOf(sessionEffort) < EFFORT_LEVELS.indexOf(def.level)
        ? sessionEffort
        : def.level;
    return { effort: capped, source: `built-in (${site.phase}, ≤ session)` };
  }
  return { effort: "", source: "follows session" };
}

/**
 * Pure resolver: walk each site's precedence chain against the injected
 * `state` (a feature `state.json`, or null/undefined for the global view) and
 * `config` (the validated `config.models` table). No I/O — the CLI shim does
 * the tolerant reads and passes the results in.
 *
 * Effort is resolved per spawn through `resolveSpawnEffort` against the
 * injected `efforts` (the validated `config.efforts` table). `input.effort`
 * carries the session's effort: the `session` row reports it verbatim and a
 * row with nothing to say follows it (`= session` / `follows session`). When
 * `input.effort` is omitted, a row with nothing to say reports
 * `state?.effort ?? "inherited"`. `envEffort` (`CLAUDE_CODE_EFFORT_LEVEL`)
 * overrides every sub-agent — and the session — so when set every row reports
 * it. All effort inputs are optional: model-only callers
 * (`flow-review-model`, `flow-agy-lenses`) pass none.
 */
export function resolveRouting(input: {
  state: PipelineState | null | undefined;
  config: ConfigModels;
  effort?: { value: string; source: string };
  efforts?: ConfigEfforts;
  envEffort?: string;
}): ResolvedRow[] {
  const { state, config, effort, efforts = {}, envEffort } = input;
  // The session-effort display value `(none)` means "no --effort passed".
  const sessionEffort = asEffortLevel(effort ? effort.value : state?.effort);
  return SPAWN_SITES.map((site) => {
    const resolved = resolveModel(site, state, config);
    if (envEffort) {
      return {
        phase: site.phase,
        ...resolved,
        effort: envEffort,
        effortSource: "env (CLAUDE_CODE_EFFORT_LEVEL)",
      };
    }
    const isSession = site.phase === "session";
    if (isSession && effort) {
      return {
        phase: site.phase,
        ...resolved,
        effort: effort.value,
        effortSource: effort.source,
      };
    }
    const spawn = isSession
      ? { effort: "" as const, source: "follows session" }
      : resolveSpawnEffort(site, efforts, sessionEffort);
    if (spawn.effort) {
      return {
        phase: site.phase,
        ...resolved,
        effort: spawn.effort,
        effortSource: spawn.source,
      };
    }
    if (effort) {
      return {
        phase: site.phase,
        ...resolved,
        effort: "= session",
        effortSource: "follows session",
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
