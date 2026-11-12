import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProposal } from "./manager-proposals";
import { upsertGrant, type GrantClass } from "./manager-grants";
import { appendManagerLog, readManagerLog } from "./manager-log";
import {
  RULING_TTL_HOURS,
  verifyRuling,
  writeRuling,
  type Ruling,
  type RulingDeps,
} from "./manager-rulings";
import { updateScope } from "./manager-scope";
import { writeState } from "./state";

const T0 = "2026-11-01T10:00:00.000Z";
const NOW = new Date("2026-11-01T11:00:00.000Z");
const SLUG = "feat";
const BENIGN_PLAN = "# Task breakdown\n\n- **Contract:**\n  - edit foo.ts\n";

let root: string;
let home: string;
let stateDir: string;
let wt: string;
let clock: Date;
let n: number;

const deps = (over: Partial<RulingDeps> = {}): RulingDeps => ({
  home,
  stateDir,
  now: () => clock,
  random: () => `a${n++}`,
  ...over,
});

function seed(phase = "plan-pending-review", at = T0, slug = SLUG) {
  writeState(
    {
      slug,
      phase,
      repo: root,
      worktree: wt,
      updatedAt: at,
      phaseLog: [{ phase, at }],
    },
    stateDir,
  );
}

function grant(classes: GrantClass[] = ["plan"], scope = `pipeline:${SLUG}`) {
  upsertGrant({ scope, classes, grantedAt: T0, grantedBy: "owner-cli" }, home);
}

function inScope(scopes = [`pipeline:${SLUG}`]) {
  updateScope(
    () => ({ version: 1, scopes, updatedAt: T0, source: "cli" }),
    home,
  );
}

function execDecision(
  action: string,
  id = "plan-1",
  ts = "2026-11-01T10:30:00.000Z",
  extra = {},
) {
  appendManagerLog(
    {
      ts,
      kind: "exec-decision",
      repo: path.basename(root),
      slug: SLUG,
      exec: { decisionId: id, reviewKind: "plan", action, ...extra },
    },
    { home },
  );
}

function typed(text: string, id = "w-1", ts = "2026-11-01T10:45:00.000Z") {
  fs.appendFileSync(
    path.join(home, "owner-words.jsonl"),
    `${JSON.stringify({ id, ts, hash: "h", text })}\n`,
  );
}

const managerApprove = (over = {}) =>
  writeRuling(
    {
      slug: SLUG,
      reply: "approve",
      reason: "ok",
      source: "manager",
      decisionId: "plan-1",
      ...over,
    },
    deps(),
  );

function written(r: ReturnType<typeof writeRuling>): Ruling {
  if (!r.ok) throw new Error(`write refused: ${r.reason}`);
  return r.ruling;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rulings-"));
  home = path.join(root, "manager");
  stateDir = path.join(root, "state");
  wt = path.join(root, "wt");
  fs.mkdirSync(path.join(wt, ".flow-tmp"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".flow-tmp", "plan.md"), BENIGN_PLAN);
  fs.mkdirSync(home, { recursive: true });
  clock = NOW;
  n = 0;
  seed();
  grant();
  inScope();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a manager approve ruling", () => {
  it("is written, logged, accepted once and then consumed", () => {
    execDecision("approve");
    const r = managerApprove();
    expect(r).toMatchObject({ ok: true });
    const ruling = written(r);
    expect(r.ok && r.message).toBe(`RULING ${ruling.id}`);
    expect(ruling.phase).toBe("plan-pending-review");
    expect(ruling.phaseEnteredAt).toBe(T0);
    expect(Date.parse(ruling.expiresAt) - Date.parse(ruling.createdAt)).toBe(
      RULING_TTL_HOURS * 3_600_000,
    );
    expect(verifyRuling(SLUG, ruling.id, deps())).toEqual({
      ok: true,
      reply: "approve",
      source: "manager",
      decisionId: "plan-1",
    });
    expect(verifyRuling(SLUG, ruling.id, deps())).toEqual({
      ok: false,
      reason: "consumed",
    });
    const kinds = readManagerLog({ slug: SLUG }, home).map((e) => e.kind);
    expect(kinds).toContain("ruling-written");
    expect(kinds).toContain("ruling-accepted");
    expect(kinds).toContain("ruling-refused");
  });

  it("is refused at write when no executive approve was logged after the phase was entered", () => {
    expect(managerApprove()).toEqual({ ok: false, reason: "no-exec-approval" });
    execDecision("approve", "plan-1", "2026-11-01T09:00:00.000Z");
    expect(managerApprove()).toEqual({ ok: false, reason: "no-exec-approval" });
    execDecision("challenge", "plan-2");
    expect(managerApprove({ decisionId: "plan-2" })).toEqual({
      ok: false,
      reason: "no-exec-approval",
    });
  });

  it("is refused when the plan names a one-way action or cannot be read", () => {
    execDecision("approve");
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "plan.md"),
      "# Task breakdown\n\n- **Contract:**\n  - run npm publish\n",
    );
    expect(managerApprove()).toEqual({ ok: false, reason: "one-way-door" });
    fs.rmSync(path.join(wt, ".flow-tmp", "plan.md"));
    expect(managerApprove()).toEqual({ ok: false, reason: "one-way-door" });
  });

  it("is refused once the daily executive budget is reached", () => {
    execDecision("approve", "plan-1", "2026-11-01T10:30:00.000Z", {
      costUsd: 25,
    });
    expect(managerApprove()).toEqual({ ok: false, reason: "budget-reached" });
  });
});

describe("a manager redirect ruling", () => {
  const redirect = (id: string) =>
    writeRuling(
      {
        slug: SLUG,
        reply: "redirect",
        text: "use the existing helper",
        reason: "memo",
        source: "manager",
        decisionId: id,
      },
      deps(),
    );

  it("cites an executive challenge, or an approve-less redirect recommendation", () => {
    execDecision("challenge", "plan-c");
    const ruling = written(redirect("plan-c"));
    expect(verifyRuling(SLUG, ruling.id, deps())).toMatchObject({
      ok: true,
      reply: "redirect",
      text: "use the existing helper",
    });
    execDecision("defer", "plan-d", undefined, {
      recommendationAction: "redirect",
    });
    expect(redirect("plan-d")).toMatchObject({ ok: true });
  });

  it("is refused without an executive decision of that kind", () => {
    execDecision("approve", "plan-a");
    expect(redirect("plan-a")).toEqual({
      ok: false,
      reason: "no-exec-approval",
    });
    expect(redirect("plan-missing")).toEqual({
      ok: false,
      reason: "no-exec-approval",
    });
  });
});

describe("binding and lifetime", () => {
  function approved(): Ruling {
    execDecision("approve");
    return written(managerApprove());
  }

  it("not-found, wrong-slug and a path-shaped id", () => {
    expect(verifyRuling(SLUG, "r-nope", deps())).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(verifyRuling(SLUG, "../grants", deps())).toEqual({
      ok: false,
      reason: "not-found",
    });
    const r = approved();
    seed("plan-pending-review", T0, "other");
    expect(verifyRuling("other", r.id, deps())).toEqual({
      ok: false,
      reason: "wrong-slug",
    });
  });

  it("stale-phase after the pipeline moved on, and after it re-entered the same phase", () => {
    const r = approved();
    seed("planning", "2026-11-01T10:50:00.000Z");
    expect(verifyRuling(SLUG, r.id, deps())).toEqual({
      ok: false,
      reason: "stale-phase",
    });
    seed("plan-pending-review", "2026-11-01T10:55:00.000Z");
    expect(verifyRuling(SLUG, r.id, deps())).toEqual({
      ok: false,
      reason: "stale-phase",
    });
  });

  it("expired after 24 hours", () => {
    const r = approved();
    clock = new Date(NOW.getTime() + RULING_TTL_HOURS * 3_600_000 + 1);
    expect(verifyRuling(SLUG, r.id, deps())).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("no-grant when the grant is withdrawn or expires before acceptance", () => {
    const r = approved();
    fs.rmSync(path.join(home, "grants.json"));
    expect(verifyRuling(SLUG, r.id, deps())).toEqual({
      ok: false,
      reason: "no-grant",
    });
  });

  it("unlogged for a ruling file written outside the writer", () => {
    execDecision("approve");
    fs.mkdirSync(path.join(home, "rulings"), { recursive: true });
    const forged: Ruling = {
      version: 1,
      id: "r-forged",
      slug: SLUG,
      repo: "x",
      phase: "plan-pending-review",
      phaseEnteredAt: T0,
      reply: "approve",
      reason: "forged",
      source: "manager",
      decisionId: "plan-1",
      createdAt: NOW.toISOString(),
      expiresAt: "2026-11-02T11:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(home, "rulings", "r-forged.json"),
      JSON.stringify(forged),
    );
    expect(verifyRuling(SLUG, "r-forged", deps())).toEqual({
      ok: false,
      reason: "unlogged",
    });
  });

  it("every refusal is logged as ruling-refused with the reason", () => {
    verifyRuling(SLUG, "r-nope", deps());
    const e = readManagerLog({ slug: SLUG }, home).find(
      (x) => x.kind === "ruling-refused",
    );
    expect(e).toMatchObject({ reason: "not-found", key: "ruling:r-nope" });
  });
});

describe("writing", () => {
  it("refuses an out-of-scope or unknown pipeline and writes nothing", () => {
    execDecision("approve");
    inScope(["pipeline:someone-else"]);
    expect(managerApprove()).toEqual({ ok: false, reason: "out-of-scope" });
    expect(managerApprove({ slug: "ghost" })).toEqual({
      ok: false,
      reason: "out-of-scope",
    });
    expect(fs.existsSync(path.join(home, "rulings"))).toBe(false);
  });

  it("refuses a manager ruling for a phase only the owner may answer", () => {
    seed("plan-pending-interview");
    expect(managerApprove()).toEqual({
      ok: false,
      reason: "source-not-allowed",
    });
  });
});

describe("a source: owner ruling", () => {
  const owner = (over = {}) =>
    writeRuling(
      {
        slug: SLUG,
        reply: "approve",
        reason: "owner said so",
        source: "owner",
        ...over,
      },
      deps(),
    );

  it("cites the typed prompt that names the slug", () => {
    typed(`yes, approve ${SLUG}`);
    const r = written(owner());
    expect(r.ownerPromptId).toBe("w-1");
    expect(verifyRuling(SLUG, r.id, deps())).toMatchObject({
      ok: true,
      source: "owner",
    });
  });

  it("resolves 'approve #3' through the printed handle", () => {
    fs.writeFileSync(
      path.join(home, "handles.json"),
      JSON.stringify({
        version: 1,
        next: 4,
        items: { [`${SLUG}:plan-pending-review`]: 3 },
      }),
    );
    typed("approve #3");
    expect(written(owner()).ownerPromptId).toBe("w-1");
    typed("approve #2", "w-2", "2026-11-01T10:50:00.000Z");
    typed("approve #9", "w-3", "2026-11-01T10:51:00.000Z");
    expect(written(owner()).ownerPromptId).toBe("w-1");
  });

  it("is refused without a matching typed prompt after the phase was entered", () => {
    expect(owner()).toEqual({ ok: false, reason: "no-owner-words" });
    typed("approve some-other-pipeline");
    expect(owner()).toEqual({ ok: false, reason: "no-owner-words" });
    typed(`approve ${SLUG}`, "w-old", "2026-11-01T09:00:00.000Z");
    expect(owner()).toEqual({ ok: false, reason: "no-owner-words" });
    typed(`approve ${SLUG}-two`, "w-long", "2026-11-01T10:46:00.000Z");
    expect(owner()).toEqual({ ok: false, reason: "no-owner-words" });
  });

  it("verification re-checks the ledger entry, so a forged prompt id is refused", () => {
    typed(`approve ${SLUG}`);
    const r = written(owner());
    fs.writeFileSync(path.join(home, "owner-words.jsonl"), "");
    expect(verifyRuling(SLUG, r.id, deps())).toEqual({
      ok: false,
      reason: "no-owner-words",
    });
  });

  it("answers an interview with the drafted text when the owner says yes to its id", () => {
    seed("plan-pending-interview");
    addProposal(
      {
        id: "p-abc123",
        kind: "interview-draft",
        repo: path.basename(root),
        slug: SLUG,
        text: "use postgres",
        createdAt: T0,
      },
      home,
    );
    typed("yes p-abc123");
    const r = owner({ reply: "answer", text: "use postgres" });
    expect(r).toMatchObject({ ok: true });
    expect(verifyRuling(SLUG, written(r).id, deps())).toMatchObject({
      ok: true,
      reply: "answer",
      text: "use postgres",
    });
  });

  it("refuses an answer whose text is not the cited proposal's drafted text", () => {
    seed("plan-pending-interview");
    addProposal(
      {
        id: "p-abc123",
        kind: "interview-draft",
        repo: path.basename(root),
        slug: SLUG,
        text: "use postgres",
        createdAt: T0,
      },
      home,
    );
    typed("yes p-abc123");
    expect(owner({ reply: "answer", text: "use mysql" })).toEqual({
      ok: false,
      reason: "owner-intent-mismatch",
    });
  });

  it("refuses an answer when the owner only mentions the pipeline", () => {
    seed("plan-pending-interview");
    typed(`${SLUG}: use postgres`);
    expect(owner({ reply: "answer", text: "use postgres" })).toEqual({
      ok: false,
      reason: "owner-intent-mismatch",
    });
  });

  it("refuses an approve when the owner only mentions the pipeline or negates it", () => {
    typed(`why is ${SLUG} stuck?`);
    expect(owner()).toEqual({ ok: false, reason: "owner-intent-mismatch" });
    typed(`don't approve ${SLUG}`, "w-2", "2026-11-01T10:46:00.000Z");
    expect(owner()).toEqual({ ok: false, reason: "owner-intent-mismatch" });
    typed(`not approved ${SLUG}`, "w-3", "2026-11-01T10:47:00.000Z");
    expect(owner()).toEqual({ ok: false, reason: "owner-intent-mismatch" });
  });

  it("picks the latest line that shows intent, not just the latest mention", () => {
    typed(`approve ${SLUG}`);
    typed(`what is ${SLUG} doing?`, "w-2", "2026-11-01T10:50:00.000Z");
    expect(written(owner()).ownerPromptId).toBe("w-1");
  });

  it("needs 'redirect' (or 'instead of'), not a bare 'change', for a redirect", () => {
    typed(`approve ${SLUG}`);
    expect(owner({ reply: "redirect", text: "use x" })).toEqual({
      ok: false,
      reason: "owner-intent-mismatch",
    });
    typed(`change ${SLUG} please`, "w-1b", "2026-11-01T10:48:00.000Z");
    expect(owner({ reply: "redirect", text: "use x" })).toEqual({
      ok: false,
      reason: "owner-intent-mismatch",
    });
    typed(`redirect ${SLUG}: use x`, "w-2", "2026-11-01T10:50:00.000Z");
    expect(
      written(owner({ reply: "redirect", text: "use x" })).ownerPromptId,
    ).toBe("w-2");
  });
});

describe("a relay-only grant", () => {
  it("accepts an owner ruling and refuses a manager ruling", () => {
    fs.rmSync(path.join(home, "grants.json"));
    grant(["relay"]);
    execDecision("approve");
    expect(managerApprove()).toEqual({ ok: false, reason: "no-grant" });
    typed(`approve ${SLUG}`);
    const r = writeRuling(
      { slug: SLUG, reply: "approve", reason: "owner", source: "owner" },
      deps(),
    );
    expect(r).toMatchObject({ ok: true });
    expect(verifyRuling(SLUG, written(r).id, deps())).toMatchObject({
      ok: true,
    });
  });
});
