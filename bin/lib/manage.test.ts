import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitManagerCheckIn,
  ensureManagerSettings,
  managerLaunchConsumed,
  paneShowsTrustMenu,
  parseHeartbeat,
  runManageCli,
  type ManageOptions,
} from "./manage";
import { readManagerRecord, writeManagerRecord } from "./manager-record";
import { readScope, updateScope } from "./manager-scope";
import { writeState, type PipelineState } from "./state";
import { SECRET_FILE_DENY_RULES } from "./secret-deny-rules";
import { createWindowVerified } from "./tmux";

vi.mock("./tmux", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmux")>()),
  createWindowVerified: vi.fn(),
}));

const TRUST_MENU = `Accessing workspace:

 ~/.flow/manager

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel`;
const NO_MENU_TRUST_MENU = TRUST_MENU.replace("❯ 1. Yes", "  1. Yes");

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
  killWindow: () => true,
  setPaneKind: () => {},
  retrySleepMs: 0,
  isAlive: () => true,
  readPane: () => "",
  sleep: () => {},
  checkInTimeoutMs: 3000,
  launch: (command, cwd) => {
    launches.push({ command, cwd });
    const rec = readManagerRecord(home);
    if (rec) {
      writeManagerRecord(
        { ...rec, lastSeenAt: "2026-11-12T10:00:05.000Z" },
        home,
      );
    }
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
    expect(s.permissions.deny).not.toContain("Bash(*flow-manager-ctl*)");
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

  it("clears the last session's baseline and unacked wake on a fresh launch", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "waiter-seen.json"), "{}");
    fs.writeFileSync(path.join(home, "wake.json"), "{}");
    runManageCli(["watch the flow repo"], opts());
    expect(fs.existsSync(path.join(home, "waiter-seen.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "wake.json"))).toBe(false);
  });

  it("passes --model and --effort to the launch command", () => {
    runManageCli(
      ["watch the flow repo", "--model", "sonnet", "--effort", "low"],
      opts(),
    );
    const { command } = launches[0];
    expect(command[command.indexOf("--model") + 1]).toBe("sonnet");
    expect(command[command.indexOf("--effort") + 1]).toBe("low");
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
    expect(logs.join("\n")).toContain("repo:flow — from a flag");
  });

  it("marks flag entries as such and prints words-resolved entries as from your words", () => {
    runManageCli(["watch it", "--scope", "repo:flow"], opts());
    expect(readScope(home)?.origins).toEqual({ "repo:flow": "flag" });
    updateScope(
      (cur) => ({
        ...cur!,
        scopes: ["repo:flow", "epic:e1"],
        origins: { "repo:flow": "flag", "epic:e1": "words" },
      }),
      home,
    );
    fs.rmSync(path.join(home, "manager.json"));
    logs.length = 0;
    runManageCli([], opts());
    const out = logs.join("\n");
    expect(out).toContain("repo:flow — from a flag");
    expect(out).toContain("epic:e1 — from your words");
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
    expect(out).toContain("flow grant <scope> --relay");
    expect(out.indexOf("--relay")).toBeLessThan(out.indexOf("--autonomy high"));
    expect(out).not.toContain("flow grant pipeline:alpha");
  });

  const openRecord = {
    version: 1 as const,
    window: "manager",
    startedAt: "2026-11-12T10:00:00.000Z",
    model: "opus" as const,
    effort: "high" as const,
    heartbeatSec: 900,
    stopWhenIdle: false,
    notices: false,
  };

  it("with the window open and checked in: --scope updates, --notices flips, words and bare launches point at attach", () => {
    writeManagerRecord(
      { ...openRecord, lastSeenAt: "2026-11-12T10:00:05.000Z" },
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

  it.each([
    ["bare", []],
    ["words", ["add repo b"]],
    ["--scope", ["--scope", "repo:a"]],
  ])(
    "with a never-started window open, a %s re-run says it has not started yet",
    (_n, args) => {
      writeManagerRecord(openRecord, home);
      expect(runManageCli(args, opts({ windowExists: () => true }))).toBe(2);
      const err = errs.join("\n");
      expect(err).toContain("has not started yet");
      expect(err).not.toContain("already running");
      expect(err).not.toContain("say it in the manager window");
      expect(logs).not.toContain("scope updated");
      expect(readScope(home)).toBeNull();
    },
  );

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

  it("checks in: prints manager started and exits 0 once the manager stamps lastSeenAt", () => {
    expect(runManageCli(["x"], opts())).toBe(0);
    expect(logs.join("\n")).toContain("manager started");
  });

  it("trust question: exits 2 naming the question, keeps the window and record, never says started", () => {
    const launch = () => ({
      status: "launched-not-confirmed" as const,
      stderr: "",
    });
    const code = runManageCli(
      ["x"],
      opts({ launch, readPane: () => TRUST_MENU }),
    );
    expect(code).toBe(2);
    expect(logs.join("\n")).not.toContain("manager started");
    expect(errs.join("\n")).toContain("Yes, I trust this folder");
    expect(errs.join("\n")).toContain("flow attach manager");
    expect(readManagerRecord(home)).not.toBeNull();
  });

  it("never checks in: exits 2 after the timeout, keeps the window and record", () => {
    const kill = vi.fn(() => true);
    const launch = () => ({
      status: "launched-not-confirmed" as const,
      stderr: "",
    });
    expect(runManageCli(["x"], opts({ launch, killWindow: kill }))).toBe(2);
    expect(errs.join("\n")).toContain("may still be starting");
    expect(logs.join("\n")).not.toContain("manager started");
    expect(kill).not.toHaveBeenCalled();
    expect(readManagerRecord(home)).not.toBeNull();
  });

  it("dies: exits 2 and deletes the record when claude exits before checking in", () => {
    const launch = () => ({
      status: "launched-not-confirmed" as const,
      stderr: "",
    });
    expect(runManageCli(["x"], opts({ launch, isAlive: () => false }))).toBe(2);
    expect(errs.join("\n")).toContain(
      "claude exited before the manager checked in",
    );
    expect(readManagerRecord(home)).toBeNull();
  });

  it("dies: kills the dead manager window so a remain-on-exit pane cannot wedge later runs", () => {
    const kill = vi.fn(() => true);
    const launch = () => ({
      status: "launched-not-confirmed" as const,
      stderr: "",
    });
    expect(
      runManageCli(
        ["x"],
        opts({ launch, isAlive: () => false, killWindow: kill }),
      ),
    ).toBe(2);
    expect(kill).toHaveBeenCalledWith("manager");
  });

  it("launch line: the default launch hands /flow-manage to the shared launcher as the seed and waits for the check-in once", () => {
    const create = vi.mocked(createWindowVerified);
    create.mockReturnValue({ status: "launched-not-confirmed", stderr: "" });
    const o = opts();
    delete o.launch;
    expect(runManageCli(["x"], o)).toBe(2);
    const [slug, cwd, command, seed, deps] = create.mock.calls[0];
    expect(slug).toBe("manager");
    expect(cwd).toBe(home);
    expect(command[command.indexOf("--settings") + 1]).toBe(
      path.join(dir, "settings.json"),
    );
    expect(seed).toBe("/flow-manage");
    expect(deps?.consumeAttempts).toBe(1);
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

describe("paneShowsTrustMenu (detector)", () => {
  it("is true for the trust menu capture", () => {
    expect(paneShowsTrustMenu(TRUST_MENU)).toBe(true);
    expect(paneShowsTrustMenu(NO_MENU_TRUST_MENU)).toBe(true);
  });
  it("is false for an idle prompt and for a pane echoing the start command without menu lines", () => {
    expect(paneShowsTrustMenu("❯ ")).toBe(false);
    expect(
      paneShowsTrustMenu(
        "env FLOW_MANAGER=1 claude --add-dir x /flow-manage  # trust folder project",
      ),
    ).toBe(false);
  });
});

describe("awaitManagerCheckIn", () => {
  const base = { sleep: () => {}, timeoutMs: 2000 };
  it("checks consumed before liveness and the trust menu", () => {
    expect(
      awaitManagerCheckIn({
        ...base,
        consumed: () => true,
        isAlive: () => false,
        readPane: () => TRUST_MENU,
      }),
    ).toBe("checked-in");
  });
  it("reports dead before trust-prompt, and timeout otherwise", () => {
    const common = { ...base, consumed: () => false };
    expect(
      awaitManagerCheckIn({
        ...common,
        isAlive: () => false,
        readPane: () => TRUST_MENU,
      }),
    ).toBe("dead");
    expect(
      awaitManagerCheckIn({
        ...common,
        isAlive: () => true,
        readPane: () => "",
      }),
    ).toBe("timeout");
  });
});
