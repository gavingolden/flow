import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGrant } from "./epic-grant";
import { managerDir, readManagerLog } from "./epic-manager-log";
import { computeDecisionHash } from "../flow-plan-review";
import {
  derivePlanRound,
  stampBullet,
  upsertStamp,
} from "./exec-review-record";
import {
  defaultExecDeps,
  type ExecReviewDeps,
  type HeadlessEnvelope,
} from "./exec-review-shared";
import { runPlanReview, skipTextFor } from "./exec-review-plan";
import type { PreconditionId } from "./exec-review-preconditions";
import { writeState } from "./state";

const PLAN = `# PRD

# Title

**Goal:** Do it.

## Request vetting

- **Verdict:** adopt

## Recommendation

**Proceed** — go.

# Task breakdown

### Task 1: T

- **Description:** d
- **Contract:**
  - **Files:** edit x.
- **Acceptance criteria:** \`npx vitest run x\`
`;
const planWithHash = `${PLAN}\n<!-- flow-plan-review-hash: ${computeDecisionHash(PLAN)} -->\n`;
const RUN = JSON.stringify({
  reviewers: [{ model: "Gemini", ran: true, lensesEngaged: 7 }],
});
const CHARTER =
  "# Brief\n\n## Deciding on my behalf\n\n1. goal first\n\n### Standing corrections\n";

let root: string;
let home: string;
let stateDir: string;
let wt: string;
let calls: Array<{ argv: string[]; cwd: string; prompt: string }>;
let events: Array<Record<string, unknown>>;
let reply: (call: number) => { env: HeadlessEnvelope; result?: unknown };
let tick: number;

function w(p: string, c: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

const good = (over: object = {}) => ({
  decision: "approve",
  doorType: "two-way",
  confidence: "high",
  rationale: "the design settles it",
  evidence: ["bin/lib/state.ts:10"],
  undo: "redirect the plan",
  ...over,
});

function deps(over: Partial<ExecReviewDeps> = {}): ExecReviewDeps {
  const base = defaultExecDeps();
  return {
    ...base,
    stateDir,
    homeDir: home,
    readConfig: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 26, 1, 2, 3 + tick++)),
    random: () => "ab12",
    recordEvent: (_e, a) => void events.push(a),
    preconditions: {
      fileExists: () => true,
      lineCount: () => 1000,
      lint: () => [],
    },
    spawnHeadless: (argv, opts) => {
      calls.push({
        argv,
        cwd: opts.cwd,
        prompt: fs.readFileSync(
          argv[argv.indexOf("--prompt-file") + 1],
          "utf8",
        ),
      });
      const r = reply(calls.length);
      const out = argv[argv.indexOf("--out") + 1];
      if (r.env.ran) {
        w(
          out,
          JSON.stringify({
            result:
              typeof r.result === "string"
                ? r.result
                : JSON.stringify(r.result),
          }),
        );
        return { artifact: out, ...r.env };
      }
      return r.env;
    },
    ...over,
  };
}

const arg = (i: number, flag: string) => {
  const a = calls[i].argv;
  return a[a.indexOf(flag) + 1];
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "execplan-"));
  home = path.join(root, "home");
  stateDir = path.join(root, "state");
  wt = path.join(root, "wt");
  calls = [];
  events = [];
  tick = 0;
  reply = () => ({ env: { ran: true, total_cost_usd: 0.3 }, result: good() });
  w(path.join(home, ".flow", "product.md"), CHARTER);
  w(path.join(wt, ".flow-tmp", "plan.md"), planWithHash);
  w(path.join(wt, ".flow-tmp", "plan-review.md.run.json"), RUN);
  w(path.join(wt, ".flow-tmp", "plan-review.md"), "cross-model prose");
  w(
    path.join(wt, ".flow-tmp", "pr-description-draft.md"),
    "## TLDR\n\nx\n\n## Key decisions\n\n- existing\n\n## Test Steps\n\n- [ ] a\n",
  );
  w(
    path.join(wt, ".flow", "epics", "e1", "manifest.json"),
    JSON.stringify({
      epicId: "e1",
      prompt: "p",
      createdAt: "t",
      features: [{ id: "f1", title: "One", description: "d", dependsOn: [] }],
    }),
  );
  w(
    path.join(wt, ".flow", "epics", "e1", "design.md"),
    "**Goal:** epic goal\n\n### f1 · One\n\nfeature design\n\n### f2 · Two\n\nother\n",
  );
  writeState(
    {
      slug: "feat",
      phase: "planning",
      repo: root,
      worktree: wt,
      updatedAt: "2026-10-26T00:00:00.000Z",
      epic: { slug: "e1", featureId: "f1" },
    },
    stateDir,
  );
  writeGrant(
    {
      version: 1,
      epic: "e1",
      classes: ["plan"],
      grantedAt: "t",
      grantedBy: "owner-cli",
    },
    stateDir,
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (d = deps()) => runPlanReview({ slug: "feat", epic: "e1" }, d);
const log = () => readManagerLog("e1", stateDir);

describe("grant scope", () => {
  it("makes zero calls, logs nothing, and records no telemetry without a grant", () => {
    fs.rmSync(managerDir("e1", stateDir), { recursive: true });
    const r = run();
    expect(r).toMatchObject({ ran: false, skipReason: "no-grant" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(managerDir("e1", stateDir))).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("refuses another epic's expectation and an unknown slug without spending", () => {
    expect(
      runPlanReview({ slug: "feat", epic: "other" }, deps()),
    ).toMatchObject({
      ran: false,
      skipReason: "other-epic",
    });
    expect(runPlanReview({ slug: "ghost", epic: "e1" }, deps())).toMatchObject({
      ran: false,
      skipReason: "state-missing",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("skips before spend", () => {
  it("charter-missing when the user brief has no charter section", () => {
    w(path.join(home, ".flow", "product.md"), "# Brief only\n");
    const r = run();
    expect(r).toMatchObject({ ran: false, skipReason: "charter-missing" });
    expect(calls).toHaveLength(0);
    expect(log().map((e) => e.kind)).toEqual(["exec-skip"]);
    expect(log()[0].reason).toBe("charter-missing");
  });

  it("charter-too-long", () => {
    w(path.join(home, ".flow", "product.md"), `${CHARTER}${"x".repeat(9000)}`);
    expect(run()).toMatchObject({ ran: false, skipReason: "charter-too-long" });
  });

  it("names the failed precondition, logs it, and spends nothing", () => {
    w(
      path.join(wt, ".flow-tmp", "plan-review.md.run.json"),
      JSON.stringify({ reviewers: [] }),
    );
    const r = run();
    expect(r).toMatchObject({
      ran: false,
      skipReason: "precondition-failed",
      failedPrecondition: "cross-model-not-engaged",
    });
    expect(calls).toHaveLength(0);
    expect(log()[0]).toMatchObject({
      kind: "exec-skip",
      reason: "precondition-failed",
    });
    expect(events[0]).toMatchObject({
      precondition: "cross-model-not-engaged",
    });
  });

  it("plan-unreadable when plan.md is gone", () => {
    fs.rmSync(path.join(wt, ".flow-tmp", "plan.md"));
    expect(run()).toMatchObject({ ran: false, skipReason: "plan-unreadable" });
  });
});

describe("headless failures pause with the forwarded reason", () => {
  it("forwards a budget skip and logs the spend", () => {
    reply = () => ({
      env: { ran: false, skipReason: "budget-exceeded", total_cost_usd: 3.1 },
    });
    const r = run();
    expect(r).toMatchObject({ ran: false, skipReason: "budget-exceeded" });
    expect(log()[0]).toMatchObject({
      kind: "exec-skip",
      reason: "budget-exceeded",
    });
    expect(log()[0].exec?.costUsd).toBe(3.1);
  });

  it("skips with envelope-invalid when the reply fails validation", () => {
    reply = () => ({ env: { ran: true }, result: "I could not decide" });
    expect(run()).toMatchObject({ ran: false, skipReason: "envelope-invalid" });
    reply = () => ({
      env: { ran: true },
      result: good({ confidence: "certain" }),
    });
    const r = run();
    expect(r).toMatchObject({ ran: false, skipReason: "envelope-invalid" });
    expect(log().every((e) => e.kind === "exec-skip")).toBe(true);
  });

  it("skips with headless-error and a skipText when the child returns no envelope", () => {
    const r = run(deps({ spawnHeadless: () => ({}) }));
    expect(r).toMatchObject({
      ran: false,
      skipReason: "headless-error",
      skipText: skipTextFor("headless-error"),
    });
    expect(log()[0]).toMatchObject({
      kind: "exec-skip",
      reason: "headless-error",
    });
  });

  it("treats a missing artifact as an invalid envelope", () => {
    expect(
      run(
        deps({
          spawnHeadless: () => ({
            ran: true,
            artifact: path.join(root, "nope.json"),
          }),
        }),
      ),
    ).toMatchObject({ ran: false, skipReason: "envelope-invalid" });
  });
});

describe("skipText", () => {
  const ALL: PreconditionId[] = [
    "cross-model-unavailable",
    "cross-model-not-engaged",
    "cross-model-stale",
    "anchor-unresolved",
    "plan-lint",
    "needs-user-input",
    "stakes-confidence",
    "plan-deviates-from-request",
    "one-way-action",
  ];

  it("gives every precondition its own plain-language sentence", () => {
    const texts = ALL.map((id) => skipTextFor("precondition-failed", id));
    expect(new Set(texts).size).toBe(ALL.length);
    for (const t of texts) {
      expect(t).not.toMatch(/precondition-failed|[a-z]+-[a-z]+-[a-z]+/);
      expect(t.length).toBeGreaterThan(20);
    }
    expect(skipTextFor("precondition-failed", "cross-model-stale")).toBe(
      "the outside-model review is older than the current plan",
    );
  });

  it("falls back to a readable sentence for an unmapped skip reason", () => {
    expect(skipTextFor("some-new-reason")).toContain("some-new-reason");
    expect(skipTextFor("charter-missing")).not.toBe("charter-missing");
  });

  it("is carried on every ran:false result", () => {
    w(path.join(home, ".flow", "product.md"), "# Brief only\n");
    expect(run()).toMatchObject({
      ran: false,
      skipText: expect.stringContaining("Deciding on my behalf"),
    });
    w(path.join(home, ".flow", "product.md"), CHARTER);
    w(
      path.join(wt, ".flow-tmp", "plan-review.md.run.json"),
      JSON.stringify({ reviewers: [] }),
    );
    expect(run()).toMatchObject({
      ran: false,
      skipReason: "precondition-failed",
      skipText: skipTextFor("precondition-failed", "cross-model-not-engaged"),
    });
  });
});

describe("approve", () => {
  it("defers an approve whose evidence anchors resolve to no real worktree file", () => {
    const r = run(
      deps({
        preconditions: {
          fileExists: (p) => !p.endsWith("state.ts"),
          lineCount: () => 1000,
          lint: () => [],
        },
      }),
    );
    expect(r).toMatchObject({ ran: true, action: "defer" });
    if (!r.ran) throw new Error("unreachable");
    expect(r.demotions.join(" ")).toContain("no evidence anchor resolves");
    expect(r.disclosure).toBeUndefined();
    const draft = fs.readFileSync(
      path.join(wt, ".flow-tmp", "pr-description-draft.md"),
      "utf8",
    );
    expect(draft).not.toContain("decision plan-");
    expect(log().find((e) => e.kind === "exec-decision")?.exec?.action).toBe(
      "defer",
    );
  });

  it("defers an approve whose cited line is past the end of the file", () => {
    const r = run(
      deps({
        preconditions: {
          fileExists: () => true,
          lineCount: () => 5,
          lint: () => [],
        },
      }),
    );
    expect(r).toMatchObject({ ran: true, action: "defer" });
  });

  it("logs the decision, stamps the draft PR body, and discloses", () => {
    const r = run();
    expect(r).toMatchObject({
      ran: true,
      action: "approve",
      round: 1,
      costUsd: 0.3,
    });
    if (!r.ran) throw new Error("unreachable");
    expect(r.disclosure).toBe(
      `Approved by the epic executive under your grant (decision ${r.decisionId})`,
    );
    expect(r.decisionId).toMatch(/^plan-20261026T\d{6}-ab12$/);

    const d = log().find((e) => e.kind === "exec-decision");
    expect(d?.exec).toMatchObject({
      decisionId: r.decisionId,
      reviewKind: "plan",
      action: "approve",
      confidence: "high",
      doorType: "two-way",
      rationale: "the design settles it",
      model: "opus",
      effort: "high",
    });

    const draft = fs.readFileSync(
      path.join(wt, ".flow-tmp", "pr-description-draft.md"),
      "utf8",
    );
    expect(draft).toContain(
      `- **Plan approved by the epic executive under your grant (decision ${r.decisionId}):**`,
    );
    expect(draft).toContain("Undo: redirect the plan.");
    expect(draft).toContain(
      "To stop future approvals: flow epic grant e1 --autonomy off.",
    );
    expect(draft.indexOf("Plan approved")).toBeGreaterThan(
      draft.indexOf("- existing"),
    );
    expect(draft.indexOf("Plan approved")).toBeLessThan(
      draft.indexOf("## Test Steps"),
    );
    expect(events.at(-1)).toMatchObject({ action: "approve", model: "opus" });
  });

  it("calls the headless child with the capped, read-only, resolved-model argv", () => {
    run();
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(wt);
    expect(arg(0, "--model")).toBe("opus");
    expect(arg(0, "--effort")).toBe("high");
    expect(arg(0, "--allowed-tools")).toBe("Read,Grep,Glob");
    expect(arg(0, "--max-budget-usd")).toBe("3");
    expect(arg(0, "--max-turns")).toBe("25");
    expect(arg(0, "--timeout-sec")).toBe("480");
    expect(arg(0, "--out")).toContain(
      path.join(wt, ".flow-tmp", "exec-review-plan-"),
    );
    expect(arg(0, "--prompt-file").startsWith(wt)).toBe(false);
  });

  it("takes the model from manager.json, then config", () => {
    w(
      path.join(managerDir("e1", stateDir), "manager.json"),
      JSON.stringify({ model: "sonnet", effort: "medium" }),
    );
    run();
    expect([arg(0, "--model"), arg(0, "--effort")]).toEqual([
      "sonnet",
      "medium",
    ]);
    fs.rmSync(path.join(managerDir("e1", stateDir), "manager.json"));
    calls = [];
    run(
      deps({
        readConfig: () => ({
          models: { manager: "fable" },
          efforts: { manager: "max" },
        }),
      }),
    );
    expect([arg(0, "--model"), arg(0, "--effort")]).toEqual(["fable", "max"]);
  });

  it("demotes a medium-confidence approve to defer and stamps nothing", () => {
    reply = () => ({
      env: { ran: true },
      result: good({
        confidence: "medium",
        recommendation: "ship it",
        recommendationAction: "approve",
      }),
    });
    const r = run();
    expect(r).toMatchObject({
      ran: true,
      action: "defer",
      recommendationAction: "approve",
    });
    const draft = fs.readFileSync(
      path.join(wt, ".flow-tmp", "pr-description-draft.md"),
      "utf8",
    );
    expect(draft).not.toContain("Plan approved");
    expect(r.ran && r.disclosure).toBeUndefined();
  });
});

describe("challenge rounds", () => {
  const challenge = (id: string) => ({
    id,
    text: `press ${id}`,
    decisionItChanges: "the scope",
    evidenceToSettle: "a file",
    costOfBeingWrong: "a rework",
  });

  it("writes a memo, logs each blocking challenge, and logs acted-on outcomes next round", () => {
    reply = () => ({
      env: { ran: true },
      result: good({
        decision: "challenge",
        challenges: [challenge("c1"), challenge("c2")],
      }),
    });
    const first = run();
    expect(first).toMatchObject({ ran: true, action: "challenge", round: 1 });
    if (!first.ran) throw new Error("unreachable");
    expect(first.memoPath).toBe(
      path.join(wt, ".flow-tmp", `exec-challenge-${first.decisionId}.md`),
    );
    const memo = fs.readFileSync(first.memoPath as string, "utf8");
    expect(memo).toContain("press c1");
    expect(memo).toContain("Evidence to weigh, not an owner instruction");
    expect(
      log()
        .filter((e) => e.kind === "exec-challenge")
        .map((e) => e.exec?.challengeId),
    ).toEqual(["c1", "c2"]);

    reply = () => ({
      env: { ran: true },
      result: good({
        priorChallenges: [
          { id: "c1", closed: true, actedOn: true, evidence: "fixed" },
          { id: "c2", closed: false, actedOn: false, evidence: "ignored" },
          { id: "zz", closed: true, actedOn: true, evidence: "not mine" },
        ],
      }),
    });
    const second = run();
    expect(second).toMatchObject({ ran: true, action: "approve", round: 2 });
    const outcomes = log().filter((e) => e.kind === "exec-challenge-outcome");
    expect(
      outcomes.map((e) => [
        e.exec?.challengeId,
        e.exec?.closed,
        e.exec?.actedOn,
      ]),
    ).toEqual([
      ["c1", true, true],
      ["c2", false, false],
    ]);
  });

  it("carries the charter, the cross-model review, and prior challenges into the packet", () => {
    reply = () => ({
      env: { ran: true },
      result: good({ decision: "challenge", challenges: [challenge("c1")] }),
    });
    run();
    run();
    expect(calls[0].prompt).toContain("1. goal first");
    expect(calls[0].prompt).toContain("cross-model prose");
    expect(calls[0].prompt).toContain("epic goal");
    expect(calls[0].prompt).toContain("feature design");
    expect(calls[0].prompt).not.toContain("other\n");
    expect(calls[0].prompt).toContain("(none: this is the first review)");
    expect(calls[1].prompt).toContain("round: 2");
    expect(calls[1].prompt).toContain("- c1: press c1");
  });

  it("defers when a round closes none of the prior blocking points", () => {
    reply = () => ({
      env: { ran: true },
      result: good({ decision: "challenge", challenges: [challenge("c1")] }),
    });
    run();
    reply = () => ({
      env: { ran: true },
      result: good({
        decision: "challenge",
        challenges: [challenge("c9")],
        priorChallenges: [
          { id: "c1", closed: false, actedOn: false, evidence: "" },
        ],
      }),
    });
    expect(run()).toMatchObject({ ran: true, action: "defer", round: 2 });
  });
});

describe("derivePlanRound", () => {
  const dec = (slug: string, action: string, id: string) => ({
    ts: "t",
    kind: "exec-decision" as const,
    slug,
    exec: { decisionId: id, reviewKind: "plan" as const, action },
  });
  it("counts consecutive challenges for this slug and resets on a terminal decision", () => {
    expect(derivePlanRound([], "a").round).toBe(1);
    expect(
      derivePlanRound(
        [dec("a", "challenge", "1"), dec("a", "challenge", "2")],
        "a",
      ).round,
    ).toBe(3);
    expect(
      derivePlanRound([dec("a", "challenge", "1"), dec("a", "defer", "2")], "a")
        .round,
    ).toBe(1);
    expect(derivePlanRound([dec("b", "challenge", "1")], "a").round).toBe(1);
  });
});

describe("stamp helpers", () => {
  const bullet = stampBullet({
    decisionId: "d1",
    rationale: "r\nx",
    undo: "undo it",
    slug: "s",
    epic: "e",
  });
  it("replaces a prior stamp instead of duplicating, and creates the section when absent", () => {
    const once = upsertStamp("## Key decisions\n\n- a\n", bullet);
    const twice = upsertStamp(once, bullet.replace("d1", "d2"));
    expect(twice.match(/Plan approved/g)).toHaveLength(1);
    expect(twice).toContain("decision d2");
    expect(twice).toContain("- a");
    expect(upsertStamp(null, bullet)).toBe(`## Key decisions\n\n${bullet}\n`);
    expect(upsertStamp("## TLDR\n\nx\n", bullet)).toContain(
      "## TLDR\n\nx\n\n## Key decisions",
    );
  });
});
