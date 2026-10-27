import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./flow-exec-review";
import { writeGrant } from "./lib/epic-grant";
import { appendManagerLog, readManagerLog } from "./lib/epic-manager-log";
import { defaultExecDeps, type ExecReviewDeps } from "./lib/exec-review-shared";
import { writeState } from "./lib/state";

const CHARTER =
  "# Brief\n\n## Deciding on my behalf\n\n1. goal first\n\n### Standing corrections\n";

let root: string;
let home: string;
let stateDir: string;
let printed: string[];
let errors: string[];
let spawns: number;

function w(p: string, c: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

const deps = (): Partial<ExecReviewDeps> => ({
  ...defaultExecDeps(),
  stateDir,
  homeDir: home,
  now: () => new Date(Date.UTC(2026, 9, 26, 3, 0, 0)),
  recordEvent: () => {},
  spawnHeadless: () => {
    spawns++;
    return { ran: false, skipReason: "test" };
  },
});

const call = (args: string[]) => {
  printed = [];
  const code = run(args, deps());
  return { code, json: printed.length ? JSON.parse(printed[0]) : null };
};

function seedFeature(slug: string, epic?: { slug: string; featureId: string }) {
  writeState(
    {
      slug,
      phase: "planning",
      repo: root,
      worktree: path.join(root, slug),
      updatedAt: "2026-10-26T00:00:00.000Z",
      ...(epic ? { epic } : {}),
    },
    stateDir,
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "execcli-"));
  home = path.join(root, "home");
  stateDir = path.join(root, "state");
  spawns = 0;
  w(path.join(home, ".flow", "product.md"), CHARTER);
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void printed.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void (errors ??= []).push(a.join(" ")),
  );
  errors = [];
  w(
    path.join(root, "feat", ".flow/epics/e1/manifest.json"),
    JSON.stringify({
      epicId: "e1",
      prompt: "p",
      createdAt: "t",
      features: [{ id: "f1", title: "One", description: "d", dependsOn: [] }],
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("usage", () => {
  it("exits 2 for no subcommand, an unknown one, or missing flags", () => {
    expect(call([]).code).toBe(2);
    expect(call(["bogus"]).code).toBe(2);
    expect(call(["status"]).code).toBe(2);
    expect(call(["review", "--kind", "plan", "--epic", "e1"]).code).toBe(2);
    expect(call(["review", "--kind", "nope"]).code).toBe(2);
    expect(call(["order", "--epic", "e1"]).code).toBe(2);
    expect(
      call(["outcome", "--slug", "a", "--decision", "d", "--reply", "maybe"])
        .code,
    ).toBe(2);
    expect(call(["charter"]).code).toBe(2);
    expect(call(["stamp-check", "--slug", "a"]).code).toBe(2);
    expect(call(["status", "--slug", "a", "--wat", "x"]).code).toBe(2);
  });

  it("exits 2 for a valued flag given no value instead of silently dropping it", () => {
    expect(call(["status", "--slug", "a", "--epic"]).code).toBe(2);
    expect(call(["status", "--slug", "--epic", "e1"]).code).toBe(2);
    expect(call(["charter", "--add", "x", "--decision"]).code).toBe(2);
    expect(errors.join("\n")).toContain("--decision requires a value");
  });
});

describe("status", () => {
  it("reports each scope reason and a granted feature", () => {
    seedFeature("solo");
    seedFeature("feat", { slug: "e1", featureId: "f1" });
    seedFeature("other", { slug: "e2", featureId: "f1" });
    expect(call(["status", "--slug", "ghost"]).json).toEqual({
      granted: false,
      reason: "state-missing",
    });
    expect(call(["status", "--slug", "solo"]).json).toEqual({
      granted: false,
      reason: "not-epic",
    });
    expect(call(["status", "--slug", "feat"]).json).toEqual({
      granted: false,
      reason: "no-grant",
    });
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
    expect(call(["status", "--slug", "other", "--epic", "e1"]).json).toEqual({
      granted: false,
      reason: "other-epic",
    });
    expect(call(["status", "--slug", "feat", "--epic", "e1"]).json).toEqual({
      granted: true,
      epic: "e1",
      featureId: "f1",
    });
  });
});

describe("review", () => {
  it("prints one JSON line, exits 0, and spends nothing without a grant", () => {
    seedFeature("feat", { slug: "e1", featureId: "f1" });
    const r = call([
      "review",
      "--kind",
      "plan",
      "--epic",
      "e1",
      "--slug",
      "feat",
    ]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ran: false,
      kind: "plan",
      skipReason: "no-grant",
    });
    expect(printed).toHaveLength(1);
    expect(spawns).toBe(0);
    const wave = call([
      "review",
      "--kind",
      "wave",
      "--epic",
      "e1",
      "--repo-root",
      path.join(root, "feat"),
    ]);
    expect(wave.code).toBe(0);
    expect(wave.json).toEqual({ ran: false, skipReason: "no-grant" });
  });
});

describe("order", () => {
  it("returns the frontier in the newest applied order", () => {
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        exec: {
          decisionId: "d",
          reviewKind: "wave",
          action: "reorder",
          order: ["b", "a"],
        },
      },
      stateDir,
    );
    expect(call(["order", "--epic", "e1", "--frontier", "a,b,c"]).json).toEqual(
      { order: ["b", "a", "c"] },
    );
    expect(call(["order", "--epic", "none", "--frontier", "x,y"]).json).toEqual(
      { order: ["x", "y"] },
    );
  });
});

describe("outcome", () => {
  beforeEach(() => {
    seedFeature("feat", { slug: "e1", featureId: "f1" });
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: "plan-1", reviewKind: "plan", action: "approve" },
      },
      stateDir,
    );
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: "plan-2", reviewKind: "plan", action: "defer" },
      },
      stateDir,
    );
  });
  const reply = (decision: string, r: string) =>
    call(["outcome", "--slug", "feat", "--decision", decision, "--reply", r]);
  const lastReply = () =>
    readManagerLog("e1", stateDir)
      .filter((e) => e.kind === "exec-owner-reply")
      .at(-1);

  it("records accepted:true only for accept", () => {
    expect(reply("plan-2", "accept").json).toMatchObject({
      ok: true,
      accepted: true,
      wrongApproval: false,
    });
    expect(lastReply()?.exec).toMatchObject({
      decisionId: "plan-2",
      ownerReply: "accept",
      accepted: true,
    });
    expect(reply("plan-2", "approve").json).toMatchObject({ accepted: false });
    expect(lastReply()?.exec?.accepted).toBe(false);
    expect(lastReply()?.exec?.wrongApproval).toBeUndefined();
  });

  it("flags a redirect or cancel after an approval as a wrong approval and offers the charter line", () => {
    const r = reply("plan-1", "redirect");
    expect(r.json).toMatchObject({ ok: true, wrongApproval: true });
    expect(r.json.offer).toContain(
      "flow-exec-review charter --add --decision plan-1",
    );
    expect(lastReply()?.exec).toMatchObject({
      ownerReply: "redirect",
      wrongApproval: true,
      accepted: false,
    });
    expect(reply("plan-1", "cancel").json.wrongApproval).toBe(true);
    expect(reply("plan-1", "approve").json.wrongApproval).toBe(false);
  });

  it("does not offer for a redirect at a deferred pause", () => {
    const r = reply("plan-2", "redirect");
    expect(r.json.wrongApproval).toBe(false);
    expect(r.json.offer).toBeUndefined();
  });

  it("reports an unknown decision or a non-epic slug without writing", () => {
    expect(reply("nope", "accept").json).toEqual({
      ok: false,
      reason: "decision-not-found",
    });
    seedFeature("solo");
    expect(
      call([
        "outcome",
        "--slug",
        "solo",
        "--decision",
        "plan-1",
        "--reply",
        "accept",
      ]).json,
    ).toEqual({
      ok: false,
      reason: "not-epic",
    });
    expect(
      readManagerLog("e1", stateDir).some((e) => e.kind === "exec-owner-reply"),
    ).toBe(false);
  });
});

describe("charter", () => {
  it("adds a dated correction, with an optional decision suffix, in either flag order", () => {
    expect(call(["charter", "--add", "Never approve X"]).json).toMatchObject({
      ok: true,
    });
    expect(
      call(["charter", "--add", "--decision", "plan-1", "Never approve Y"])
        .json,
    ).toMatchObject({ ok: true });
    expect(
      call(["charter", "--add", "Z", "--decision", "plan-2"]).json,
    ).toMatchObject({ ok: true });
    const text = fs.readFileSync(
      path.join(home, ".flow", "product.md"),
      "utf8",
    );
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2}: Never approve X\n/);
    expect(text).toContain(": Never approve Y (decision plan-1)");
    expect(text).toContain(": Z (decision plan-2)");
  });

  it("accepts correction text that starts with `--`, literally or after a `--` terminator", () => {
    expect(
      call(["charter", "--add", "--linked migrations never approved"]).json,
    ).toMatchObject({ ok: true });
    expect(
      call(["charter", "--add", "--", "--max-budget-usd must not be raised"])
        .json,
    ).toMatchObject({ ok: true });
    expect(
      call(["charter", "--add", "--decision", "plan-3", "--", "--x line"]).json,
    ).toMatchObject({ ok: true });
    const text = fs.readFileSync(
      path.join(home, ".flow", "product.md"),
      "utf8",
    );
    expect(text).toContain(": --linked migrations never approved\n");
    expect(text).toContain(": --max-budget-usd must not be raised\n");
    expect(text).toContain(": --x line (decision plan-3)");
  });

  it("reports a missing section as JSON with exit 0", () => {
    w(path.join(home, ".flow", "product.md"), "# no charter\n");
    expect(call(["charter", "--add", "x"])).toEqual({
      code: 0,
      json: { ok: false, reason: "section-missing" },
    });
  });
});

describe("stamp-check", () => {
  const body = path.join(os.tmpdir(), `stamp-body-${process.pid}.md`);
  afterEach(() => fs.rmSync(body, { force: true }));

  beforeEach(() => {
    seedFeature("feat", { slug: "e1", featureId: "f1" });
  });
  const check = () =>
    call(["stamp-check", "--slug", "feat", "--body-file", body]);

  it("is ok with a null id when no approve is on record", () => {
    fs.writeFileSync(body, "nothing");
    expect(check().json).toEqual({ ok: true, decisionId: null });
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: "plan-0", reviewKind: "plan", action: "defer" },
      },
      stateDir,
    );
    expect(check().json).toEqual({ ok: true, decisionId: null });
  });

  it("fails when the PR body lacks the decision id and passes when it carries it", () => {
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: "plan-9", reviewKind: "plan", action: "approve" },
      },
      stateDir,
    );
    fs.writeFileSync(body, "## Key decisions\n\n- other\n");
    expect(check().json).toEqual({ ok: false, decisionId: "plan-9" });
    fs.writeFileSync(body, "- **Plan approved ... (decision plan-9):** why");
    expect(check().json).toEqual({ ok: true, decisionId: "plan-9" });
  });

  it("treats an unreadable body file as missing the stamp", () => {
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: "plan-9", reviewKind: "plan", action: "approve" },
      },
      stateDir,
    );
    expect(check().json).toEqual({ ok: false, decisionId: "plan-9" });
  });

  const approve = (id: string) =>
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-decision",
        slug: "feat",
        exec: { decisionId: id, reviewKind: "plan", action: "approve" },
      },
      stateDir,
    );

  it("stops demanding the stamp once the owner redirected or cancelled that approval", () => {
    fs.writeFileSync(body, "no stamp");
    approve("plan-1");
    expect(check().json).toEqual({ ok: false, decisionId: "plan-1" });
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-owner-reply",
        slug: "feat",
        exec: {
          decisionId: "plan-1",
          reviewKind: "plan",
          ownerReply: "redirect",
          wrongApproval: true,
        },
      },
      stateDir,
    );
    expect(check().json).toEqual({ ok: true, decisionId: null });
  });

  it("stops demanding the stamp when a newer plan review was skipped", () => {
    fs.writeFileSync(body, "no stamp");
    approve("plan-1");
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-skip",
        slug: "feat",
        reason: "precondition-failed",
        exec: { decisionId: "plan-2", reviewKind: "plan" },
      },
      stateDir,
    );
    expect(check().json).toEqual({ ok: true, decisionId: null });
  });

  it("still demands the stamp after an accept reply or an unrelated skip on another slug", () => {
    fs.writeFileSync(body, "no stamp");
    approve("plan-1");
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-owner-reply",
        slug: "feat",
        exec: {
          decisionId: "plan-1",
          reviewKind: "plan",
          ownerReply: "accept",
          accepted: true,
        },
      },
      stateDir,
    );
    appendManagerLog(
      "e1",
      {
        ts: "t",
        kind: "exec-skip",
        slug: "other",
        reason: "x",
        exec: { decisionId: "plan-9", reviewKind: "plan" },
      },
      stateDir,
    );
    expect(check().json).toEqual({ ok: false, decisionId: "plan-1" });
  });
});
