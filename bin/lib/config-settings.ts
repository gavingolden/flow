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

import type { ReadConfigFile } from "./models-config";
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
import { readOutputLens } from "./output-lens";
import {
  DELEGATE_MODEL_DEFAULTS,
  type DelegateSurface,
} from "./delegate-models";
import {
  DELEGATE_TIMEOUT_DEFAULTS,
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

function readReviewObject(read: ReadConfigFile): Record<string, unknown> {
  const review = getPath(safeRead(read), ["review"]);
  return typeof review === "object" && review !== null
    ? (review as Record<string, unknown>)
    : {};
}

/** `true` unless the config value is strictly boolean `false` — an opt-out gate. */
function strictFalseOptOut(read: ReadConfigFile, key: string): Resolved {
  const v = readResearchObjectOrReview(read, key);
  if (v.value === false) {
    return { value: "false", source: `config (${v.dottedKey})` };
  }
  return { value: "true", source: "built-in (opt-out, defaults on)" };
}

/** `false` unless the config value is strictly boolean `true` — an opt-in gate. */
function strictTrueOptIn(read: ReadConfigFile, key: string): Resolved {
  const v = readResearchObjectOrReview(read, key);
  if (v.value === true) {
    return { value: "true", source: `config (${v.dottedKey})` };
  }
  return { value: "false", source: "built-in (opt-in, defaults off)" };
}

/** Shared dispatch for the `research.*` / `review.*` bare-boolean keys above. */
function readResearchObjectOrReview(
  read: ReadConfigFile,
  key: string,
): { value: unknown; dottedKey: string } {
  const [group, field] = key.split(".");
  const obj =
    group === "research" ? readResearchObject(read) : readReviewObject(read);
  return { value: obj[field], dottedKey: key };
}

function delegateModelRow(surface: DelegateSurface): Descriptor {
  const key = `delegate.models.${surface}`;
  return {
    key,
    meaning: `the agy model variant delegated ${surface} calls use instead of a Claude Task subagent`,
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
      const v = getPath(safeRead(read), ["delegate", "timeouts", surface]);
      if (typeof v === "string" && v.trim()) {
        return { value: v, source: `config (${key})` };
      }
      const builtIn = DELEGATE_TIMEOUT_DEFAULTS[surface];
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
    resolve: (read) => {
      const research = readResearchObject(read);
      if (research.discovery === true) {
        return { value: "true", source: "config (research.discovery)" };
      }
      return { value: "false", source: "built-in (opt-in, defaults off)" };
    },
  },
  {
    key: "research.model",
    meaning:
      "the agy model variant used for the web-grounded research gather pass",
    resolve: (read) => {
      const research = readResearchObject(read);
      if (typeof research.model === "string" && research.model.trim()) {
        return { value: research.model, source: "config (research.model)" };
      }
      const delegateOverride = getPath(safeRead(read), [
        "delegate",
        "models",
        "researchGather",
      ]);
      if (typeof delegateOverride === "string" && delegateOverride.trim()) {
        return {
          value: delegateOverride,
          source: "config (delegate.models.researchGather)",
        };
      }
      const builtIn = DELEGATE_MODEL_DEFAULTS.researchGather ?? "(none)";
      return { value: builtIn, source: `built-in (${builtIn})` };
    },
  },
  {
    key: "research.refuteModel",
    meaning:
      "the agy model variant used for the adversarial research refute pass — a cross-model diversity guard silently substitutes a fallback when this collides with the gather model, so the pipeline never actually runs two passes on the same model",
    resolve: (read) => {
      const research = readResearchObject(read);
      if (
        typeof research.refuteModel === "string" &&
        research.refuteModel.trim()
      ) {
        return {
          value: research.refuteModel,
          source: "config (research.refuteModel)",
        };
      }
      const delegateOverride = getPath(safeRead(read), [
        "delegate",
        "models",
        "researchRefute",
      ]);
      if (typeof delegateOverride === "string" && delegateOverride.trim()) {
        return {
          value: delegateOverride,
          source: "config (delegate.models.researchRefute)",
        };
      }
      const builtIn = DELEGATE_MODEL_DEFAULTS.researchRefute ?? "(none)";
      return { value: builtIn, source: `built-in (${builtIn})` };
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
      "whether a stalled forced-research run falls back to a deeper (slower) research mode",
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
    meaning: "whether a rejected review lens can block the PR from merging",
    resolve: (read) => strictFalseOptOut(read, "review.lensGates"),
  },
  {
    key: "review.deltaScope",
    meaning:
      "whether review scope narrows to only the lines the PR actually changed",
    resolve: (read) => strictFalseOptOut(read, "review.deltaScope"),
  },
  {
    key: "review.product",
    meaning: "whether the product-critique lens runs as part of review",
    resolve: (read) => strictFalseOptOut(read, "review.product"),
  },
  {
    key: "product.judge",
    meaning:
      "whether the code-blind-reader explanation judge critiques the PR body",
    resolve: (read) => {
      const v = getPath(safeRead(read), ["product", "judge"]);
      return v === false
        ? { value: "false", source: "config (product.judge)" }
        : { value: "true", source: "built-in (opt-out, defaults on)" };
    },
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
      const raw = getPath(safeRead(read), ["bots", "copilot"]);
      return {
        value,
        source:
          raw !== undefined
            ? "config (bots.copilot)"
            : "built-in (flow's default glob sets)",
      };
    },
  },
  {
    key: "bots.copilotLogin",
    meaning:
      "the GitHub login flow watches for when it looks for a Copilot review",
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
      const v = readOutputLens(read);
      const raw = getPath(safeRead(read), ["output", "lens"]);
      return {
        value: v,
        source: raw !== undefined ? "config (output.lens)" : "built-in (pm)",
      };
    },
  },
  {
    key: "update.checkFor",
    meaning: "whether flow notifies you about an available update",
    resolve: (read) => {
      const v = getPath(safeRead(read), ["update", "checkFor"]);
      return v === "off"
        ? { value: "off", source: "config (update.checkFor)" }
        : { value: "notify", source: "built-in (notify)" };
    },
  },
  {
    key: "update.autoUpgrade",
    meaning:
      "whether flow upgrades itself automatically when a new version is available",
    resolve: (read) => {
      const v = getPath(safeRead(read), ["update", "autoUpgrade"]);
      return v === true
        ? { value: "true", source: "config (update.autoUpgrade)" }
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
 */
export function buildSettingsRows(read: ReadConfigFile): SettingRow[] {
  let safe: ReadConfigFile = read;
  try {
    read();
  } catch {
    safe = () => undefined;
  }
  return DESCRIPTORS.map((d) => {
    const { value, source } = d.resolve(safe);
    return { setting: d.key, meaning: d.meaning, value, source };
  });
}
