import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for the host-wide research-cache wiring in
 * `skills/universal/flow-research/SKILL.md`.
 *
 * Direct `/flow-research` reuses the same host-wide `flow-research-cache` that
 * `/product-planning` discovery Step 1.5 uses, but on a SEPARATE keyspace: the
 * direct procedure composes its question under a namespaced prefix while
 * discovery keys on the BARE question. That namespacing is achieved purely by the
 * question STRING the SKILL.md procedure composes (the prefix below) — the helper
 * is untouched — so the prefix literal, the get-before-fan-out / put-after-
 * synthesis ordering, the graceful-miss contract, and the natural-language opt-out
 * all live in prose and would silently rot without a lint. This freezes them: a
 * future edit that drops the prefix, reorders the get/put, or weakens the
 * graceful-miss / opt-out contract goes red on `npm run verify`.
 *
 * It ALSO asserts isolation by construction — discovery-instructions.md must NOT
 * carry the direct-invocation prefix — so the two keyspaces can never be wired to
 * collide by a copy-paste between the two docs.
 */

// The direct-invocation namespace prefix. Pinned here as a top-of-file const so a
// rename forces a same-commit update to this lint (and to the SKILL.md it freezes).
const NAMESPACE_PREFIX = "flow-research-direct::";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW_RESEARCH_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "universal",
  "flow-research",
  "SKILL.md",
);
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "product-planning",
  "references",
  "discovery-instructions.md",
);
const content = fs.readFileSync(FLOW_RESEARCH_SKILL_MD_PATH, "utf8");
const discovery = fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8");

const FILE_LABEL = "skills/universal/flow-research/SKILL.md";

describe("flow-research cache-wiring lint", () => {
  it("wires both the cache get and the cache put by bare PATH name", () => {
    expect(
      content.includes("flow-research-cache get"),
      `${FILE_LABEL} must read the cache via 'flow-research-cache get' before the gather fan-out.`,
    ).toBe(true);
    expect(
      content.includes("flow-research-cache put"),
      `${FILE_LABEL} must persist the synthesis via 'flow-research-cache put' after Step 4.`,
    ).toBe(true);
  });

  it("composes the cache key under the byte-exact direct-invocation namespace prefix", () => {
    expect(
      content.includes(NAMESPACE_PREFIX),
      `${FILE_LABEL} must namespace the direct keyspace with the exact prefix ` +
        `'${NAMESPACE_PREFIX}' — namespacing is achieved purely by this composed ` +
        `question string, so a rename silently collides direct with discovery.`,
    ).toBe(true);
  });

  it("states the graceful-miss contract (non-zero get → live run, never error)", () => {
    expect(
      content.includes("fall through to the live fan-out"),
      `${FILE_LABEL} must state that any non-zero get exit falls through to the live fan-out.`,
    ).toBe(true);
    expect(
      content.includes("never error the run"),
      `${FILE_LABEL} must state the get must never error the run (graceful-miss contract).`,
    ).toBe(true);
  });

  it("enumerates the natural-language opt-out triggers and 'skip get, still put' semantics", () => {
    const triggers = [
      "fresh",
      "no cache",
      "don't use the cache",
      "bypass cache",
      "re-research",
      "latest",
    ];
    const missing = triggers.filter((t) => !content.includes(t));
    expect(
      missing,
      `${FILE_LABEL} must enumerate the bounded cache-bypass triggers. Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);
    expect(
      content.includes("skip get, still put"),
      `${FILE_LABEL} must state the opt-out still issues the put ('skip get, still put').`,
    ).toBe(true);
  });

  it("orders the get before the gather fan-out and the put after the synthesis step", () => {
    const getIdx = content.indexOf("flow-research-cache get");
    const putIdx = content.indexOf("flow-research-cache put");
    const gatherIdx = content.indexOf("## 2. Gather");
    const synthesizeIdx = content.indexOf("## 4. Synthesize");

    // Sanity: every anchor must exist (indexOf -1 would make ordering vacuous).
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(gatherIdx).toBeGreaterThanOrEqual(0);
    expect(synthesizeIdx).toBeGreaterThanOrEqual(0);

    expect(
      getIdx,
      `${FILE_LABEL}: 'flow-research-cache get' must appear before the '## 2. Gather' fan-out so a hit skips it.`,
    ).toBeLessThan(gatherIdx);
    expect(
      putIdx,
      `${FILE_LABEL}: 'flow-research-cache put' must appear after the '## 4. Synthesize' step (persist only after synthesis).`,
    ).toBeGreaterThan(synthesizeIdx);
  });

  it("pins the cache-HIT short-circuit — a hit SKIPS the gather/refute/synthesize fan-out", () => {
    // The feature's whole purpose: on a hit the procedure must NOT re-run the
    // expensive gather→refute→synthesize fan-out. Every other wiring mechanic is
    // frozen above, but a regression that dropped this skip wording would keep the
    // lint green while neutering the cache (it would still get/put but redundantly
    // re-pay the fan-out). Pin the byte-exact hit-branch skip phrase.
    expect(
      content.includes(
        "SKIP the gather (Step 2), refute (Step 3), and synthesize (Step 4) steps entirely",
      ),
      `${FILE_LABEL} must state that a cache HIT SKIPS the gather/refute/synthesize ` +
        `fan-out — without this short-circuit the cache reuses nothing.`,
    ).toBe(true);
  });

  it("keeps the keyspaces isolated by construction — discovery never carries the direct prefix", () => {
    expect(
      discovery.includes(NAMESPACE_PREFIX),
      `discovery-instructions.md must NOT contain the direct-invocation prefix ` +
        `'${NAMESPACE_PREFIX}' — discovery keys on the BARE question. Its presence ` +
        `there would mean the two keyspaces had been wired to collide.`,
    ).toBe(false);
  });
});
