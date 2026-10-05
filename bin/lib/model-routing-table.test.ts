import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  resolveRouting,
  SPAWN_SITES,
  type ConfigModels,
  type SpawnSite,
} from "./model-routing-table";
import { fileURLToPath } from "node:url";
import { REVIEW_LENS_NAMES } from "./models-config";
import type { PipelineState } from "./state";

// Module-relative, not resolveFlowSource(): that prefers ~/.flow/config.json's
// `source`, which can point at a different checkout than the one under test.
const FLOW_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Minimal state fixture — resolveRouting only reads model/model<Phase>/effort.
const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "x",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

const PINNED_PHASE = "review-lens:product";
const PINNED_SOURCE = "pinned (agents/core/flow-review-product.md)";

const row = (rows: ReturnType<typeof resolveRouting>, phase: string) => {
  const r = rows.find((x) => x.phase === phase);
  if (!r) throw new Error(`no row for phase ${phase}`);
  return r;
};

describe("resolveRouting — fallback branches (empty config + state)", () => {
  const rows = resolveRouting({ state: null, config: {} });

  it("fix-applier falls back to the literal sonnet, not inherited", () => {
    expect(row(rows, "fix-applier")).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
      effort: "inherited",
    });
  });

  it("fix-applier follows the session when an effort is injected", () => {
    const injected = resolveRouting({
      state: null,
      config: {},
      effort: { value: "high", source: "config (launch.effort)" },
    });
    expect(row(injected, "fix-applier")).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
      effort: "= session",
      effortSource: "follows session",
    });
  });

  it("inherited sites resolve to an empty model with an `inherited` source", () => {
    for (const phase of [
      "session",
      "planning",
      "review",
      "consolidator",
      "merge-resolver",
    ]) {
      expect(row(rows, phase)).toMatchObject({
        model: "",
        source: "inherited",
      });
    }
  });

  it("only the product lens pins effort; every other row inherits when state is absent and no effort is injected", () => {
    for (const r of rows) {
      if (r.phase === PINNED_PHASE) continue;
      expect(r.effort).toBe("inherited");
    }
    expect(row(rows, PINNED_PHASE)).toMatchObject({
      effort: "medium",
      effortSource: PINNED_SOURCE,
    });
  });

  it("every non-session row follows the session's injected effort; the session row carries it verbatim", () => {
    const injected = resolveRouting({
      state: null,
      config: {},
      effort: { value: "high", source: "config (launch.effort)" },
    });
    expect(row(injected, "session")).toMatchObject({
      effort: "high",
      effortSource: "config (launch.effort)",
    });
    for (const r of injected) {
      if (r.phase === "session" || r.phase === PINNED_PHASE) continue;
      expect(r.effort).toBe("= session");
      expect(r.effortSource).toBe("follows session");
    }
    expect(row(injected, PINNED_PHASE)).toMatchObject({
      effort: "medium",
      effortSource: PINNED_SOURCE,
    });
  });
});

describe("pinned-effort invariant", () => {
  it("only review-lens:product declares an effortPin, and it equals the agent definition's `effort:` line", () => {
    const pinned = SPAWN_SITES.filter((site) =>
      Object.prototype.hasOwnProperty.call(site, "effortPin"),
    );
    expect(
      pinned.map((site) => site.phase),
      "a pinned effort is unoverridable (the Task tool has no per-spawn " +
        "effort argument); the product lens is the one named exception — " +
        "every other row's effort must follow the session's state.effort.",
    ).toEqual([PINNED_PHASE]);
    const agent = fs.readFileSync(
      path.join(FLOW_ROOT, "agents/core/flow-review-product.md"),
      "utf8",
    );
    const frontmatter = agent.split(/^---$/m)[1] ?? "";
    expect(frontmatter.match(/^effort:\s*(\S+)\s*$/m)?.[1]).toBe(
      pinned[0]!.effortPin,
    );
  });
});

describe("resolveRouting — state per-phase overrides", () => {
  it("a --model-planning override yields source `state (--model-planning)`", () => {
    const rows = resolveRouting({
      state: st({ modelPlanning: "fable" }),
      config: {},
    });
    expect(row(rows, "planning")).toMatchObject({
      model: "fable",
      source: "state (--model-planning)",
    });
  });

  it("the session model resolves from state.model via --model", () => {
    const rows = resolveRouting({ state: st({ model: "opus" }), config: {} });
    expect(row(rows, "session")).toMatchObject({
      model: "opus",
      source: "state (--model)",
    });
  });

  it("with no injected effort, state.effort is rendered on every unpinned row, including the two cheap-model fan-outs", () => {
    const rows = resolveRouting({ state: st({ effort: "high" }), config: {} });
    expect(row(rows, "review").effort).toBe("high");
    expect(row(rows, "fix-applier").effort).toBe("high");
    expect(row(rows, "ui-driver").effort).toBe("high");
    expect(row(rows, PINNED_PHASE).effort).toBe("medium");
  });

  it("with no injected effort, `effortSource` names a source phrase, never the bare effort value", () => {
    // Regression case: the fallback branch used to set
    // `effortSource: state?.effort ?? "inherited"`, so a `state.effort` of
    // "high" leaked the VALUE into a SOURCE-position field.
    const withState = resolveRouting({
      state: st({ effort: "high" }),
      config: {},
    });
    for (const r of withState) {
      if (r.phase === PINNED_PHASE) continue;
      expect(r.effort).toBe("high");
      expect(r.effortSource).toBe("this run (fixed at launch)");
    }

    const withoutState = resolveRouting({ state: null, config: {} });
    for (const r of withoutState) {
      if (r.phase === PINNED_PHASE) continue;
      expect(r.effort).toBe("inherited");
      expect(r.effortSource).toBe("inherited");
    }
  });

  it("with an injected effort, review/fix-applier/ui-driver follow the session rather than rendering the value directly", () => {
    const rows = resolveRouting({
      state: st({ effort: "high" }),
      config: {},
      effort: { value: "high", source: "this run (fixed at launch)" },
    });
    expect(row(rows, "review").effort).toBe("= session");
    expect(row(rows, "fix-applier").effort).toBe("= session");
    expect(row(rows, "ui-driver").effort).toBe("= session");
    expect(row(rows, "session").effort).toBe("high");
  });
});

describe("resolveRouting — product lens pin", () => {
  it("is a literal opus on every session model, with a pinned source", () => {
    for (const model of ["fable", "sonnet", "opus"] as const) {
      const rows = resolveRouting({ state: st({ model }), config: {} });
      expect(row(rows, PINNED_PHASE)).toMatchObject({
        model: "opus",
        source: "pinned (opus)",
      });
    }
  });

  it("an explicit reviewLenses.product / state.modelReview / models.review still win", () => {
    const viaLens = resolveRouting({
      state: st({ modelReview: "opus" }),
      config: { reviewLenses: { product: "sonnet" } },
    });
    expect(row(viaLens, PINNED_PHASE)).toMatchObject({
      model: "sonnet",
      source: "config (models.reviewLenses.product)",
    });
    const viaState = resolveRouting({
      state: st({ modelReview: "haiku" }),
      config: { review: "sonnet" },
    });
    expect(row(viaState, PINNED_PHASE).model).toBe("haiku");
    const viaConfig = resolveRouting({
      state: null,
      config: { review: "haiku" },
    });
    expect(row(viaConfig, PINNED_PHASE).model).toBe("haiku");
  });

  it("the pinned effort is reported whether or not session effort is injected", () => {
    const injected = resolveRouting({
      state: null,
      config: {},
      effort: { value: "max", source: "config (launch.effort)" },
    });
    expect(row(injected, PINNED_PHASE)).toMatchObject({
      effort: "medium",
      effortSource: PINNED_SOURCE,
    });
  });
});

describe("resolveRouting — config values", () => {
  it("config.models.review yields source `config (models.review)`", () => {
    const rows = resolveRouting({ state: null, config: { review: "opus" } });
    expect(row(rows, "review")).toMatchObject({
      model: "opus",
      source: "config (models.review)",
    });
  });

  it("ui-driver has no CLI flag: config.models.uiDriver resolves, and a session state.model never leaks in", () => {
    const defaults = resolveRouting({ state: null, config: {} });
    expect(row(defaults, "ui-driver")).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
      effort: "inherited",
    });

    const configured = resolveRouting({
      state: null,
      config: { uiDriver: "haiku" },
    });
    expect(row(configured, "ui-driver")).toMatchObject({
      model: "haiku",
      source: "config (models.uiDriver)",
    });

    // Config-only, no stateField: an inherited session model must never leak
    // into this row even when one is set.
    const withSessionModel = resolveRouting({
      state: st({ model: "opus" }),
      config: {},
    });
    expect(row(withSessionModel, "ui-driver")).toMatchObject({
      model: "sonnet",
      source: "built-in (sonnet)",
    });
  });

  it("scout/coder config fine-grain wins ABOVE state.modelImplement", () => {
    const config: ConfigModels = {
      scout: "fable",
      coder: "opus",
      implement: "haiku",
    };
    const rows = resolveRouting({
      state: st({ modelImplement: "sonnet" }),
      config,
    });
    expect(row(rows, "scout")).toMatchObject({
      model: "fable",
      source: "config (models.scout)",
    });
    expect(row(rows, "coder")).toMatchObject({
      model: "opus",
      source: "config (models.coder)",
    });
  });

  it("without the fine-grain, scout falls through to state.modelImplement then config.models.implement", () => {
    const viaState = resolveRouting({
      state: st({ modelImplement: "sonnet" }),
      config: {},
    });
    expect(row(viaState, "scout")).toMatchObject({
      model: "sonnet",
      source: "state (--model-implement)",
    });
    const viaConfig = resolveRouting({
      state: null,
      config: { implement: "haiku" },
    });
    expect(row(viaConfig, "scout")).toMatchObject({
      model: "haiku",
      source: "config (models.implement)",
    });
  });
});

describe("resolveRouting — review-lens capped inheritance", () => {
  const LENS_PHASE = "review-lens:security";

  it("a fable session model caps a review lens to opus, and the source names the cap", () => {
    const rows = resolveRouting({ state: st({ model: "fable" }), config: {} });
    expect(row(rows, LENS_PHASE)).toMatchObject({ model: "opus" });
    expect(row(rows, LENS_PHASE).source).toMatch(/capped/i);
    expect(row(rows, LENS_PHASE).source).toMatch(/opus/);
  });

  it("a sonnet session model resolves a review lens to sonnet — not escalated to opus", () => {
    const rows = resolveRouting({
      state: st({ model: "sonnet" }),
      config: {},
    });
    expect(row(rows, LENS_PHASE)).toMatchObject({ model: "sonnet" });
  });

  it("an explicit config.models.reviewLenses.<lens> beats state.modelReview", () => {
    const config: ConfigModels = {
      reviewLenses: { security: "haiku" },
    };
    const rows = resolveRouting({
      state: st({ model: "fable", modelReview: "opus" }),
      config,
    });
    expect(row(rows, LENS_PHASE)).toMatchObject({
      model: "haiku",
      source: "config (models.reviewLenses.security)",
    });
  });

  it("state.modelReview beats config.models.review", () => {
    const rows = resolveRouting({
      state: st({ modelReview: "sonnet" }),
      config: { review: "opus" },
    });
    expect(row(rows, LENS_PHASE)).toMatchObject({
      model: "sonnet",
      source: "state (--model-review)",
    });
  });

  it("the consolidator row is capped too", () => {
    const rows = resolveRouting({ state: st({ model: "fable" }), config: {} });
    expect(row(rows, "consolidator")).toMatchObject({ model: "opus" });
    expect(row(rows, "consolidator").source).toMatch(/capped/i);
  });
});

describe("resolveRouting — bug-detection uncapped inheritance", () => {
  const PHASE = "review-lens:bug-detection";

  it("a fable session passes through uncapped", () => {
    const rows = resolveRouting({ state: st({ model: "fable" }), config: {} });
    expect(row(rows, PHASE)).toMatchObject({ model: "", source: "inherited" });
  });

  it.each(["sonnet", "opus"] as const)(
    "a %s session inherits the session model",
    (model) => {
      const rows = resolveRouting({ state: st({ model }), config: {} });
      expect(row(rows, PHASE)).toMatchObject({
        model: "",
        source: "inherited",
      });
    },
  );

  it("config.models.reviewLenses.bug-detection opts back to opus on a fable session", () => {
    const rows = resolveRouting({
      state: st({ model: "fable" }),
      config: { reviewLenses: { "bug-detection": "opus" } },
    });
    expect(row(rows, PHASE)).toMatchObject({
      model: "opus",
      source: "config (models.reviewLenses.bug-detection)",
    });
  });

  it("every other non-product lens is still capped to opus on a fable session", () => {
    const rows = resolveRouting({ state: st({ model: "fable" }), config: {} });
    for (const lens of REVIEW_LENS_NAMES) {
      if (lens === "bug-detection" || lens === "product") continue;
      expect(row(rows, `review-lens:${lens}`)).toMatchObject({
        model: "opus",
      });
    }
  });
});

// ── Drift lint (Story 5) ────────────────────────────────────────────────
// Parse the precedence table out of model-routing.md and assert every
// phase-keyed table row maps onto a SPAWN_SITES entry with matching config
// keys + fallback (+ state field, where the row has a feature-state field).
// session is prose-only (table-exempt).

type ParsedRow = {
  spawnSite: string;
  stateField: string;
  configKeys: string[];
  fallback: string;
};

function parsePrecedenceTable(md: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/spawn site/i.test(cells[0])) continue; // header
    if (/^-+$/.test(cells[1].replace(/\s/g, ""))) continue; // separator
    const stateField = (cells[1].match(/[A-Za-z]+/) ?? [""])[0];
    // Widened to also capture dotted/hyphenated nested keys, e.g.
    // `config.models.reviewLenses.bug-detection` — `\w+` alone stops at the
    // first dot/hyphen and would silently drop the lens segment.
    const configKeys = [...cells[2].matchAll(/config\.models\.([\w.-]+)/g)].map(
      (m) => m[1],
    );
    const fallback = /"sonnet"/.test(cells[2])
      ? "builtin-sonnet"
      : /capped at opus/i.test(cells[2])
        ? "session-capped-opus"
        : // Before /inherited/: the product cell's "NOT inherited" would
          // otherwise misclassify it.
          /"opus"/.test(cells[2])
          ? "pinned-opus"
          : /inherited/.test(cells[2])
            ? "inherited"
            : "unknown";
    rows.push({ spawnSite: cells[0], stateField, configKeys, fallback });
  }
  return rows;
}

function siteConfigKeys(site: SpawnSite): string[] {
  return [site.fineGrainAbove, site.configKey].filter((k): k is string => !!k);
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Find the SPAWN_SITE matching a parsed table row on config-key set +
 * fallback. When more than one site shares that key set + fallback (e.g. a
 * future pair of `session-capped-opus` rows with an identical grain), fall
 * back to the row's spawn-site label naming the site's phase slug.
 */
function matchSite(r: ParsedRow): SpawnSite | undefined {
  const candidates = SPAWN_SITES.filter(
    (s) =>
      s.fallback === r.fallback && sameSet(siteConfigKeys(s), r.configKeys),
  );
  if (candidates.length <= 1) return candidates[0];
  const bySlug = candidates.find((s) => {
    const slug = s.phase.replace(/^review-lens:/, "");
    return r.spawnSite.toLowerCase().includes(slug.toLowerCase());
  });
  return bySlug ?? candidates[0];
}

describe("drift lint: SPAWN_SITES agrees with model-routing.md", () => {
  const md = fs.readFileSync(
    path.join(
      FLOW_ROOT,
      "skills/pipeline/flow-pipeline/references/model-routing.md",
    ),
    "utf8",
  );
  const parsed = parsePrecedenceTable(md);

  it("parses every precedence-table row (8 original + 8 review-lens rows incl. product + ui-driver)", () => {
    expect(parsed.length).toBe(17);
    for (const r of parsed) expect(r.fallback).not.toBe("unknown");
  });

  it("every table row maps onto a SPAWN_SITES entry (state field agrees)", () => {
    for (const r of parsed) {
      const site = matchSite(r);
      expect(site, `no site for ${JSON.stringify(r)}`).toBeDefined();
      // An em-dash table cell (no state field) parses to "" via
      // `cells[1].match(/[A-Za-z]+/) ?? [""]`, while a flagless site's
      // `stateField` is `undefined`. Coerce so the assertion expresses the
      // real invariant: "row has no state field ⟺ site has none".
      expect(site!.stateField ?? "").toBe(r.stateField);
    }
  });

  it("every non-exempt SPAWN_SITE is represented by a table row", () => {
    const exempt = new Set(["session"]);
    for (const site of SPAWN_SITES) {
      if (exempt.has(site.phase)) continue;
      const hit = parsed.some((r) => matchSite(r)?.phase === site.phase);
      expect(hit, `no table row for site ${site.phase}`).toBe(true);
    }
  });

  it("session is prose-only: present in SPAWN_SITES, absent from the table", () => {
    expect(SPAWN_SITES.some((s) => s.phase === "session")).toBe(true);
    // Has no precedence-table row.
    expect(parsed.some((r) => matchSite(r)?.phase === "session")).toBe(false);
  });

  it("goes RED when a fixture table row is mutated", () => {
    const [first, ...rest] = parsed;
    const mutatedFallback = [{ ...first, fallback: "builtin-sonnet" }, ...rest];
    expect(matchSite(mutatedFallback[0])).toBeUndefined();
    const mutatedKeys = [{ ...first, configKeys: ["bogus"] }, ...rest];
    expect(matchSite(mutatedKeys[0])).toBeUndefined();
  });

  it("CONFIG_KEYS is the deduped union of every site's config grains", () => {
    expect(CONFIG_KEYS).toContain("default");
    expect(CONFIG_KEYS).toContain("implement");
    expect(CONFIG_KEYS).toContain("scout");
    expect(new Set(CONFIG_KEYS).size).toBe(CONFIG_KEYS.length);
  });
});
