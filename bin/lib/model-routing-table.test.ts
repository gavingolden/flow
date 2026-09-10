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
import { resolveFlowSource } from "./paths";
import type { PipelineState } from "./state";

// Minimal state fixture — resolveRouting only reads model/model<Phase>/effort.
const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "x",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

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
      effort: "low (pinned)",
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

  it("fix-applier and ui-driver pin effort; every other row inherits", () => {
    for (const r of rows) {
      const pinned = r.phase === "fix-applier" || r.phase === "ui-driver";
      expect(r.effort).toBe(pinned ? "low (pinned)" : "inherited");
    }
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

  it("a session effort is rendered on every non-pinned row and overridden by the pins", () => {
    const rows = resolveRouting({ state: st({ effort: "high" }), config: {} });
    expect(row(rows, "review").effort).toBe("high");
    expect(row(rows, "fix-applier").effort).toBe("low (pinned)");
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
      effort: "low (pinned)",
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
  const LENS_PHASE = "review-lens:bug-detection";

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
      reviewLenses: { "bug-detection": "haiku" },
    };
    const rows = resolveRouting({
      state: st({ model: "fable", modelReview: "opus" }),
      config,
    });
    expect(row(rows, LENS_PHASE)).toMatchObject({
      model: "haiku",
      source: "config (models.reviewLenses.bug-detection)",
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
      resolveFlowSource(),
      "skills/pipeline/flow-pipeline/references/model-routing.md",
    ),
    "utf8",
  );
  const parsed = parsePrecedenceTable(md);

  it("parses every precedence-table row (8 original + 7 review-lens rows + ui-driver)", () => {
    expect(parsed.length).toBe(16);
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
