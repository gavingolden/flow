import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for the `flow new --research` / `forceResearch` wiring.
 *
 * The force-research feature is a contract spread across four surfaces — the
 * `forceResearch` state field + validator, the `--research` CLI parse/strip,
 * the discovery Step 1.5 skip-note ("force with `flow new --research`"), and the
 * `flow new --help` documentation. None of the four is import-coupled to the
 * others, so a future edit could silently drop one (e.g. remove the help line,
 * or the skip-note prose) and leave the rest dangling. This lint freezes their
 * co-presence: removing any one wiring point goes red on `npm run verify`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATE_TS_PATH = path.resolve(HERE, "lib", "state.ts");
const NEW_TS_PATH = path.resolve(HERE, "lib", "new.ts");
const HELP_TS_PATH = path.resolve(HERE, "lib", "help.ts");
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "product-planning",
  "references",
  "discovery-instructions.md",
);

const state = fs.readFileSync(STATE_TS_PATH, "utf8");
const newTs = fs.readFileSync(NEW_TS_PATH, "utf8");
const help = fs.readFileSync(HELP_TS_PATH, "utf8");
const discovery = fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8");

describe("forceResearch wiring lint", () => {
  it("(a) declares the forceResearch field AND its validator guard in state.ts", () => {
    expect(
      state.includes("forceResearch?: boolean"),
      "bin/lib/state.ts must declare the optional `forceResearch?: boolean` field on PipelineState.",
    ).toBe(true);
    expect(
      state.includes("o.forceResearch"),
      "bin/lib/state.ts isPipelineState must guard `o.forceResearch` (reject non-boolean).",
    ).toBe(true);
  });

  it("(b) parses and strips the --research flag in new.ts", () => {
    expect(
      newTs.includes('args.includes("--research")'),
      "bin/lib/new.ts must detect the `--research` flag via args.includes.",
    ).toBe(true);
    expect(
      newTs.includes('a !== "--research"'),
      "bin/lib/new.ts must strip the `--research` token before slugify (filter predicate).",
    ).toBe(true);
  });

  it("(c) keeps the discovery skip-note 'force with ... --research' contract string", () => {
    expect(
      /force with .*--research/.test(discovery),
      "discovery-instructions.md must carry the skip-note contract matching /force with .*--research/.",
    ).toBe(true);
  });

  it("(d) documents --research in the flow new help text", () => {
    expect(
      help.includes("--research"),
      "bin/lib/help.ts must document the `--research` flag in `flow new --help`.",
    ).toBe(true);
  });
});
