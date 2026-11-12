import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendManagerLog,
  readManagerLog,
  type ManagerLogEntry,
} from "./manager-log";
import { appendNote, readNotes } from "./manager-notes";
import { isRollupExempt, logOutcome, pruneManagerHome } from "./manager-prune";
import * as grantsModule from "./manager-grants";
import { readGrants, upsertGrant } from "./manager-grants";
import { addProposal } from "./manager-proposals";
import { writeManagerRecord } from "./manager-record";
import { updateScope } from "./manager-scope";
import { writeState } from "./state";

let dir: string;
let home: string;
let stateDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mprune-"));
  home = path.join(dir, "manager");
  stateDir = path.join(dir, "state");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-08T00:00:00.000Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();
const log = (e: Partial<ManagerLogEntry> & { kind: ManagerLogEntry["kind"] }) =>
  appendManagerLog({ ts: daysAgo(1), repo: "flow", ...e }, { home });
const seed = (slug: string, phase: string, updatedAt = daysAgo(1)) =>
  writeState({ slug, phase, repo: "/r/flow", updatedAt }, stateDir);
const prune = (extra: Parameters<typeof pruneManagerHome>[1] = {}) =>
  pruneManagerHome(NOW, { home, stateDir, ...extra });
const rollups = () =>
  readManagerLog({}, home).filter((e) => e.kind === "rollup");

describe("notes", () => {
  const note = (id: string, about: string[]) =>
    appendNote({ id, ts: daysAgo(2), about, text: "t" }, home);

  it("keeps a note while any named pipeline is merged-vs-gated, drops it once all are finished or gone", () => {
    seed("w", "merged");
    seed("z", "gated");
    note("n1", ["w", "z"]);
    expect(prune().notesDropped).toBe(0);
    expect(readNotes(home)).toHaveLength(1);
    seed("z", "cancelled");
    expect(prune().notesDropped).toBe(1);
    expect(readNotes(home)).toHaveLength(0);

    seed("q", "needs-human");
    note("n2", ["q"]);
    expect(prune().notesDropped).toBe(0);
    fs.rmSync(path.join(stateDir, "q.json"));
    expect(prune().notesDropped).toBe(1);
  });

  it("keeps a note appended between the unlocked read and the notes lock", () => {
    note("old", ["gone"]);
    seed("live", "implementing");
    expect(
      prune({ beforeNotesLock: () => note("late", ["live"]) }).notesDropped,
    ).toBe(1);
    expect(readNotes(home).map((n) => n.id)).toEqual(["late"]);
  });
});

describe("log roll-up", () => {
  it("rolls entries older than 90 days into one line per month with counts by kind and outcome, leaving recent ones", () => {
    log({
      kind: "exec-decision",
      ts: daysAgo(91),
      exec: { decisionId: "a", reviewKind: "plan", action: "approve" },
    });
    log({
      kind: "exec-challenge-outcome",
      ts: daysAgo(91),
      exec: { decisionId: "a", reviewKind: "plan", actedOn: true },
    });
    log({
      kind: "exec-challenge-outcome",
      ts: daysAgo(91),
      exec: { decisionId: "a", reviewKind: "plan", actedOn: false },
    });
    log({ kind: "launch", ts: daysAgo(91) });
    log({ kind: "launch", ts: daysAgo(30) });
    const r = prune();
    expect(r).toMatchObject({ entriesRolled: 4, monthsRolled: 1 });
    const rolled = rollups();
    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toMatchObject({ repo: "flow", month: "2026-08" });
    expect(rolled[0].counts).toEqual({
      "exec-decision": { approve: 1 },
      "exec-challenge-outcome": { "acted-on": 1, "not-acted-on": 1 },
      launch: { none: 1 },
    });
    const rest = readManagerLog({}, home).filter((e) => e.kind !== "rollup");
    expect(rest.map((e) => e.ts)).toEqual([daysAgo(30)]);
  });

  it("keeps epic grants, wave decisions and a still-gated pipeline's entries verbatim; rolls repo grants; one rollup per repo and month", () => {
    seed("gated-one", "gated");
    seed("done-one", "merged");
    log({ kind: "grant", ts: daysAgo(91), scope: "epic:e", epic: "e" });
    log({
      kind: "exec-decision",
      ts: daysAgo(91),
      epic: "e",
      exec: { decisionId: "w", reviewKind: "wave", action: "reorder" },
    });
    log({
      kind: "exec-decision",
      ts: daysAgo(91),
      slug: "gated-one",
      exec: { decisionId: "p", reviewKind: "plan", action: "approve" },
    });
    log({ kind: "grant", ts: daysAgo(91), scope: "repo:flow" });
    log({
      kind: "exec-decision",
      ts: daysAgo(91),
      slug: "done-one",
      exec: { decisionId: "q", reviewKind: "plan", action: "defer" },
    });
    log({ kind: "launch", ts: daysAgo(91), repo: "econ" });
    const before = fs
      .readFileSync(path.join(home, "log.jsonl"), "utf8")
      .split("\n");
    const r = prune();
    expect(r.entriesRolled).toBe(3);
    const after = fs.readFileSync(path.join(home, "log.jsonl"), "utf8");
    for (const line of [before[0], before[1], before[2]])
      expect(after).toContain(line);
    expect(
      rollups()
        .map((e) => e.repo)
        .sort(),
    ).toEqual(["econ", "flow"]);
  });

  it("merges into an existing rollup and is a no-op when nothing is old enough", () => {
    log({ kind: "launch", ts: daysAgo(100) });
    prune();
    const first = fs.readFileSync(path.join(home, "log.jsonl"), "utf8");
    expect(prune()).toMatchObject({ entriesRolled: 0, monthsRolled: 0 });
    expect(fs.readFileSync(path.join(home, "log.jsonl"), "utf8")).toBe(first);
    log({ kind: "launch", ts: daysAgo(100) });
    prune();
    expect(rollups()).toHaveLength(1);
    expect(rollups()[0].counts).toEqual({ launch: { none: 2 } });
  });

  it("keeps an entry appended between the roll-up and the lock", () => {
    log({ kind: "launch", ts: daysAgo(100) });
    prune({
      beforeLock: () => log({ kind: "hold", ts: daysAgo(0), key: "late" }),
    });
    expect(readManagerLog({}, home).some((e) => e.key === "late")).toBe(true);
    expect(rollups()).toHaveLength(1);
  });

  it("keeps lines it cannot read verbatim", () => {
    log({ kind: "launch", ts: daysAgo(100) });
    fs.appendFileSync(path.join(home, "log.jsonl"), "not json\n");
    prune();
    expect(fs.readFileSync(path.join(home, "log.jsonl"), "utf8")).toContain(
      "not json\n",
    );
  });
});

describe("pipeline grants", () => {
  const grant = (scope: string) =>
    upsertGrant(
      {
        scope,
        classes: ["plan"],
        grantedAt: daysAgo(5),
        grantedBy: "owner-cli",
      },
      home,
    );

  it("drops a pipeline: grant whose pipeline is finished or gone, keeps live and broader ones", () => {
    seed("live", "implementing");
    seed("done", "merged");
    grant("pipeline:live");
    grant("pipeline:done");
    grant("pipeline:gone");
    grant("repo:flow");
    const r = prune();
    expect(r.grantsDropped).toBe(2);
    expect(
      readGrants(home)
        .map((g) => g.scope)
        .sort(),
    ).toEqual(["pipeline:live", "repo:flow"]);
    const withdrawn = readManagerLog({}, home).filter(
      (e) => e.kind === "grant-withdrawn" && e.reason === "pipeline-finished",
    );
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn.find((e) => e.slug === "done")?.repo).toBe("flow");
    expect(withdrawn.find((e) => e.slug === "gone")?.repo).toBe("unknown");
    expect(prune().grantsDropped).toBe(0);
  });
});

describe("grant withdrawal log failures", () => {
  it("reports a grant removed but not logged in grantLogErrors", () => {
    seed("done", "merged");
    upsertGrant(
      {
        scope: "pipeline:done",
        classes: ["plan"],
        grantedAt: daysAgo(5),
        grantedBy: "owner-cli",
      },
      home,
    );
    vi.spyOn(grantsModule, "withdrawPipelineGrant").mockReturnValue({
      removed: true,
      logError: "boom",
    });
    const r = prune();
    expect(r.grantsDropped).toBe(1);
    expect(r.grantLogErrors).toEqual(["done: boom"]);
  });
});

describe("proposals and status", () => {
  it("never touches proposals.json and rewrites status.md", () => {
    addProposal(
      {
        id: "p-0000aa",
        kind: "epic-change",
        repo: "flow",
        text: "x",
        createdAt: "t",
      },
      home,
    );
    seed("g", "gated", daysAgo(3));
    log({ kind: "launch", ts: daysAgo(100) });
    const file = path.join(home, "proposals.json");
    const bytes = fs.readFileSync(file);
    const r = prune();
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(r.openProposals).toBe(1);
    const status = fs.readFileSync(r.statusPath, "utf8");
    expect(r.statusPath).toBe(path.join(home, "status.md"));
    expect(status).toContain("| g | flow | - | gated |");
    expect(status).toContain("open proposals: 1");
  });
});

describe("helpers", () => {
  it("logOutcome prefers actedOn, then ownerReply, action, decision", () => {
    const e = (exec: ManagerLogEntry["exec"]): ManagerLogEntry => ({
      ts: "t",
      kind: "exec-decision",
      repo: "r",
      exec,
    });
    const base = { decisionId: "d", reviewKind: "plan" as const };
    expect(
      logOutcome(e({ ...base, actedOn: true, ownerReply: "accept" })),
    ).toBe("acted-on");
    expect(
      logOutcome(e({ ...base, ownerReply: "accept", action: "approve" })),
    ).toBe("accept");
    expect(logOutcome(e({ ...base, action: "approve", decision: "x" }))).toBe(
      "approve",
    );
    expect(logOutcome(e({ ...base, decision: "x" }))).toBe("x");
    expect(logOutcome({ ts: "t", kind: "launch", repo: "r" })).toBe("none");
  });

  it("isRollupExempt covers epic grants, wave decisions, rollups and unfinished slugs", () => {
    const never = () => false;
    const base = { ts: "t", repo: "r" };
    expect(
      isRollupExempt({ ...base, kind: "grant", scope: "epic:e" }, never),
    ).toBe(true);
    expect(
      isRollupExempt({ ...base, kind: "grant", scope: "repo:r" }, never),
    ).toBe(false);
    expect(isRollupExempt({ ...base, kind: "rollup" }, never)).toBe(true);
    expect(
      isRollupExempt({ ...base, kind: "launch", slug: "s" }, (s) => s === "s"),
    ).toBe(true);
    expect(isRollupExempt({ ...base, kind: "launch", slug: "s" }, never)).toBe(
      false,
    );
  });
});

describe("status through writeManagerStatus", () => {
  it("renders the full table when scope.json exists but no manager is live", () => {
    seed("mine", "implementing");
    writeState(
      {
        slug: "other",
        phase: "implementing",
        repo: "/r/else",
        updatedAt: daysAgo(1),
      },
      stateDir,
    );
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: daysAgo(1),
        source: "cli",
      }),
      home,
    );
    const status = fs.readFileSync(prune().statusPath, "utf8");
    expect(status).toContain("| mine |");
    expect(status).toContain("| other |");
  });

  it("filters to the scope while a manager record exists", () => {
    seed("mine", "implementing");
    writeState(
      {
        slug: "other",
        phase: "implementing",
        repo: "/r/else",
        updatedAt: daysAgo(1),
      },
      stateDir,
    );
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: daysAgo(1),
        source: "cli",
      }),
      home,
    );
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: daysAgo(1),
        model: "opus",
        effort: "medium",
        heartbeatSec: 900,
        stopWhenIdle: false,
        notices: false,
      },
      home,
    );
    const status = fs.readFileSync(prune().statusPath, "utf8");
    expect(status).toContain("| mine |");
    expect(status).not.toContain("| other |");
  });
});

describe("rulings and owner-words retention", () => {
  const touchAge = (file: string, days: number) => {
    const t = new Date(NOW.getTime() - days * 86_400_000);
    fs.utimesSync(file, t, t);
  };

  it("drops ruling files older than 7 days and keeps newer ones", () => {
    const dirR = path.join(home, "rulings");
    fs.mkdirSync(dirR, { recursive: true });
    fs.writeFileSync(path.join(dirR, "old.json"), "{}");
    fs.writeFileSync(path.join(dirR, "new.json"), "{}");
    touchAge(path.join(dirR, "old.json"), 8);
    touchAge(path.join(dirR, "new.json"), 6);
    expect(prune().rulingsDropped).toBe(1);
    expect(fs.readdirSync(dirR)).toEqual(["new.json"]);
  });

  it("drops owner-words lines older than 30 days and keeps the rest", () => {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "owner-words.jsonl");
    const lines = [
      JSON.stringify({ ts: daysAgo(31), text: "old" }),
      JSON.stringify({ ts: daysAgo(29), text: "fresh" }),
      "not json",
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    expect(prune().ownerWordsDropped).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${lines.slice(1).join("\n")}\n`,
    );
  });

  it("is a no-op when neither exists", () => {
    const r = prune();
    expect(r.rulingsDropped).toBe(0);
    expect(r.ownerWordsDropped).toBe(0);
  });
});
