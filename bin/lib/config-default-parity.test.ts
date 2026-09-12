/**
 * Pins every default the aggregate/settings view resolves through a reader
 * it introduces (rather than a shared boundary module) against its real
 * consumer's own default, so a drive-by constant edit on one side can never
 * silently diverge from the other without failing CI.
 *
 * The left-hand side of every comparison below is derived from
 * `buildSettingsRows`'s OWN output on an empty config — never a hand-copied
 * literal — so an edit to a `config-settings.ts` descriptor's built-in value
 * fails here instead of silently diverging from the reader it claims to
 * mirror (the exact drift this file's docstring promises to catch).
 */
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSettingsRows } from "./config-settings";
import { resolveMaxCalls, resolveTimeout } from "../flow-research-run";
import { readTolerantBool } from "../flow-review-scope";
import { readConfigDiscovery } from "../flow-research-note";
import { readJudgeEnabled } from "./explain-judge";
import { isGeminiLensEnabled } from "../flow-gemini-lens";

function viewDefault(key: string): string {
  const row = buildSettingsRows(() => undefined).find((r) => r.setting === key);
  if (!row) throw new Error(`no settings row for '${key}'`);
  return row.value;
}

describe("config-default-parity: the view's defaults match their real consumer's", () => {
  it("research.maxCalls: view default matches resolveMaxCalls's default", () => {
    const consumerDefault = resolveMaxCalls({});
    expect(
      viewDefault("research.maxCalls"),
      "resolveMaxCalls({}) default",
    ).toBe(String(consumerDefault));
  });

  it("research.timeout: view default matches resolveTimeout's default", () => {
    const consumerDefault = resolveTimeout({});
    expect(viewDefault("research.timeout"), "resolveTimeout({}) default").toBe(
      consumerDefault,
    );
  });

  it("review.lensGates / review.deltaScope / review.product: view default matches readTolerantBool's default", () => {
    for (const key of ["lensGates", "deltaScope", "product"] as const) {
      const consumerDefault = readTolerantBool(
        () => null, // absent config file
        "/nonexistent/config.json",
        key,
      );
      expect(
        viewDefault(`review.${key}`),
        `readTolerantBool default for ${key}`,
      ).toBe(String(consumerDefault));
    }
  });

  it("product.judge: view default matches readJudgeEnabled's default", () => {
    const consumerDefault = readJudgeEnabled(() => null); // absent config file
    expect(
      viewDefault("product.judge"),
      "readJudgeEnabled(absent config) default",
    ).toBe(String(consumerDefault));
  });

  it("research.discovery: view default matches readConfigDiscovery's default", () => {
    // A path whose file is absent is all `readConfigDiscovery` needs — no
    // real directory has to exist on disk for that, so this never leaves a
    // `flow-parity-*` dir behind in $TMPDIR the way `mkdtempSync` did.
    const missingPath = path.join(
      os.tmpdir(),
      `flow-parity-${process.pid}-${Date.now()}`,
      "config.json",
    );
    const consumerDefault = readConfigDiscovery(missingPath);
    expect(
      viewDefault("research.discovery"),
      "readConfigDiscovery(missing file) default",
    ).toBe(String(consumerDefault));
  });

  // review.gemini is reimplemented locally in config-settings.ts (its module
  // docstring states why: `isGeminiLensEnabled` takes `rawConfigText: string`,
  // not the `ReadConfigFile` seam every other reader here uses) rather than
  // imported — exactly the class of key this file exists to pin, and the
  // strict `=== true` gate it mirrors is copy-pasted in three call sites
  // (flow-gemini-lens.ts, flow-plan-review.ts, flow-gemini-intent-guess.ts),
  // making its default MORE likely to drift than an imported one.
  it("review.gemini: view default matches isGeminiLensEnabled's default", () => {
    expect(isGeminiLensEnabled("{}")).toBe(false);
    expect(
      isGeminiLensEnabled(JSON.stringify({ review: { gemini: true } })),
    ).toBe(true);
    expect(viewDefault("review.gemini")).toBe(String(false));
  });

  // SPECIAL CASE: research.deepResearchFallback has no TypeScript reader —
  // its only consumer is a jq predicate embedded in flow-research's SKILL.md.
  // The comparison-direction assertion itself (`== false`, never `== true`)
  // is already pinned verbatim by `bin/flow-research-skill-lint.test.ts`;
  // re-asserting it here would only duplicate that spec. What THIS file is
  // for is the view-vs-consumer link the lint spec cannot check: that the
  // view's rendered default for the key is the `true` the SKILL.md
  // `== false` strict opt-out assumes.
  it("research.deepResearchFallback: the view's rendered default matches the SKILL.md predicate's assumed true", () => {
    expect(viewDefault("research.deepResearchFallback")).toBe("true");
  });
});
