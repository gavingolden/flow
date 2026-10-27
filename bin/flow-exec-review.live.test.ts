/**
 * Live smoke of the executive review's real model call: prompt, envelope, and
 * parse against a real `flow-claude-headless` child (about $1).
 *
 * Skipped unless FLOW_LIVE_EXEC_REVIEW=1, so `npm run test` never spends. The
 * run is hermetic: a temp HOME (charter), a temp state dir (grant, log), and a
 * temp worktree — nothing under the real ~/.flow is read or written except the
 * optional model config.
 *
 *   FLOW_LIVE_EXEC_REVIEW=1 npx vitest run bin/flow-exec-review.live.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "./flow-exec-review";
import { writeGrant } from "./lib/epic-grant";
import { readManagerLog } from "./lib/epic-manager-log";
import { extractCharterSection } from "./lib/exec-charter";
import { parseEnvelope } from "./lib/exec-review-envelope";
import { checkPlanPreconditions } from "./lib/exec-review-preconditions";
import { writeState } from "./lib/state";

const FIXTURES = path.resolve(__dirname, "__fixtures__", "exec-review");
const TEMPLATE = path.resolve(
  __dirname,
  "..",
  "templates",
  "product.md.template",
);
const LIVE = process.env.FLOW_LIVE_EXEC_REVIEW === "1";

let root: string;
let home: string;
let stateDir: string;
let wt: string;

function w(p: string, c: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-live-"));
  home = path.join(root, "home");
  stateDir = path.join(root, "state");
  wt = path.join(root, "wt");
  const charter = extractCharterSection(fs.readFileSync(TEMPLATE, "utf8"));
  w(path.join(home, ".flow", "product.md"), `# Brief\n\n${charter}\n`);
  w(
    path.join(wt, "src", "example.ts"),
    [
      "// example entry point",
      "",
      "console.log(process.argv.length);",
      "",
    ].join("\n"),
  );
  w(
    path.join(wt, ".flow-tmp", "plan.md"),
    fs.readFileSync(path.join(FIXTURES, "plan.md"), "utf8"),
  );
  w(
    path.join(wt, ".flow-tmp", "plan-review.md.run.json"),
    fs.readFileSync(path.join(FIXTURES, "plan-review.md.run.json"), "utf8"),
  );
  w(
    path.join(wt, ".flow-tmp", "plan-review.md"),
    "Reviewer found no blocking points.\n",
  );
  w(
    path.join(wt, ".flow-tmp", "pr-description-draft.md"),
    "## Key decisions\n\n- progress goes to stderr\n",
  );
  w(
    path.join(wt, ".flow", "epics", "live-epic", "manifest.json"),
    JSON.stringify({
      epicId: "live-epic",
      prompt: "make the example tool observable",
      createdAt: "2026-10-26T00:00:00.000Z",
      features: [
        { id: "f1", title: "Verbose flag", description: "d", dependsOn: [] },
      ],
    }),
  );
  w(
    path.join(wt, ".flow", "epics", "live-epic", "design.md"),
    "**Goal:** make the example tool observable.\n\n### f1 · Verbose flag\n\nA single opt-in flag.\n",
  );
  writeState(
    {
      slug: "live-feature",
      phase: "planning",
      repo: wt,
      worktree: wt,
      updatedAt: "2026-10-26T00:00:00.000Z",
      epic: { slug: "live-epic", featureId: "f1" },
    },
    stateDir,
  );
  writeGrant(
    {
      version: 1,
      epic: "live-epic",
      classes: ["plan"],
      grantedAt: "2026-10-26T00:00:00.000Z",
      grantedBy: "owner-cli",
    },
    stateDir,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("exec-review fixture (always runs, spends nothing)", () => {
  it("the fixture plan passes every mechanical precondition with the real lint", () => {
    const planText = fs.readFileSync(path.join(FIXTURES, "plan.md"), "utf8");
    const runRecordText = fs.readFileSync(
      path.join(FIXTURES, "plan-review.md.run.json"),
      "utf8",
    );
    expect(
      checkPlanPreconditions({ planText, runRecordText, worktree: wt }),
    ).toEqual({ ok: true });
  });
});

describe.skipIf(!LIVE)(
  "flow-exec-review live (FLOW_LIVE_EXEC_REVIEW=1)",
  () => {
    it("runs one real plan review and logs one exec-decision", () => {
      const printed: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...a) => void printed.push(a.join(" ")));
      let code: number;
      try {
        code = run(
          [
            "review",
            "--kind",
            "plan",
            "--epic",
            "live-epic",
            "--slug",
            "live-feature",
          ],
          {
            stateDir,
            homeDir: home,
            readConfig: () => undefined,
          },
        );
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0);
      expect(printed).toHaveLength(1);
      const result = JSON.parse(printed[0]);
      expect(result.ran, JSON.stringify(result)).toBe(true);
      expect(["approve", "challenge", "defer"]).toContain(result.action);
      expect(typeof result.rationale).toBe("string");
      expect(result.rationale.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(result.confidence);
      expect(
        parseEnvelope(
          JSON.stringify({ ...result, decision: result.action, evidence: [] }),
          "plan",
        ).ok,
      ).toBe(true);

      const decisions = readManagerLog("live-epic", stateDir).filter(
        (e) => e.kind === "exec-decision",
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0].exec?.decisionId).toBe(result.decisionId);
    }, 600_000);
  },
);
