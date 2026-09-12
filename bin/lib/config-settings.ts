/**
 * `flow config all`'s third section — every `~/.flow/config.json` key that
 * has a live reader somewhere in flow but no existing `flow config <verb>`
 * subcommand covers it. Read-only audit surface, structural sibling of
 * `config-models.ts` / `config-launch.ts`: each row resolves through the
 * SAME boundary reader its real consumer uses (never a re-implementation),
 * so this view can never describe a resolution the pipeline doesn't
 * actually run.
 *
 * Deliberately does NOT import `resolveDelegateModel` / `resolveDelegateTimeout`
 * (both warn to stderr on ANY override and dedup via a module-level `Set`
 * that never resets, making a read-only audit noisy and test-order-dependent)
 * or `isGeminiLensEnabled` (takes `rawConfigText: string`, not the
 * `ReadConfigFile` seam every other reader here uses). Both gates are
 * reimplemented locally against the shared `read()` instead.
 */

import { cachedConfigRead, type ReadConfigFile } from "./models-config";
import { readModuleSelection } from "./modules-config";
import {
  readCopilotAutoReview,
  readCopilotClaimDeadlineSec,
  readCopilotConfig,
  readCopilotLogin,
  readCopilotSkipWait,
  DEFAULT_COPILOT_LOGIN,
} from "./copilot-config";
import { readEpicMaxParallel, DEFAULT_MAX_PARALLEL } from "./epic-config";
import { isOutputLens } from "./output-lens";
import {
  DELEGATE_MODEL_DEFAULTS,
  type DelegateSurface,
} from "./delegate-models";
import {
  DELEGATE_TIMEOUT_DEFAULTS,
  SYNC_DELEGATE_CEILING,
  isGoDuration,
  godurToSec,
  type DelegateTimeoutSurface,
} from "./delegate-timeouts";

export type SettingRow = {
  setting: string;
  meaning: string;
  value: string;
  source: string;
};

type Resolved = { value: string; source: string };

type Descriptor = {
  key: string;
  meaning: string;
  resolve: (read: ReadConfigFile) => Resolved;
};

/** Walks a dotted path against the raw parsed config; `undefined` on any miss. */
function getPath(raw: unknown, path: readonly string[]): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function safeRead(read: ReadConfigFile): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function readResearchObject(read: ReadConfigFile): Record<string, unknown> {
  const research = getPath(safeRead(read), ["research"]);
  return typeof research === "object" && research !== null
    ? (research as Record<string, unknown>)
    : {};
}

/** Walks any dotted config path — the generic replacement for the old
 * `research`-vs-`review` two-group dispatch, which couldn't reach a key
 * outside those two groups (`product.judge`) without either hand-rolling
 * the same logic again or silently reading the wrong group. */
function readGateValue(read: ReadConfigFile, key: string): unknown {
  return getPath(safeRead(read), key.split("."));
}

/**
 * `true` unless the config value is strictly boolean `false` — an opt-out
 * gate. Source attribution is presence-AND-validity, not value-vs-default:
 * an explicit `{ key: true }` (equal to the default) must still read as
 * `config`, and a wrong-typed entry the resolved VALUE ignores must read as
 * `built-in` — the same truthfulness defect this PR exists to fix.
 */
function strictFalseOptOut(read: ReadConfigFile, key: string): Resolved {
  const v = readGateValue(read, key);
  return {
    value: v === false ? "false" : "true",
    source:
      typeof v === "boolean"
        ? `config (${key})`
        : "built-in (opt-out, defaults on)",
  };
}

/** `false` unless the config value is strictly boolean `true` — an opt-in
 * gate. Same presence-AND-validity attribution as `strictFalseOptOut`. */
function strictTrueOptIn(read: ReadConfigFile, key: string): Resolved {
  const v = readGateValue(read, key);
  return {
    value: v === true ? "true" : "false",
    source:
      typeof v === "boolean"
        ? `config (${key})`
        : "built-in (opt-in, defaults off)",
  };
}

/** Mirrors bin/flow-research-run.ts's private `FALLBACK_REFUTE_MODEL` —
 * duplicated, not imported, because bin/lib/* must never import back from a
 * top-level bin/*.ts helper (see delegate-timeouts.ts's docstring). Keep in
 * sync with that module's constant. */
const FALLBACK_REFUTE_MODEL_MIRROR = "GPT-OSS 120B (Medium)";

/** Shared resolver for `research.model` / `research.refuteModel`: direct
 * `research.<field>` config wins, then a `delegate.models.<surface>`
 * override, then the built-in default. */
function resolveResearchModelField(
  read: ReadConfigFile,
  field: "model" | "refuteModel",
  delegateSurface: "researchGather" | "researchRefute",
): Resolved {
  const research = readResearchObject(read);
  const direct = research[field];
  if (typeof direct === "string" && direct.trim()) {
    return { value: direct, source: `config (research.${field})` };
  }
  const delegateOverride = getPath(safeRead(read), [
    "delegate",
    "models",
    delegateSurface,
  ]);
  if (typeof delegateOverride === "string" && delegateOverride.trim()) {
    return {
      value: delegateOverride,
      source: `config (delegate.models.${delegateSurface})`,
    };
  }
  const builtIn = DELEGATE_MODEL_DEFAULTS[delegateSurface] ?? "(none)";
  return { value: builtIn, source: `built-in (${builtIn})` };
}

/**
 * Plain-language name for each delegate surface — never the raw camelCase
 * identifier, which a reader can't parse without opening the code.
 * `scout` is the only surface that actually replaces a Claude Task
 * subagent (and is unwired today — see `docs/configuration.md`'s
 * `delegate.models.scout` row); the rest are either an additional
 * opt-in lens or a delegate-only path that skips (no Task spawn) when
 * agy is unavailable, so their meaning must not claim a substitution.
 */
const DELEGATE_MODEL_SURFACE_NAMES: Record<DelegateSurface, string> = {
  intentGuess: "the cross-model intent guess",
  reviewLens: "the Gemini review lens",
  researchGather: "the research gather pass",
  researchRefute: "the research refute pass",
  planReview: "the first plan reviewer",
  planReviewSecond: "the second plan reviewer",
  blindSurvey: "the first blind-method-survey judge",
  blindSurveySecond: "the second blind-method-survey judge",
  scout: "the implementation scout",
};

function delegateModelRow(surface: DelegateSurface): Descriptor {
  const key = `delegate.models.${surface}`;
  const name = DELEGATE_MODEL_SURFACE_NAMES[surface];
  const meaning =
    surface === "scout"
      ? `the agy model variant ${name} uses instead of a Claude Task subagent (reserved — not yet wired)`
      : `the agy model variant ${name} uses`;
  return {
    key,
    meaning,
    resolve: (read) => {
      const v = getPath(safeRead(read), ["delegate", "models", surface]);
      if (typeof v === "string" && v.trim()) {
        return { value: v, source: `config (${key})` };
      }
      const builtIn = DELEGATE_MODEL_DEFAULTS[surface];
      return {
        value: builtIn ?? "(none)",
        source: `built-in (${builtIn ?? "none"})`,
      };
    },
  };
}

function delegateTimeoutRow(surface: DelegateTimeoutSurface): Descriptor {
  const key = `delegate.timeouts.${surface}`;
  return {
    key,
    meaning: `how long a delegated ${surface} agy call may run before flow gives up on it`,
    resolve: (read) => {
      const builtIn = DELEGATE_TIMEOUT_DEFAULTS[surface];
      const v = getPath(safeRead(read), ["delegate", "timeouts", surface]);
      if (typeof v === "string" && isGoDuration(v)) {
        const trimmed = v.trim();
        return godurToSec(trimmed) > godurToSec(SYNC_DELEGATE_CEILING)
          ? {
              value: SYNC_DELEGATE_CEILING,
              source: `config (${key}, clamped from ${trimmed})`,
            }
          : { value: trimmed, source: `config (${key})` };
      }
      return { value: builtIn, source: `built-in (${builtIn})` };
    },
  };
}

const DELEGATE_MODEL_SURFACES = Object.keys(
  DELEGATE_MODEL_DEFAULTS,
) as DelegateSurface[];
const DELEGATE_TIMEOUT_SURFACES = Object.keys(
  DELEGATE_TIMEOUT_DEFAULTS,
) as DelegateTimeoutSurface[];

const DESCRIPTORS: Descriptor[] = [
  {
    key: "research.discovery",
    meaning:
      "whether the discovery interview additionally runs a web-grounded research pre-check",
    resolve: (read) => strictTrueOptIn(read, "research.discovery"),
  },
  {
    key: "research.model",
    meaning:
      "the agy model variant used for the web-grounded research gather pass",
    resolve: (read) =>
      resolveResearchModelField(read, "model", "researchGather"),
  },
  {
    key: "research.refuteModel",
    meaning:
      "the agy model variant used for the adversarial research refute pass — a cross-model diversity guard silently substitutes a fallback when this collides with the gather model, so the pipeline never actually runs two passes on the same model",
    resolve: (read) => {
      const gather = resolveResearchModelField(read, "model", "researchGather");
      const refute = resolveResearchModelField(
        read,
        "refuteModel",
        "researchRefute",
      );
      if (refute.value !== gather.value) return refute;
      // Mirrors `resolveModels`'s diversity guard in bin/flow-research-run.ts
      // (duplicated rather than imported: bin/lib/* must never import back
      // from a top-level bin/*.ts helper — see delegate-timeouts.ts's
      // docstring). Keep `FALLBACK_REFUTE_MODEL_MIRROR` in sync with that
      // module's private `FALLBACK_REFUTE_MODEL` constant.
      const defaultRefuteModel =
        DELEGATE_MODEL_DEFAULTS.researchRefute ?? "(none)";
      const substituted =
        gather.value === defaultRefuteModel
          ? FALLBACK_REFUTE_MODEL_MIRROR
          : defaultRefuteModel;
      return {
        value: substituted,
        source: `built-in (diversity guard; ${refute.value} collides with gather)`,
      };
    },
  },
  {
    key: "research.maxCalls",
    meaning:
      "the maximum number of agy calls the forced-research runner may spend",
    resolve: (read) => {
      const research = readResearchObject(read);
      const v = research.maxCalls;
      if (typeof v === "number" && Number.isInteger(v) && v > 0) {
        return { value: String(v), source: "config (research.maxCalls)" };
      }
      return { value: "12", source: "built-in (12)" };
    },
  },
  {
    key: "research.timeout",
    meaning:
      "how long the forced-research runner waits for the gather/refute fan-out",
    resolve: (read) => {
      const research = readResearchObject(read);
      const v = research.timeout;
      if (typeof v === "string" && v.trim()) {
        return { value: v, source: "config (research.timeout)" };
      }
      return { value: "3m", source: 'built-in ("3m")' };
    },
  },
  {
    key: "research.deepResearchFallback",
    meaning:
      "whether a stalled research run retries on paid Claude credits instead of the cheaper delegated path (slower, and spends credits)",
    resolve: (read) => strictFalseOptOut(read, "research.deepResearchFallback"),
  },
  {
    key: "review.gemini",
    meaning:
      "whether the review pipeline additionally runs the Gemini-delegated lens",
    resolve: (read) => strictTrueOptIn(read, "review.gemini"),
  },
  {
    key: "review.lensGates",
    meaning:
      "whether review skips the lenses with nothing to look at in this change (off = every lens always runs)",
    resolve: (read) => strictFalseOptOut(read, "review.lensGates"),
  },
  {
    key: "review.deltaScope",
    meaning:
      "whether a re-review after a fix only looks at what changed since the last clean review (off = every re-review reads the whole PR)",
    resolve: (read) => strictFalseOptOut(read, "review.deltaScope"),
  },
  {
    key: "review.product",
    meaning:
      "whether the product critique runs — on the plan before work starts, and on the PR at review",
    resolve: (read) => strictFalseOptOut(read, "review.product"),
  },
  {
    key: "product.judge",
    meaning:
      "whether the code-blind-reader explanation judge critiques the PR body",
    resolve: (read) => strictFalseOptOut(read, "product.judge"),
  },
  {
    key: "modules",
    meaning: "which optional flow modules this install has selected",
    resolve: (read) => {
      const selection = readModuleSelection(read);
      if (selection === undefined) {
        return { value: "(none)", source: "built-in (no modules selected)" };
      }
      return {
        value: selection.length ? selection.join(", ") : "(none selected)",
        source: "config (modules)",
      };
    },
  },
  {
    key: "bots.copilot",
    meaning:
      "extra path globs that always (or never alone) warrant a Copilot review",
    resolve: (read) => {
      const cfg = readCopilotConfig(read);
      const value = `alwaysReview=${cfg.globs.alwaysReview.length}, neverAlone=${cfg.globs.neverAlone.length}`;
      // Attribute on presence of a usable `globs` object — a bare login
      // string or a wrong-typed `bots.copilot` contributes no globs at all
      // (`extractBotsCopilot`/`readCopilotConfig` fall through to the
      // built-in glob sets), so `raw !== undefined` alone over-attributes.
      const raw = getPath(safeRead(read), ["bots", "copilot"]);
      const globs =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).globs
          : undefined;
      const configured =
        typeof globs === "object" && globs !== null && !Array.isArray(globs);
      return {
        value,
        source: configured
          ? "config (bots.copilot.globs)"
          : "built-in (flow's default glob sets)",
      };
    },
  },
  {
    // A derived view, not a settable key of its own — `bots.copilot` is
    // either a bare login string or an object; this row renders whichever
    // login it resolves to. Named with a real dotted path (rather than the
    // synthetic `bots.copilotLogin`) so the SETTING column never shows a
    // key a user could paste into config.json and have it do nothing.
    key: "bots.copilot.login",
    meaning:
      "the GitHub account whose review flow waits for when it looks for a Copilot review (set via bots.copilot, not a separate key)",
    resolve: (read) => {
      const login = readCopilotLogin(read);
      // Presence, not value-vs-default: a user who configures the default
      // login explicitly must still read as `config`. `bots.copilot` is
      // either a bare login string or an object carrying `.login`.
      const raw = getPath(safeRead(read), ["bots", "copilot"]);
      const configured =
        typeof raw === "string"
          ? "config (bots.copilot)"
          : typeof (raw as { login?: unknown } | undefined)?.login === "string"
            ? "config (bots.copilot.login)"
            : null;
      return {
        value: login,
        source: configured ?? `built-in (${DEFAULT_COPILOT_LOGIN})`,
      };
    },
  },
  {
    key: "bots.copilotAutoReview",
    meaning:
      "whether flow waits on an automatic Copilot review without requesting one",
    resolve: (read) => {
      const v = readCopilotAutoReview(read);
      return v === undefined
        ? { value: "(auto-detect)", source: "built-in (auto-detect from repo)" }
        : { value: String(v), source: "config (bots.copilotAutoReview)" };
    },
  },
  {
    key: "bots.copilotClaimDeadlineSec",
    meaning:
      "how long flow waits for Copilot to claim a requested review before giving up",
    resolve: (read) => {
      const v = readCopilotClaimDeadlineSec(read);
      return v === undefined
        ? { value: "(none)", source: "built-in (no global override)" }
        : { value: String(v), source: "config (bots.copilotClaimDeadlineSec)" };
    },
  },
  {
    key: "bots.copilotSkipWait",
    meaning: "whether flow skips requesting/waiting on Copilot review entirely",
    resolve: (read) => {
      const v = readCopilotSkipWait(read);
      // Presence AND type: an explicit `false` is a config value, while a
      // wrong-typed entry is ignored by the reader, so it honestly reads as
      // built-in — the value flow actually uses.
      const raw = getPath(safeRead(read), ["bots", "copilotSkipWait"]);
      return {
        value: String(v),
        source:
          typeof raw === "boolean"
            ? "config (bots.copilotSkipWait)"
            : "built-in (false)",
      };
    },
  },
  {
    key: "epic.maxParallel",
    meaning: "how many epic pipelines may run concurrently",
    resolve: (read) => {
      const v = readEpicMaxParallel(read);
      // Presence AND validity, not value-vs-default: configuring the default
      // explicitly must read as `config`, while a non-positive-integer entry
      // the reader rejects must read as `built-in`.
      const raw = getPath(safeRead(read), ["epic", "maxParallel"]);
      const configured =
        typeof raw === "number" && Number.isInteger(raw) && raw > 0;
      return {
        value: String(v),
        source: configured
          ? "config (epic.maxParallel)"
          : `built-in (${DEFAULT_MAX_PARALLEL})`,
      };
    },
  },
  {
    key: "output.lens",
    meaning: "how verbose flow's PM-facing status output is (pm vs dev)",
    resolve: (read) => {
      const raw = getPath(safeRead(read), ["output", "lens"]);
      // Validate with the reader's own predicate rather than calling
      // `readOutputLens` (which warns `OUTPUT_LENS_INVALID_NOTICE` to
      // stderr on an invalid value) — a read-only audit must not print
      // stderr warnings just for rendering a row.
      return {
        value: isOutputLens(raw) ? raw : "pm",
        source: isOutputLens(raw) ? "config (output.lens)" : "built-in (pm)",
      };
    },
  },
  {
    key: "update.checkFor",
    meaning: "whether flow notifies you about an available update",
    resolve: (read) => {
      // `checkForUpdate` (bin/lib/update-check.ts) checks
      // `env.FLOW_UPDATE_CHECK === "off"` BEFORE it looks at
      // `update.checkFor` — an audit surface that ignores that precedence
      // would state a value flow never actually resolved.
      if (process.env.FLOW_UPDATE_CHECK === "off") {
        return { value: "off", source: "env (FLOW_UPDATE_CHECK=off)" };
      }
      const v = getPath(safeRead(read), ["update", "checkFor"]);
      if (v === "off")
        return { value: "off", source: "config (update.checkFor)" };
      if (v === "notify") {
        return { value: "notify", source: "config (update.checkFor)" };
      }
      return { value: "notify", source: "built-in (notify)" };
    },
  },
  {
    key: "update.autoUpgrade",
    meaning:
      "whether flow upgrades itself automatically when a new version is available",
    resolve: (read) => {
      // Presence-AND-validity: an explicit `false` (equal to the default)
      // must still read as `config`; a wrong-typed entry the real consumer
      // (`extractUpdateConfig`) ignores must read as `built-in`.
      const v = getPath(safeRead(read), ["update", "autoUpgrade"]);
      return typeof v === "boolean"
        ? { value: String(v), source: "config (update.autoUpgrade)" }
        : { value: "false", source: "built-in (false)" };
    },
  },
  ...DELEGATE_MODEL_SURFACES.map(delegateModelRow),
  ...DELEGATE_TIMEOUT_SURFACES.map(delegateTimeoutRow),
  {
    key: "source",
    meaning: "the flow checkout this install's helpers were symlinked from",
    resolve: (read) => {
      const v = getPath(safeRead(read), ["source"]);
      return typeof v === "string" && v.trim()
        ? { value: v, source: "config (source)" }
        : { value: "(none)", source: "built-in (no recorded source)" };
    },
  },
];

/**
 * The key list `config-key-coverage.test.ts` pins against `docs/configuration.md`.
 * Falls out of `DESCRIPTORS` rather than being a second hand-maintained
 * list — but the 11 individual `delegate.models.<surface>` /
 * `delegate.timeouts.<surface>` descriptor keys (kept individual so an
 * override is actually visible in the RENDERED rows, see `delegateModelRow`)
 * collapse to the two existing `delegate.models.*` / `delegate.timeouts.*`
 * glob rows the docs table already carries.
 */
export const SETTINGS_KEYS: readonly string[] = [
  ...new Set(
    DESCRIPTORS.map((d) => {
      if (d.key.startsWith("delegate.models.")) return "delegate.models.*";
      if (d.key.startsWith("delegate.timeouts.")) return "delegate.timeouts.*";
      return d.key;
    }),
  ),
];

/**
 * Builds every settings row. Owns the ONE `try { read() } catch` boundary
 * for this whole section — most readers reused here (all but
 * `readLaunchDefaults`, which this module never calls) call `read()`
 * unguarded, so an absent/unreadable config must degrade to a
 * `() => undefined` reader here rather than let the throw propagate. Never
 * throws; an absent/malformed config renders the full built-ins-only table.
 *
 * Self-wraps `read` in `cachedConfigRead` before that boundary check: the
 * descriptors below call `read` ~40 times on a single invocation (several
 * twice each), so an un-cached reader would mean ~40 `readFileSync` +
 * `JSON.parse` round trips. The one production caller
 * (`config-all.ts`) already passes a shared cached closure — this wrap is a
 * no-op there (double-wrapping a cached reader is harmless) and only
 * matters for a future direct caller that doesn't.
 */
export function buildSettingsRows(read: ReadConfigFile): SettingRow[] {
  let safe: ReadConfigFile = cachedConfigRead(read);
  try {
    safe();
  } catch {
    safe = () => undefined;
  }
  return DESCRIPTORS.map((d) => {
    const { value, source } = d.resolve(safe);
    return { setting: d.key, meaning: d.meaning, value, source };
  });
}
