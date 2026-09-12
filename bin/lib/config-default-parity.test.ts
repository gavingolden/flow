/**
 * Pins every default the aggregate/settings view resolves through a reader
 * it introduces (rather than a shared boundary module) against its real
 * consumer's own default, so a drive-by constant edit on one side can never
 * silently diverge from the other without failing CI.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFlowSource } from "./paths";
import { resolveMaxCalls, resolveTimeout } from "../flow-research-run";
import { readTolerantBool } from "../flow-review-scope";
import { readConfigDiscovery } from "../flow-research-note";

// The view's own resolution for an EMPTY config, mirroring config-settings.ts's
// descriptors for these keys exactly (kept in sync by hand — the parity this
// test exists to guard is view-vs-consumer, not descriptor-vs-descriptor).
const viewDefaults = {
  "research.maxCalls": 12,
  "research.timeout": "3m",
  "review.lensGates": true,
  "review.deltaScope": true,
  "review.product": true,
  "research.discovery": false,
};

describe("config-default-parity: the view's defaults match their real consumer's", () => {
  it("research.maxCalls: view default matches resolveMaxCalls's default", () => {
    const consumerDefault = resolveMaxCalls({});
    expect(consumerDefault, "resolveMaxCalls({}) default").toBe(
      viewDefaults["research.maxCalls"],
    );
  });

  it("research.timeout: view default matches resolveTimeout's default", () => {
    const consumerDefault = resolveTimeout({});
    expect(consumerDefault, "resolveTimeout({}) default").toBe(
      viewDefaults["research.timeout"],
    );
  });

  it("review.lensGates / review.deltaScope / review.product: view default matches readTolerantBool's default", () => {
    for (const key of ["lensGates", "deltaScope", "product"] as const) {
      const consumerDefault = readTolerantBool(
        () => null, // absent config file
        "/nonexistent/config.json",
        key,
      );
      expect(consumerDefault, `readTolerantBool default for ${key}`).toBe(
        viewDefaults[`review.${key}` as keyof typeof viewDefaults],
      );
    }
  });

  it("research.discovery: view default matches readConfigDiscovery's default", () => {
    const missingPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-parity-")),
      "config.json",
    );
    const consumerDefault = readConfigDiscovery(missingPath);
    expect(consumerDefault, "readConfigDiscovery(missing file) default").toBe(
      viewDefaults["research.discovery"],
    );
  });

  // SPECIAL CASE: research.deepResearchFallback has no TypeScript reader —
  // its only consumer is a jq predicate embedded in flow-research's SKILL.md.
  // Assert the SKILL.md still carries the `== false` form (never `== true`),
  // proving the view's strict-false-opt-out default of `true` still matches
  // what the pipeline actually gates on. A presence-only check would not
  // discharge this risk — assert the comparison direction, not just that a
  // deepResearchFallback reference exists.
  it("research.deepResearchFallback: SKILL.md's jq predicate still gates on `== false`, matching the view's default-true opt-out", () => {
    const skillPath = path.join(
      resolveFlowSource(),
      "skills/universal/flow-research/SKILL.md",
    );
    const text = fs.readFileSync(skillPath, "utf8");
    expect(text).toContain("jq -e '(.research.deepResearchFallback) == false'");
    expect(text).not.toMatch(
      /\(\.research\.deepResearchFallback\)\s*==\s*true/,
    );
  });
});
