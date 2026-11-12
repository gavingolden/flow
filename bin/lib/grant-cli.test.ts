import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEpicCli } from "./epic";
import { parseExpires, runGrantCli, type GrantCliDeps } from "./grant-cli";
import { readGrants, upsertGrant } from "./manager-grants";
import { readManagerLog } from "./manager-log";
import { writeState } from "./state";

let root: string;
let repo: string;
let stateDir: string;
let home: string;
let errors: string[];
let logs: string[];

function writeEpic(merged: string[]) {
  const d = path.join(repo, ".flow/epics/e1");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "manifest.json"),
    JSON.stringify({
      epicId: "e1",
      prompt: "p",
      createdAt: "2026-10-26T00:00:00.000Z",
      features: [
        { id: "f1", title: "t", description: "d", dependsOn: [] },
        { id: "f2", title: "t", description: "d", dependsOn: [] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(d, "status.json"),
    JSON.stringify({
      version: 1,
      epicId: "e1",
      features: Object.fromEntries(
        ["f1", "f2"].map((id) => [
          id,
          { status: merged.includes(id) ? "merged" : "not-started" },
        ]),
      ),
    }),
  );
}

function seed(slug: string, epic?: { slug: string; featureId: string }) {
  writeState(
    {
      slug,
      phase: "planning",
      repo,
      updatedAt: "2026-10-26T00:00:00.000Z",
      ...(epic ? { epic } : {}),
    },
    stateDir,
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "grantcli-"));
  repo = path.join(root, "flow");
  stateDir = path.join(root, "state");
  home = path.join(root, "manager");
  fs.mkdirSync(repo, { recursive: true });
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a) => {
    errors.push(a.join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
  writeEpic(["f1"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-10-26T01:00:00.000Z");
const run = (args: string[], deps: GrantCliDeps = {}) =>
  runGrantCli(args, {
    isTTY: true,
    env: {},
    now: () => NOW,
    cwd: repo,
    stateDir,
    home,
    resolveRepo: () => repo,
    ...deps,
  });
const grants = () => readGrants(home);

describe("flow grant --autonomy high", () => {
  it("writes one repo: entry with plan class and an expiry 7 days out", () => {
    expect(run(["repo:flow", "--autonomy", "high", "--expires", "7d"])).toBe(0);
    expect(grants()).toEqual([
      {
        scope: "repo:flow",
        classes: ["plan", "relay"],
        grantedAt: "2026-10-26T01:00:00.000Z",
        expiresAt: "2026-11-02T01:00:00.000Z",
        grantedBy: "owner-cli",
      },
    ]);
    const log = readManagerLog({ repo: "flow" }, home);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "grant",
      scope: "repo:flow",
      repo: "flow",
    });
    expect(logs.join("\n")).toContain("flow grant repo:flow --autonomy off");
  });

  it("an epic: grant logs the merged baseline and prints what it allows", () => {
    expect(run(["epic:e1", "--autonomy", "high"])).toBe(0);
    expect(grants()[0].scope).toBe("epic:e1");
    const log = readManagerLog({ epic: "e1" }, home);
    expect(log[0].exec?.baselineMerged).toEqual(["f1"]);
    expect(log[0].repo).toBe("flow");
    const out = logs.join("\n");
    expect(out).toMatch(/reorder unstarted epic features/);
    expect(out).not.toMatch(/model|effort/i);
  });

  it("prints the reorder allowance for repo: but not for pipeline:", () => {
    seed("solo");
    expect(run(["repo:flow", "--autonomy", "high"])).toBe(0);
    expect(logs.join("\n")).toMatch(/reorder unstarted epic features/);
    logs.length = 0;
    expect(run(["pipeline:solo", "--autonomy", "high"])).toBe(0);
    expect(logs.join("\n")).not.toMatch(/reorder/);
  });

  it("--delegate-ui adds the subjective class", () => {
    seed("solo");
    expect(run(["pipeline:solo", "--autonomy", "high", "--delegate-ui"])).toBe(
      0,
    );
    expect(grants()[0].classes).toEqual(["plan", "relay", "subjective"]);
    const out = logs.join("\n");
    expect(out).toContain(
      "recorded, but inactive — delegated UI sign-off is parked, so UI taste items stay with you.",
    );
    expect(out).not.toContain("takes effect");
  });

  it("refuses without a TTY and writes nothing", () => {
    expect(run(["repo:flow", "--autonomy", "high"], { isTTY: false })).toBe(2);
    expect(errors.join("\n")).toContain(
      "plain terminal outside any Claude session",
    );
    expect(fs.existsSync(home)).toBe(false);
  });

  it("refuses inside a Claude session even with a TTY and leaves an existing file unchanged", () => {
    upsertGrant(
      {
        scope: "repo:flow",
        classes: ["plan"],
        grantedAt: "t",
        grantedBy: "owner-cli",
      },
      home,
    );
    const before = fs.readFileSync(path.join(home, "grants.json"), "utf8");
    expect(
      run(["repo:flow", "--autonomy", "high", "--expires", "1d"], {
        env: { CLAUDECODE: "1" },
      }),
    ).toBe(2);
    expect(fs.readFileSync(path.join(home, "grants.json"), "utf8")).toBe(
      before,
    );
  });

  it("rejects the equals form, unknown options and bad values", () => {
    expect(run(["repo:flow", "--autonomy=high"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "high", "--model", "opus"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "medium"])).toBe(2);
    expect(run(["repo:flow"])).toBe(2);
    expect(run(["--autonomy", "high"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "high", "--expires", "7"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "high", "--expires=7d"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "high", "--expires"])).toBe(2);
    expect(run(["repo:flow", "--expires", "--autonomy", "high"])).toBe(2);
    expect(grants()).toEqual([]);
  });

  it("refuses the all scope and names the three allowed kinds", () => {
    expect(run(["all", "--autonomy", "high"])).toBe(2);
    expect(errors.join("\n")).toContain(
      "pipeline:<slug>, epic:<slug> or repo:<name>",
    );
    expect(grants()).toEqual([]);
  });

  it("refuses a pipeline: with no state file and an epic: with no manifest anywhere", () => {
    expect(run(["pipeline:ghost", "--autonomy", "high"])).toBe(2);
    fs.rmSync(path.join(repo, ".flow"), { recursive: true });
    expect(run(["epic:e1", "--autonomy", "high"])).toBe(2);
    expect(grants()).toEqual([]);
  });

  it("finds an epic's manifest through a state file when run from another directory", () => {
    seed("feat", { slug: "e1", featureId: "f1" });
    expect(
      run(["epic:e1", "--autonomy", "high"], { resolveRepo: () => null }),
    ).toBe(0);
    expect(readManagerLog({ epic: "e1" }, home)[0].repo).toBe("flow");
  });

  it("warns about an unknown repo: name but still writes the grant", () => {
    seed("solo");
    expect(run(["repo:flwo", "--autonomy", "high"])).toBe(0);
    expect(logs.join("\n")).toMatch(/Warning: .*flwo.*known repos: flow/);
    expect(grants()[0].scope).toBe("repo:flwo");
  });

  it("warns when two different checkouts share the repo name", () => {
    const other = path.join(root, "forks", "flow");
    for (const d of [repo, other]) {
      fs.mkdirSync(d, { recursive: true });
      spawnSync("git", ["init", "-q", d]);
    }
    seed("a");
    writeState(
      {
        slug: "b",
        phase: "planning",
        repo: other,
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
      stateDir,
    );
    expect(run(["repo:flow", "--autonomy", "high"])).toBe(0);
    expect(logs.join("\n")).toContain("more than one checkout is named 'flow'");
  });

  it("a re-grant carries the earliest baseline forward", () => {
    run(["epic:e1", "--autonomy", "high"]);
    run(["epic:e1", "--autonomy", "off"]);
    writeEpic(["f1", "f2"]);
    run(["epic:e1", "--autonomy", "high"]);
    const g = readManagerLog({ epic: "e1" }, home).filter(
      (e) => e.kind === "grant",
    );
    expect(g).toHaveLength(2);
    expect(g[1].exec?.baselineMerged).toEqual(["f1"]);
  });
});

describe("flow grant --relay", () => {
  it("writes a relay-only grant, logs it without a wave baseline, and says it does not switch on the executive", () => {
    expect(run(["epic:e1", "--relay", "--expires", "7d"])).toBe(0);
    expect(grants()).toEqual([
      {
        scope: "epic:e1",
        classes: ["relay"],
        grantedAt: "2026-10-26T01:00:00.000Z",
        expiresAt: "2026-11-02T01:00:00.000Z",
        grantedBy: "owner-cli",
      },
    ]);
    const line = readManagerLog({ epic: "e1" }, home)[0];
    expect(line).toMatchObject({ kind: "grant", reason: "owner-cli-relay" });
    expect(line.exec).toBeUndefined();
    expect(logs.join("\n")).toContain("does not switch on the executive");
  });

  it("is refused without a TTY or inside a Claude session and writes nothing", () => {
    expect(run(["repo:flow", "--relay"], { isTTY: false })).toBe(2);
    expect(run(["repo:flow", "--relay"], { env: { CLAUDECODE: "1" } })).toBe(2);
    expect(grants()).toEqual([]);
  });

  it("stands alone: refused with --autonomy or --delegate-ui", () => {
    expect(run(["repo:flow", "--relay", "--autonomy", "high"])).toBe(2);
    expect(run(["repo:flow", "--relay", "--delegate-ui"])).toBe(2);
    expect(grants()).toEqual([]);
  });

  it("--list names a relay-only grant as relaying answers, not approving plans", () => {
    expect(run(["repo:flow", "--relay"])).toBe(0);
    logs = [];
    expect(run(["--list"])).toBe(0);
    expect(logs.join("\n")).toContain("relays your answers");
    expect(logs.join("\n")).not.toContain("approves plans");
  });
});

describe("flow grant --autonomy off", () => {
  it("withdraws from a non-TTY, claude-session shell and logs it with scope and repo", () => {
    run(["epic:e1", "--autonomy", "high"]);
    expect(
      run(["epic:e1", "--autonomy", "off"], {
        isTTY: false,
        env: { CLAUDECODE: "1" },
      }),
    ).toBe(0);
    expect(grants()).toEqual([]);
    const log = readManagerLog({ epic: "e1" }, home);
    expect(log.map((e) => e.kind)).toEqual(["grant", "grant-withdrawn"]);
    expect(log[1]).toMatchObject({ scope: "epic:e1", repo: "flow" });
  });

  it("is refused with --delegate-ui or --expires", () => {
    expect(run(["repo:flow", "--autonomy", "off", "--delegate-ui"])).toBe(2);
    expect(run(["repo:flow", "--autonomy", "off", "--expires", "1d"])).toBe(2);
  });

  it("names a broader live grant that still covers the scope, with its withdraw command", () => {
    seed("solo");
    run(["repo:flow", "--autonomy", "high"]);
    run(["pipeline:solo", "--autonomy", "high"]);
    logs.length = 0;
    expect(run(["pipeline:solo", "--autonomy", "off"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(
      "Still covered by repo:flow: withdraw it with: flow grant repo:flow --autonomy off",
    );
    expect(out).toContain("still approved under repo:flow");
    expect(out).not.toContain("pause for your approval again");
    expect(grants().map((g) => g.scope)).toEqual(["repo:flow"]);
  });

  it("names the broader repo: grant when withdrawing an epic grant that has no state files yet", () => {
    run(["repo:flow", "--autonomy", "high"]);
    run(["epic:e1", "--autonomy", "high"]);
    logs.length = 0;
    expect(run(["epic:e1", "--autonomy", "off"])).toBe(0);
    expect(logs.join("\n")).toContain("Still covered by repo:flow");
  });

  it("says so when nothing was on file", () => {
    expect(run(["repo:flow", "--autonomy", "off"])).toBe(0);
    expect(logs.join("\n")).toContain("No grant was on file");
  });
});

describe("bin/flow wiring", () => {
  it("routes grant and refuses a non-TTY high grant without writing", () => {
    const r = spawnSync(
      "bun",
      [
        path.resolve(__dirname, "..", "flow"),
        "grant",
        "repo:flow",
        "--autonomy",
        "high",
      ],
      { env: { ...process.env, HOME: root, CLAUDECODE: "" }, input: "" },
    );
    expect(r.status).toBe(2);
    expect(
      fs.existsSync(path.join(root, ".flow", "manager", "grants.json")),
    ).toBe(false);
  });

  it("ships the manager helpers executable", () => {
    for (const f of ["flow-manager-note.ts", "flow-manager-prune.ts"]) {
      expect(
        fs.statSync(path.resolve(__dirname, "..", f)).mode & 0o111,
      ).not.toBe(0);
    }
  });
});

describe("flow grant --list", () => {
  it("prints live grants, then expired ones under an expired label", () => {
    upsertGrant(
      {
        scope: "repo:flow",
        classes: ["plan"],
        grantedAt: "t",
        expiresAt: "2026-10-25T00:00:00.000Z",
        grantedBy: "owner-cli",
      },
      home,
    );
    upsertGrant(
      {
        scope: "epic:e1",
        classes: ["plan"],
        grantedAt: "t",
        grantedBy: "owner-cli",
      },
      home,
    );
    expect(run(["--list"], { isTTY: false, env: { CLAUDECODE: "1" } })).toBe(0);
    const out = logs.join("\n");
    const liveAt = out.indexOf("epic:e1");
    const expiredLabel = out.indexOf("Expired:");
    const expiredAt = out.indexOf("repo:flow");
    expect(liveAt).toBeGreaterThan(-1);
    expect(expiredLabel).toBeGreaterThan(liveAt);
    expect(expiredAt).toBeGreaterThan(expiredLabel);
    expect(out).toContain("approves plans");
    expect(out).not.toContain("classes:");
  });

  it("takes no other arguments", () => {
    expect(run(["--list", "repo:flow"])).toBe(2);
  });
});

describe("flow epic grant alias", () => {
  it("withdraws exactly as flow grant epic:<slug> does", async () => {
    run(["epic:e1", "--autonomy", "high"]);
    const code = await runEpicCli(["grant", "e1", "--autonomy", "off"], {
      cwd: repo,
      stateDir,
      managerHome: home,
    });
    expect(code).toBe(0);
    expect(grants()).toEqual([]);
    expect(readManagerLog({ epic: "e1" }, home).at(-1)).toMatchObject({
      kind: "grant-withdrawn",
      scope: "epic:e1",
    });
  });
});

describe("parseExpires", () => {
  it("parses hours, days and weeks and refuses everything else", () => {
    expect(parseExpires("12h")).toBe(12 * 3_600_000);
    expect(parseExpires("7d")).toBe(7 * 86_400_000);
    expect(parseExpires("2w")).toBe(2 * 604_800_000);
    for (const bad of ["0d", "7", "d", "7m", "-1d", "1.5d", ""]) {
      expect(parseExpires(bad)).toBeNull();
    }
  });
});
