import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEpicGrant } from "./epic-grant-cli";
import { readGrant } from "./epic-grant";
import { managerDir, readManagerLog } from "./epic-manager-log";

let root: string;
let repo: string;
let stateDir: string;
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "egcli-"));
  repo = path.join(root, "repo");
  stateDir = path.join(root, "state");
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

const run = (
  args: string[],
  deps: Parameters<typeof runEpicGrant>[2] = {},
  opts: Parameters<typeof runEpicGrant>[1] = {},
) =>
  runEpicGrant(
    args,
    { cwd: repo, stateDir, ...opts },
    {
      isTTY: true,
      env: {},
      now: () => new Date("2026-10-26T01:00:00.000Z"),
      resolveRepo: () => repo,
      ...deps,
    },
  );

describe("flow epic grant", () => {
  it("writes a model-free grant and logs the merged baseline", () => {
    expect(run(["e1", "--autonomy", "high"])).toBe(0);
    expect(readGrant("e1", stateDir)).toEqual({
      version: 1,
      epic: "e1",
      classes: ["plan"],
      grantedAt: "2026-10-26T01:00:00.000Z",
      grantedBy: "owner-cli",
    });
    const log = readManagerLog("e1", stateDir);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("grant");
    expect(log[0].exec?.baselineMerged).toEqual(["f1"]);
    expect(logs.join("\n")).toContain("flow epic grant e1 --autonomy off");
    expect(logs.join("\n")).not.toMatch(/model|effort/i);
  });

  it("refuses high without a TTY and writes nothing", () => {
    expect(run(["e1", "--autonomy", "high"], { isTTY: false })).toBe(2);
    expect(errors.join("\n")).toContain(
      "plain terminal outside any Claude session",
    );
    expect(fs.existsSync(managerDir("e1", stateDir))).toBe(false);
  });

  it("refuses high inside a Claude session even with a TTY", () => {
    expect(
      run(["e1", "--autonomy", "high"], { env: { CLAUDECODE: "1" } }),
    ).toBe(2);
    expect(readGrant("e1", stateDir)).toBeNull();
    expect(fs.existsSync(managerDir("e1", stateDir))).toBe(false);
  });

  it("rejects the equals form as a usage error", () => {
    expect(run(["e1", "--autonomy=high"])).toBe(2);
    expect(readGrant("e1", stateDir)).toBeNull();
  });

  it("rejects model/effort flags, bad values, and bad slugs", () => {
    expect(run(["e1", "--autonomy", "high", "--model", "opus"])).toBe(2);
    expect(run(["e1", "--autonomy", "medium"])).toBe(2);
    expect(run(["e1"])).toBe(2);
    expect(run(["../x", "--autonomy", "high"])).toBe(2);
    expect(run(["--autonomy", "high"])).toBe(2);
  });

  it("refuses an epic without a committed manifest", () => {
    fs.rmSync(path.join(repo, ".flow"), { recursive: true });
    expect(run(["e1", "--autonomy", "high"])).toBe(2);
    expect(readGrant("e1", stateDir)).toBeNull();
  });

  it("withdraws from a non-TTY, claude-session shell and logs it", () => {
    run(["e1", "--autonomy", "high"]);
    expect(
      run(["e1", "--autonomy", "off"], {
        isTTY: false,
        env: { CLAUDECODE: "1" },
      }),
    ).toBe(0);
    expect(readGrant("e1", stateDir)).toBeNull();
    expect(readManagerLog("e1", stateDir).map((e) => e.kind)).toEqual([
      "grant",
      "grant-withdrawn",
    ]);
  });

  it("a re-grant carries the earliest baseline forward", () => {
    run(["e1", "--autonomy", "high"]);
    run(["e1", "--autonomy", "off"]);
    writeEpic(["f1", "f2"]);
    run(["e1", "--autonomy", "high"]);
    const grants = readManagerLog("e1", stateDir).filter(
      (e) => e.kind === "grant",
    );
    expect(grants).toHaveLength(2);
    expect(grants[1].exec?.baselineMerged).toEqual(["f1"]);
  });
});
