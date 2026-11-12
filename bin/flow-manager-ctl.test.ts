import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./flow-manager-ctl";
import { upsertGrant } from "./lib/manager-grants";
import { appendManagerLog, readManagerLog } from "./lib/manager-log";
import { addProposal } from "./lib/manager-proposals";
import { readManagerRecord, writeManagerRecord } from "./lib/manager-record";
import { readScope, updateScope } from "./lib/manager-scope";
import { writeState, type PipelineState } from "./lib/state";

let dir: string;
let home: string;
let stateDir: string;
const NOW = new Date("2026-11-12T10:00:00.000Z");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mctl-"));
  home = path.join(dir, "manager");
  stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (slug: string, repo: string, phase = "gated") =>
  writeState(
    {
      slug,
      phase,
      repo,
      updatedAt: NOW.toISOString(),
      phaseLog: [{ phase, at: NOW.toISOString() }],
    } as PipelineState,
    stateDir,
  );
const scopeTo = (...scopes: string[]) =>
  updateScope(
    () => ({ version: 1, scopes, updatedAt: NOW.toISOString(), source: "cli" }),
    home,
  );
async function ctl(...argv: string[]) {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await run(argv, {
    home,
    stateDir,
    now: () => NOW,
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    out: (s) => lines.push(s),
    err: (s) => errs.push(s),
  });
  return { code, out: lines.join("\n"), err: errs.join("\n") };
}

describe("brief", () => {
  it("exits 3 with no content for an out-of-scope slug", async () => {
    put("mine", "/r/flow");
    put("theirs", "/r/other");
    scopeTo("repo:flow");
    const r = await ctl("brief", "--slug", "theirs");
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toEqual({ ok: false, reason: "out-of-scope" });
    const ok = await ctl("brief", "--slug", "mine");
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({
      ok: true,
      slug: "mine",
      pauseMissing: true,
    });
  });
});

describe("scope", () => {
  it("add --focus --resolved changes entries, focus and pendingResolve in one write", async () => {
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: NOW.toISOString(),
        source: "cli",
        focus: [
          {
            id: "launch-1",
            text: "cover the flow repo",
            at: NOW.toISOString(),
            from: "launch",
          },
        ],
        pendingResolve: true,
      }),
      home,
    );
    const r = await ctl(
      "scope",
      "add",
      "--scope",
      "repo:other",
      "--focus",
      "watch the migration",
      "--resolved",
    );
    expect(r.code).toBe(0);
    const file = readScope(home);
    expect(file?.scopes).toEqual(["repo:flow", "repo:other"]);
    expect(file?.focus?.map((f) => f.text)).toEqual([
      "cover the flow repo",
      "watch the migration",
    ]);
    expect(file?.pendingResolve).toBeUndefined();
    expect(file?.source).toBe("owner-words");
    expect(JSON.parse(r.out).scopes).toEqual([
      { scope: "repo:flow", origin: "flag" },
      { scope: "repo:other", origin: "words" },
    ]);
    expect(file?.origins).toEqual({
      "repo:flow": "flag",
      "repo:other": "words",
    });
  });

  it("set marks the named entries as words, and remove drops an entry's origin", async () => {
    await ctl("scope", "set", "--scope", "repo:a", "--scope", "epic:e1");
    await ctl("scope", "remove", "--scope", "epic:e1");
    expect(readScope(home)?.origins).toEqual({ "repo:a": "words" });
    const shown = JSON.parse((await ctl("scope", "show")).out);
    expect(shown.scopes).toEqual([{ scope: "repo:a", origin: "words" }]);
  });

  it("drops a focus note by id and rejects a malformed scope", async () => {
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: NOW.toISOString(),
        source: "cli",
        focus: [
          { id: "f-1", text: "x", at: NOW.toISOString(), from: "launch" },
        ],
      }),
      home,
    );
    await ctl("scope", "remove", "--drop-focus", "f-1");
    expect(readScope(home)?.focus).toBeUndefined();
    const bad = await ctl("scope", "add", "--scope", "all");
    expect(bad.code).toBe(2);
  });

  it("show lists each in-scope pipeline's grant status, keeps pending launch words and stamps lastSeenAt", async () => {
    put("mine", "/r/flow");
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: NOW.toISOString(),
        source: "cli",
        focus: [
          {
            id: "l",
            text: "watch flow",
            at: NOW.toISOString(),
            from: "launch",
          },
        ],
        pendingResolve: true,
      }),
      home,
    );
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: "2026-11-12T09:00:00.000Z",
        model: "opus",
        effort: "high",
        heartbeatSec: 900,
        stopWhenIdle: false,
        notices: false,
      },
      home,
    );
    const r = JSON.parse((await ctl("scope", "show")).out);
    expect(r.pipelines).toEqual([
      { slug: "mine", phase: "gated", granted: false },
    ]);
    expect(r.pendingLaunchWords).toEqual(["watch flow"]);
    expect(readManagerRecord(home)?.lastSeenAt).toBe(NOW.toISOString());
  });

  it("candidates carry slug, repo and epic only", async () => {
    put("mine", "/r/flow", "plan-pending-review");
    const r = await ctl("scope", "candidates");
    expect(r.out).toBe("mine\tflow\t-");
    expect(r.out).not.toContain("plan-pending");
  });
});

describe("digest, log and proposals", () => {
  it("digest ignores decisions about out-of-scope pipelines", async () => {
    put("mine", "/r/flow");
    put("theirs", "/r/other");
    scopeTo("repo:flow");
    expect(
      (
        await ctl(
          "log",
          "--kind",
          "manager-decision",
          "--slug",
          "mine",
          "--reason",
          "nudged",
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await ctl(
          "log",
          "--kind",
          "manager-decision",
          "--slug",
          "theirs",
          "--reason",
          "x",
        )
      ).code,
    ).toBe(3);
    const d = await ctl("digest", "--mark-seen");
    expect(d.out).toContain("1 decisions made for you");
    expect(readManagerLog({}, home)).toHaveLength(1);
    expect((await ctl("digest")).out).toContain("0 decisions made for you");
  });

  it("lists only proposals whose slug or epic is in scope", async () => {
    put("mine", "/r/flow");
    put("theirs", "/r/other");
    scopeTo("repo:flow");
    const base = {
      kind: "stale-cancel" as const,
      text: "t",
      createdAt: NOW.toISOString(),
    };
    addProposal({ ...base, id: "p1", repo: "flow", slug: "mine" }, home);
    addProposal({ ...base, id: "p2", repo: "other", slug: "theirs" }, home);
    const r = JSON.parse((await ctl("proposal", "list")).out);
    expect(r.map((x: { id: string }) => x.id)).toEqual(["p1"]);
    expect(
      (await ctl("proposal", "answer", "p2", "--answer", "yes")).code,
    ).toBe(3);
    expect(
      (await ctl("proposal", "answer", "p1", "--answer", "yes")).code,
    ).toBe(0);
  });

  it("adds a proposal for an in-scope slug and logs it", async () => {
    put("mine", "/r/flow");
    scopeTo("repo:flow");
    const r = await ctl(
      "proposal",
      "add",
      "--kind",
      "stale-cancel",
      "--text",
      "cancel it?",
      "--slug",
      "mine",
    );
    expect(r.code).toBe(0);
    expect(readManagerLog({}, home).map((e) => e.kind)).toEqual([
      "proposal-added",
    ]);
  });

  it("rejects an unknown verb", async () => {
    expect((await ctl("bogus")).code).toBe(2);
  });
});

describe("ruling write", () => {
  const W = "2026-11-12T09:00:00.000Z";
  function paused() {
    const wt = path.join(dir, "wt");
    fs.mkdirSync(path.join(wt, ".flow-tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "plan.md"),
      "# Task breakdown\n\n- **Contract:**\n  - edit x\n",
    );
    writeState(
      {
        slug: "mine",
        phase: "plan-pending-review",
        repo: "/r/flow",
        worktree: wt,
        updatedAt: W,
        phaseLog: [{ phase: "plan-pending-review", at: W }],
      } as PipelineState,
      stateDir,
    );
    upsertGrant(
      {
        scope: "pipeline:mine",
        classes: ["plan"],
        grantedAt: W,
        grantedBy: "owner-cli",
      },
      home,
    );
    appendManagerLog(
      {
        ts: "2026-11-12T09:30:00.000Z",
        kind: "exec-decision",
        repo: "flow",
        slug: "mine",
        exec: { decisionId: "plan-1", reviewKind: "plan", action: "approve" },
      },
      { home },
    );
  }
  const write = (...extra: string[]) =>
    ctl(
      "ruling",
      "write",
      "--slug",
      "mine",
      "--reply",
      "approve",
      "--source",
      "manager",
      "--reason",
      "executive approved",
      ...extra,
    );

  it("writes a ruling for an in-scope pipeline and prints the RULING message to send", async () => {
    paused();
    scopeTo("pipeline:mine");
    const r = await write("--decision", "plan-1");
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o).toMatchObject({ ok: true });
    expect(o.message).toBe(`RULING ${o.id}`);
    expect(fs.existsSync(path.join(home, "rulings", `${o.id}.json`))).toBe(
      true,
    );
    expect(
      readManagerLog({ slug: "mine" }, home).some(
        (e) => e.kind === "ruling-written" && e.key === `ruling:${o.id}`,
      ),
    ).toBe(true);
  });

  it("refuses an out-of-scope slug with exit 3 and writes nothing", async () => {
    paused();
    scopeTo("pipeline:someone-else");
    const r = await write("--decision", "plan-1");
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toEqual({ ok: false, reason: "out-of-scope" });
    expect(fs.existsSync(path.join(home, "rulings"))).toBe(false);
  });

  it("passes a writer refusal through (no executive approve named)", async () => {
    paused();
    scopeTo("pipeline:mine");
    const r = await write();
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      reason: "no-exec-approval",
    });
  });

  it("exits 2 on missing or invalid arguments, and a redirect needs --text", async () => {
    expect((await ctl("ruling", "write", "--slug", "mine")).code).toBe(2);
    expect((await ctl("ruling")).code).toBe(2);
    const r = await ctl(
      "ruling",
      "write",
      "--slug",
      "mine",
      "--reply",
      "redirect",
      "--source",
      "manager",
      "--reason",
      "memo",
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs --text");
  });
});
