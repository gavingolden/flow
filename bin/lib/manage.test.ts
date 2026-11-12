import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagerSettings,
  managerLaunchConsumed,
  parseHeartbeat,
  runManageCli,
  type ManageOptions,
} from "./manage";
import { readManagerRecord, writeManagerRecord } from "./manager-record";
import { readScope, updateScope } from "./manager-scope";
import { writeState, type PipelineState } from "./state";
import { SECRET_FILE_DENY_RULES } from "./secret-deny-rules";

let dir: string;
let home: string;
let logs: string[];
let errs: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-"));
  home = path.join(dir, "manager");
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void logs.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void errs.push(a.join(" ")),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const launches: Array<{ command: string[]; cwd: string }> = [];
const opts = (over: Partial<ManageOptions> = {}): ManageOptions => ({
  home,
  stateDir: path.join(dir, "state"),
  settingsPath: path.join(dir, "settings.json"),
  env: { PATH: "/usr/bin" },
  now: () => new Date("2026-11-12T10:00:00.000Z"),
  tmuxOnPath: () => true,
  windowExists: () => false,
  setPaneKind: () => {},
  retrySleepMs: 0,
  launch: (command, cwd) => {
    launches.push({ command, cwd });
    return { status: "started", stderr: "" };
  },
  ...over,
});
beforeEach(() => {
  launches.length = 0;
});

describe("parseHeartbeat", () => {
  it("reads seconds, minutes and hours and rejects anything under a minute", () => {
    expect(parseHeartbeat("900")).toBe(900);
    expect(parseHeartbeat("15m")).toBe(900);
    expect(parseHeartbeat("1h")).toBe(3600);
    expect(parseHeartbeat("30")).toBeNull();
    expect(parseHeartbeat("soon")).toBeNull();
  });
});

describe("ensureManagerSettings", () => {
  it("writes its own file with the three hooks and keeps the secret-file denies", () => {
    const file = ensureManagerSettings(path.join(dir, "ms.json"));
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(s.hooks.PreToolUse[0].matcher).toBe("SendMessage");
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "flow-manager-owner-words",
    );
    expect(s.hooks.Stop[0].hooks[0].command).toContain(
      "flow-manager-stop-guard",
    );
    for (const rule of SECRET_FILE_DENY_RULES)
      expect(s.permissions.deny).toContain(rule);
    expect(s.permissions.deny).toContain(
      "Edit(~/.flow/manager/owner-words.jsonl)",
    );
    expect(s.permissions.deny).not.toContain("Bash(*flow-manager-ctl ruling*)");
    expect(s.permissions.deny).toContain("Bash(*flow-exec-review ruling*)");
    expect(s.permissions.allow).not.toContain(
      "Bash(flow-exec-review ruling *)",
    );
    expect(s.permissions.allow).toContain("Bash(flow-manager-ctl *)");
  });
});

describe("runManageCli", () => {
  it("launches a fresh manager with the words as a launch focus note, pending resolve", () => {
    expect(runManageCli(["watch the flow repo"], opts())).toBe(0);
    const scope = readScope(home);
    expect(scope?.scopes).toEqual([]);
    expect(scope?.focus?.[0]).toMatchObject({
      text: "watch the flow repo",
      from: "launch",
    });
    expect(scope?.pendingResolve).toBe(true);
    expect(scope?.source).toBe("cli");
    const rec = readManagerRecord(home);
    expect(rec).toMatchObject({
      window: "manager",
      notices: false,
      startedAt: "2026-11-12T10:00:00.000Z",
    });
    const { command, cwd } = launches[0];
    expect(cwd).toBe(home);
    expect(command.slice(0, 6)).toEqual([
      "env",
      "-u",
      "FLOW_SLUG",
      "-u",
      "FLOW_PIPELINE",
      "FLOW_MANAGER=1",
    ]);
    expect(command).toContain("--name");
    expect(command[command.indexOf("--name") + 1]).toBe("manager");
    expect(command[command.indexOf("--settings") + 1]).toBe(
      path.join(dir, "settings.json"),
    );
    expect(logs.join("\n")).toContain("daily reminders are off");
  });

  it("replaces yesterday's scope when a launch carries --scope, and keeps the saved one for a bare launch", () => {
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:old"],
        updatedAt: "x",
        source: "cli",
      }),
      home,
    );
    runManageCli(["--scope", "repo:flow", "--notices"], opts());
    expect(readScope(home)?.scopes).toEqual(["repo:flow"]);
    expect(readManagerRecord(home)?.notices).toBe(true);
    fs.rmSync(path.join(home, "manager.json"));
    logs.length = 0;
    expect(runManageCli([], opts())).toBe(0);
    expect(readScope(home)?.scopes).toEqual(["repo:flow"]);
    expect(logs[0]).toContain("repo:flow");
  });

  it("refuses a bare launch with nothing saved, and refuses without tmux", () => {
    expect(runManageCli([], opts())).toBe(2);
    expect(errs.join("\n")).toContain("nothing saved");
    expect(runManageCli(["x"], opts({ tmuxOnPath: () => false }))).toBe(2);
    expect(errs.join("\n")).toContain("tmux");
    expect(launches).toEqual([]);
  });

  it("prints a grant line for each in-scope pipeline once the words are resolved", () => {
    const stateDir = path.join(dir, "state");
    const st = (slug: string): PipelineState =>
      ({
        slug,
        phase: "implementing",
        repo: "/r/flow",
        updatedAt: "2026-11-12T00:00:00.000Z",
      }) as PipelineState;
    writeState(st("alpha"), stateDir);
    runManageCli(["--scope", "repo:flow"], opts());
    const out = logs.join("\n");
    expect(out).toContain("alpha: not granted");
    expect(out).toContain("flow grant pipeline:alpha --autonomy high");
  });

  it("with the window open: --scope updates, --notices flips, words and bare launches point at attach", () => {
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: "x",
        model: "opus",
        effort: "high",
        heartbeatSec: 900,
        stopWhenIdle: false,
        notices: false,
      },
      home,
    );
    const open = opts({ windowExists: () => true });
    expect(runManageCli(["--scope", "repo:a"], open)).toBe(0);
    expect(logs).toContain("scope updated");
    expect(readScope(home)?.scopes).toEqual(["repo:a"]);
    expect(runManageCli(["--notices"], open)).toBe(0);
    expect(readManagerRecord(home)?.notices).toBe(true);
    expect(runManageCli(["add repo b"], open)).toBe(2);
    expect(errs.join("\n")).toContain(
      "say it in the manager window: flow attach manager",
    );
    expect(runManageCli([], open)).toBe(2);
    expect(errs.join("\n")).toContain("flow attach manager");
    expect(launches).toEqual([]);
  });

  it("--stop removes the record and closes the window", () => {
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: "x",
        model: "opus",
        effort: "high",
        heartbeatSec: 900,
        stopWhenIdle: false,
        notices: false,
      },
      home,
    );
    const kill = vi.fn(() => true);
    expect(runManageCli(["--stop"], opts({ killWindow: kill }))).toBe(0);
    expect(kill).toHaveBeenCalledWith("manager");
    expect(readManagerRecord(home)).toBeNull();
  });

  it("removes the record when every launch attempt fails", () => {
    const launch = vi.fn(() => ({ status: "failed" as const, stderr: "boom" }));
    expect(runManageCli(["x"], opts({ launch }))).toBe(2);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(readManagerRecord(home)).toBeNull();
  });

  it("rejects a bad heartbeat, a bad scope and two positionals", () => {
    expect(runManageCli(["--heartbeat", "5"], opts())).toBe(2);
    expect(runManageCli(["--scope", "all"], opts())).toBe(2);
    expect(runManageCli(["a", "b"], opts())).toBe(2);
  });
});

describe("managerLaunchConsumed", () => {
  it("is true only once lastSeenAt is newer than this launch", () => {
    const base = {
      version: 1 as const,
      window: "manager",
      startedAt: "2026-11-12T10:00:00.000Z",
      model: "opus" as const,
      effort: "high" as const,
      heartbeatSec: 900,
      stopWhenIdle: false,
      notices: false,
    };
    writeManagerRecord(base, home);
    expect(managerLaunchConsumed(home, base.startedAt)).toBe(false);
    writeManagerRecord(
      { ...base, lastSeenAt: "2026-11-12T09:59:00.000Z" },
      home,
    );
    expect(managerLaunchConsumed(home, base.startedAt)).toBe(false);
    writeManagerRecord(
      { ...base, lastSeenAt: "2026-11-12T10:00:05.000Z" },
      home,
    );
    expect(managerLaunchConsumed(home, base.startedAt)).toBe(true);
  });
});
