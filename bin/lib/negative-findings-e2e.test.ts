import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectForeclosedEntries,
  formatMarkdown,
  formatPlainText,
} from "./foreclosed-paths-format";

/**
 * End-to-end coverage for the full negative-findings chain: canonical-shape
 * (and drifted-shape) `agent-output-<lens>.json` artifacts on disk, through
 * the Task-3 `--collect-lens-negatives` collector, embedded into a
 * consolidator-result.json fixture, through the Task-5
 * `## Foreclosed Paths` / `FORECLOSED PATHS` formatter. `vitest.config.ts`
 * already includes `bin/**\/*.test.ts` — no config change needed.
 *
 * The collector itself (`collectLensNegativesFromDir`) is exercised via the
 * `--collect-lens-negatives` CLI subprocess (`bun bin/lib/agent-finding-schema.ts`),
 * not a direct in-process import: it uses `Bun.file` internally, and this
 * suite runs under `vitest run` on plain Node (not `bun test`) — the same
 * constraint `bin/lib/agent-finding-schema.test.ts`'s `runCli` helper
 * already works around for its own `--collect-lens-negatives` coverage.
 */

const SCHEMA_SCRIPT = path.resolve(__dirname, "agent-finding-schema.ts");

function runCollectLensNegatives(dir: string): {
  lens_rejected_alternatives: Array<Record<string, unknown>>;
  lens_anti_patterns_found: Array<Record<string, unknown>>;
  lens_negatives_missing: string[];
} {
  const result = spawnSync(
    "bun",
    [SCHEMA_SCRIPT, "--collect-lens-negatives", dir],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `--collect-lens-negatives exited ${result.status}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim());
}

function withTmpDir<T>(
  files: Record<string, unknown>,
  fn: (dirPath: string) => T,
): T {
  const dir = mkdtempSync(path.join(tmpdir(), "negative-findings-e2e-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(contents), "utf8");
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseConsolidatorFields() {
  return {
    consolidated_findings: [],
    dropped_by_validation: [],
    rejected_alternatives: [],
    anti_patterns_found: [],
    summary: "s",
  };
}

describe("negative-findings e2e — canonical-shape artifacts", () => {
  it("six canonical-shape lenses produce one bullet per entry, each attributed and none unreadable", async () => {
    withTmpDir(
      {
        "agent-output-bug-detection.json": {
          findings: [],
          rejected_alternatives: [
            { considered_approach: "a1", why_rejected: "r1" },
          ],
          anti_patterns_found: [],
        },
        "agent-output-security.json": {
          findings: [],
          rejected_alternatives: [],
          anti_patterns_found: [
            { location: "s.ts:1", pattern: "p1", recommendation: "rec1" },
          ],
        },
        "agent-output-pattern-consistency.json": {
          findings: [],
          rejected_alternatives: [
            { considered_approach: "a2", why_rejected: "r2" },
          ],
          anti_patterns_found: [],
        },
        "agent-output-performance.json": {
          findings: [],
          rejected_alternatives: [],
          anti_patterns_found: [
            { location: "perf.ts:1", pattern: "p2", recommendation: "rec2" },
          ],
        },
        "agent-output-supply-chain.json": {
          findings: [],
          rejected_alternatives: [
            { considered_approach: "a3", why_rejected: "r3" },
          ],
          anti_patterns_found: [],
        },
        "agent-output-test-coverage.json": {
          findings: [],
          rejected_alternatives: [],
          anti_patterns_found: [
            { location: "tc.ts:1", pattern: "p3", recommendation: "rec3" },
          ],
        },
      },
      (dir) => {
        const collected = runCollectLensNegatives(dir);
        expect(collected.lens_rejected_alternatives).toHaveLength(3);
        expect(collected.lens_anti_patterns_found).toHaveLength(3);
        expect(collected.lens_negatives_missing).toEqual([]);

        const consolidatorRaw = JSON.stringify({
          ...baseConsolidatorFields(),
          lens_rejected_alternatives: collected.lens_rejected_alternatives,
          lens_anti_patterns_found: collected.lens_anti_patterns_found,
          lens_negatives_missing: collected.lens_negatives_missing,
        });

        const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw });
        const lensBullets = md.filter((l) => l.startsWith("- **"));
        expect(lensBullets).toHaveLength(6);
        for (const bullet of lensBullets) {
          expect(bullet).toMatch(/\(lens: [a-z-]+\)/);
        }
        expect(md.join("\n")).not.toContain("unreadable");
      },
    );
  });

  it("the six PR-#724 drift vocabularies recover; unmappable entries count as (N unreadable)", async () => {
    withTmpDir(
      {
        "agent-output-bug-detection.json": {
          findings: [],
          rejected_alternatives: [
            { shape: "a1", why_rejected: "r1" }, // shape -> considered_approach
            "bare string entry", // bare string -> recoverable for rejected
          ],
          anti_patterns_found: [],
        },
        "agent-output-security.json": {
          findings: [],
          rejected_alternatives: [
            { candidate: "a2", why_rejected: "r2" }, // candidate -> considered_approach
          ],
          anti_patterns_found: [],
        },
        "agent-output-pattern-consistency.json": {
          findings: [],
          rejected_alternatives: [
            { considered_approach: "a3", reason: "r3" }, // reason -> why_rejected
          ],
          anti_patterns_found: [
            { location: "l.ts:1", observation: "o1", recommendation: "rec1" }, // observation -> pattern
          ],
        },
        "agent-output-performance.json": {
          findings: [],
          rejected_alternatives: [
            { considered_approach: "a4", reason_rejected: "r4" }, // reason_rejected -> why_rejected
          ],
          anti_patterns_found: [],
        },
        "agent-output-supply-chain.json": {
          findings: [],
          rejected_alternatives: [
            { checked: "a5", why_rejected: "r5" }, // checked -> considered_approach
          ],
          anti_patterns_found: [],
        },
        "agent-output-test-coverage.json": {
          findings: [],
          // Present-but-empty: non-absent, contributes nothing on its own.
          rejected_alternatives: [],
          anti_patterns_found: [
            "bare anti-pattern string", // bare string -> unmappable for anti-pattern
          ],
        },
      },
      (dir) => {
        const collected = runCollectLensNegatives(dir);
        // Six recoverable rejected entries (bug-detection's shape alias +
        // bare-string recovery, security's candidate alias,
        // pattern-consistency's reason alias, performance's
        // reason_rejected alias, supply-chain's checked alias) and one
        // recoverable anti-pattern (pattern-consistency's observation
        // alias).
        expect(collected.lens_rejected_alternatives).toHaveLength(6);
        expect(collected.lens_anti_patterns_found).toHaveLength(1);
        // test-coverage's ONLY entry (a bare anti-pattern string) is
        // unmappable — a location can't be invented — and its
        // rejected_alternatives slot is present-but-empty, so the lens's
        // combined collection yields NOTHING: the residual
        // `"<lens> (N unreadable)"` marker fires, mirroring the
        // fix-applier's existing `(N unreadable)` precedent.
        expect(collected.lens_negatives_missing).toEqual([
          "test-coverage (1 unreadable)",
        ]);

        const consolidatorRaw = JSON.stringify({
          ...baseConsolidatorFields(),
          lens_rejected_alternatives: collected.lens_rejected_alternatives,
          lens_anti_patterns_found: collected.lens_anti_patterns_found,
          lens_negatives_missing: collected.lens_negatives_missing,
        });

        const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw });
        const joined = md.join("\n");
        expect(joined).toContain("(lens: bug-detection)");
        expect(joined).toContain("(lens: security)");
        expect(joined).toContain("(lens: pattern-consistency)");
        expect(joined).toContain("(lens: performance)");
        expect(joined).toContain("(lens: supply-chain)");
        expect(joined).toContain("test-coverage (1 unreadable)");
      },
    );
  });
});

describe("negative-findings e2e — total drop warning", () => {
  it("every lens slot yielding zero entries renders the warning before <details>, and formatPlainText carries the same text", async () => {
    withTmpDir(
      {
        "agent-output-bug-detection.json": {
          findings: [],
          rejected_alternatives: [],
          anti_patterns_found: [],
        },
        "agent-output-security.json": {
          findings: [],
          // absent slots entirely
        },
      },
      (dir) => {
        const collected = runCollectLensNegatives(dir);
        expect(collected.lens_rejected_alternatives).toEqual([]);
        expect(collected.lens_anti_patterns_found).toEqual([]);
        expect(collected.lens_negatives_missing.length).toBeGreaterThan(0);

        const consolidatorRaw = JSON.stringify({
          ...baseConsolidatorFields(),
          lens_rejected_alternatives: collected.lens_rejected_alternatives,
          lens_anti_patterns_found: collected.lens_anti_patterns_found,
          lens_negatives_missing: collected.lens_negatives_missing,
        });

        const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw });
        const detailsIdx = md.findIndex((l) => l.startsWith("<details>"));
        const warningIdx = md.findIndex((l) => l.startsWith("> [!WARNING]"));
        expect(warningIdx).toBeGreaterThanOrEqual(0);
        expect(detailsIdx).toBeGreaterThan(warningIdx);

        const pt = formatPlainText({ fixApplierRaw: "", consolidatorRaw });
        expect(pt[0]).toBe("[!WARNING]");
        expect(pt[1]).toContain(
          "Lens negative findings: 0 entries reached this report;",
        );
      },
    );
  });
});

describe("negative-findings e2e — disk fallback rescues an absent or empty consolidator artifact", () => {
  const bugDetectionFile = {
    findings: [],
    rejected_alternatives: [
      { considered_approach: "disk-sourced", why_rejected: "still valid" },
    ],
    anti_patterns_found: [],
  };

  it("fires when the consolidator artifact carries NO lens_* keys", () => {
    withTmpDir(
      { "agent-output-bug-detection.json": bugDetectionFile },
      (dir) => {
        const consolidatorRaw = JSON.stringify(baseConsolidatorFields());
        const entries = collectForeclosedEntries({
          fixApplierRaw: "",
          consolidatorRaw,
          artifactDir: dir,
        });
        const md = formatMarkdown({
          fixApplierRaw: "",
          consolidatorRaw,
          artifactDir: dir,
        });
        expect(entries.some((e) => e.source === "lens")).toBe(true);
        expect(md.join("\n")).toContain("(lens: bug-detection)");
      },
    );
  });

  it("fires when the consolidator artifact carries all three lens_* keys present but empty", () => {
    withTmpDir(
      { "agent-output-bug-detection.json": bugDetectionFile },
      (dir) => {
        const consolidatorRaw = JSON.stringify({
          ...baseConsolidatorFields(),
          lens_rejected_alternatives: [],
          lens_anti_patterns_found: [],
          lens_negatives_missing: [],
        });
        const entries = collectForeclosedEntries({
          fixApplierRaw: "",
          consolidatorRaw,
          artifactDir: dir,
        });
        const md = formatMarkdown({
          fixApplierRaw: "",
          consolidatorRaw,
          artifactDir: dir,
        });
        expect(entries.some((e) => e.source === "lens")).toBe(true);
        expect(md.join("\n")).toContain("(lens: bug-detection)");
      },
    );
  });
});

describe("negative-findings e2e — raw/unmappable entry is not silently dropped", () => {
  it("an entry matching neither nominal alias nor positional fallback renders a (lens: <name>, raw) bullet", () => {
    withTmpDir(
      {
        "agent-output-security.json": {
          findings: [],
          rejected_alternatives: [{ totally_unrecognized_key: "value" }],
          anti_patterns_found: [],
        },
      },
      (dir) => {
        const consolidatorRaw = JSON.stringify(baseConsolidatorFields());
        const inputs = { fixApplierRaw: "", consolidatorRaw, artifactDir: dir };
        const entries = collectForeclosedEntries(inputs);
        expect(entries.some((e) => e.rawEntry !== undefined)).toBe(true);

        const md = formatMarkdown(inputs);
        expect(md.some((l) => l.includes("(lens: security, raw):"))).toBe(true);
        const pt = formatPlainText(inputs);
        expect(pt.some((l) => l.includes("(lens: security, raw):"))).toBe(true);
      },
    );
  });
});
