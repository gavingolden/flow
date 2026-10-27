import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managerDir, readManagerLog } from "./epic-manager-log";
import {
  parseManageArgs,
  runEpicManage,
  type ManageOptions,
} from "./epic-manage";
import {
  readManager,
  writeManager,
  type ManagerState,
} from "./epic-manage-state";
import { runEpicCli } from "./epic";

const SLUG = "my-epic";
const alive = { isAlive: () => true, pidStartEpoch: () => 1000 };

let tmp!: string;
let repo!: string;
let stateDir!: string;
let errors: string[];
let logs: string[];

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-manage-")));
  repo = path.join(tmp, "repo");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(repo, ".flow", "epics", SLUG), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(
    path.join(repo, ".flow", "epics", SLUG, "manifest.json"),
    JSON.stringify({
      epicId: SLUG,
      prompt: "p",
      createdAt: "2026-10-26",
      features: [
        {
          id: "alpha",
          title: "alpha",
          description: "build alpha",
          dependsOn: [],
        },
      ],
    }),
  );
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void errors.push(a.join(" ")),
  );
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void logs.push(a.join(" ")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manager(over: Partial<ManagerState> = {}): ManagerState {
  return {
    version: 1,
    epicSlug: SLUG,
    repo,
    window: `manage-${SLUG}`,
    pid: 4242,
    procStartedAt: 1000,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    pollMs: 3000,
    autonomy: "observe",
    model: "opus",
    effort: "high",
    featureFallback: {},
    status: "running",
    launching: null,
    ...over,
  };
}

function opts(over: Partial<ManageOptions> = {}): ManageOptions {
  return {
    cwd: repo,
    stateDir,
    tmuxOnPath: () => true,
    windowExists: () => false,
    liveness: alive,
    createWindow: vi.fn(() => ({ ok: true, stderr: "" })),
    readConfig: () => ({}),
    waitMs: 0,
    env: {},
    ...over,
  };
}

describe("parseManageArgs", () => {
  it("parses a slug with typed model/effort and the only autonomy", () => {
    expect(
      parseManageArgs([
        SLUG,
        "--model",
        "haiku",
        "--effort",
        "low",
        "--autonomy",
        "observe",
      ]),
    ).toEqual({
      slug: SLUG,
      model: "haiku",
      effort: "low",
      autonomy: "observe",
      foreground: false,
    });
  });

  it("recognises --foreground and --help", () => {
    expect(parseManageArgs([SLUG, "--foreground"])).toMatchObject({
      foreground: true,
    });
    expect(parseManageArgs(["--help"])).toMatchObject({ help: true });
  });

  it("refuses any autonomy but observe, naming observe as the only value", () => {
    const r = parseManageArgs([SLUG, "--autonomy", "high"]);
    expect(r).toEqual({
      error: expect.stringContaining("observe is the only supported value"),
    });
  });

  it("rejects an invalid --effort with the same message shape as flow epic launch", () => {
    const r = parseManageArgs([SLUG, "--effort", "extreme"]);
    expect(r).toEqual({ error: "" });
    expect(errors.join("\n")).toContain(
      "flow epic manage: invalid --effort value 'extreme'.",
    );
    expect(errors.join("\n")).toContain(
      "expected one of: low, medium, high, xhigh, max",
    );
  });

  it("requires exactly one slug and rejects unknown options", () => {
    expect(parseManageArgs([])).toMatchObject({
      error: expect.stringContaining("<slug>"),
    });
    expect(parseManageArgs(["a", "b"])).toMatchObject({
      error: expect.stringContaining("<slug>"),
    });
    expect(parseManageArgs([SLUG, "--bogus"])).toMatchObject({
      error: expect.stringContaining("--bogus"),
    });
  });
});

describe("runEpicManage — launcher", () => {
  it("--help prints the usage line and exits 0 without side effects", () => {
    const o = opts();
    expect(runEpicManage(["--help"], o)).toBe(0);
    expect(logs.join("\n")).toContain(
      "flow epic manage <slug> [--model <alias>] [--effort <level>] [--autonomy observe]",
    );
    expect(o.createWindow).not.toHaveBeenCalled();
  });

  it("flow epic manage dispatches through runEpicCli", () => {
    const o = opts();
    expect(runEpicCli(["manage", "--help"], o)).toBe(0);
    expect(logs.join("\n")).toContain("flow epic manage");
  });

  it("refuses without tmux using the existing named notice, opening no window", () => {
    const o = opts({ tmuxOnPath: () => false });
    expect(runEpicManage([SLUG], o)).toBe(2);
    expect(errors.join("\n")).toContain(
      "epic orchestration requires the tmux launcher — tmux is not installed or not on PATH",
    );
    expect(o.createWindow).not.toHaveBeenCalled();
  });

  it("flag validation exits 2 before any window opens", () => {
    const o = opts();
    expect(runEpicManage([SLUG, "--autonomy", "high"], o)).toBe(2);
    expect(runEpicManage([SLUG, "--model", "gpt"], o)).toBe(2);
    expect(o.createWindow).not.toHaveBeenCalled();
  });

  it("refuses a second live start naming the window and the attach command, opening no window", () => {
    writeManager(manager(), stateDir);
    const o = opts();
    expect(runEpicManage([SLUG], o)).toBe(2);
    expect(errors.join("\n")).toContain("manage-my-epic");
    expect(errors.join("\n")).toContain("flow attach manage-my-epic");
    expect(o.createWindow).not.toHaveBeenCalled();
  });

  it("refuses when window manage-<slug> already exists even without a record", () => {
    const o = opts({ windowExists: (n) => n === `manage-${SLUG}` });
    expect(runEpicManage([SLUG], o)).toBe(2);
    expect(errors.join("\n")).toContain("flow attach manage-my-epic");
    expect(o.createWindow).not.toHaveBeenCalled();
  });

  it("a crash-leftover record (dead pid) does not block a new start", async () => {
    writeManager(manager(), stateDir);
    const create = vi.fn(() => {
      writeManager(manager({ pid: 9 }), stateDir);
      return { ok: true, stderr: "" };
    });
    const alternating = {
      isAlive: (pid: number) => pid === 9,
      pidStartEpoch: () => 1000,
    };
    const o = opts({
      createWindow: create,
      liveness: alternating,
      waitMs: 1000,
    });
    expect(await runEpicManage([SLUG], o)).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("opens window manage-<slug> with the env-stripped command, forwarding FLOW_NOTIFY and typed flags", async () => {
    const create = vi.fn((_n: string, _c: string, _cmd: string[]) => {
      writeManager(manager(), stateDir);
      return { ok: true, stderr: "" };
    });
    const o = opts({
      createWindow: create,
      env: { FLOW_NOTIFY: "1" },
      waitMs: 1000,
    });
    const code = await runEpicManage(
      [SLUG, "--model", "haiku", "--effort", "low"],
      o,
    );
    expect(code).toBe(0);
    const [name, cwd, command] = create.mock.calls[0]!;
    expect(name).toBe("manage-my-epic");
    expect(cwd).toBe(repo);
    expect(command).toEqual([
      "env",
      "-u",
      "FLOW_SLUG",
      "-u",
      "FLOW_PIPELINE",
      "-u",
      "TMUX_PANE",
      "FLOW_NOTIFY=1",
      "flow",
      "epic",
      "manage",
      SLUG,
      "--foreground",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--autonomy",
      "observe",
    ]);
    expect(logs[0]).toBe("flow:manage-my-epic");
    expect(logs.join("\n")).toContain("flow attach manage-my-epic");
  });

  it("omits FLOW_NOTIFY from the window argv when it is unset", async () => {
    const create = vi.fn((_n: string, _c: string, _cmd: string[]) => {
      writeManager(manager(), stateDir);
      return { ok: true, stderr: "" };
    });
    await runEpicManage([SLUG], opts({ createWindow: create, waitMs: 1000 }));
    expect(
      create.mock.calls[0]![2].some((a) => a.startsWith("FLOW_NOTIFY")),
    ).toBe(false);
  });

  it("fails loudly when the window opens but the sequencer never reports in", async () => {
    expect(await runEpicManage([SLUG], opts({ waitMs: 0 }))).toBe(1);
    expect(errors.join("\n")).toContain("did not report in");
  });

  it("fails when the window cannot be created", async () => {
    const o = opts({
      createWindow: vi.fn(() => ({ ok: false, stderr: "no server" })),
    });
    expect(await runEpicManage([SLUG], o)).toBe(2);
    expect(errors.join("\n")).toContain("no server");
  });

  it("refuses an unreadable repository identity and a missing manifest", () => {
    expect(runEpicManage(["no-such-epic"], opts())).toBe(2);
    expect(errors.join("\n")).toContain("manifest not found");
    const notGit = path.join(tmp, "plain");
    fs.mkdirSync(notGit);
    expect(runEpicManage([SLUG], opts({ cwd: notGit }))).toBe(2);
    expect(errors.join("\n")).toContain("not inside a git repository");
  });
});

describe("runEpicManage — foreground (in-process)", () => {
  it("claims the singleton, logs started, runs the loop, and removes manager.json on stop", async () => {
    const controller = new AbortController();
    const seenDuringRun: (ManagerState | null)[] = [];
    const o = opts({
      controller,
      loopDeps: {
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "no gh" }),
        sleep: async () => {
          seenDuringRun.push(readManager(SLUG, stateDir));
          controller.abort();
        },
        write: () => {},
        headSha: async () => "abc1234",
      },
      readConfig: () => ({ models: { manager: "sonnet" } }),
    });
    const handlers = process.listeners("SIGINT");
    expect(
      await runEpicManage([SLUG, "--foreground", "--effort", "low"], o),
    ).toBe(0);
    expect(process.listeners("SIGINT")).toEqual(handlers);
    expect(seenDuringRun[0]).toMatchObject({
      epicSlug: SLUG,
      model: "sonnet",
      effort: "low",
      featureFallback: { effort: "low" },
      autonomy: "observe",
      window: "manage-my-epic",
    });
    expect(readManager(SLUG, stateDir)).toBeNull();
    const kinds = readManagerLog(SLUG, stateDir).map((e) => e.kind);
    expect(kinds[0]).toBe("started");
    expect(kinds.at(-1)).toBe("stopped");
  });

  it("a second foreground start while one is live refuses with the window and attach command", async () => {
    writeManager(manager(), stateDir);
    const o = opts({ loopDeps: { write: () => {} } });
    expect(await runEpicManage([SLUG, "--foreground"], o)).toBe(2);
    expect(errors.join("\n")).toContain("flow attach manage-my-epic");
    expect(readManager(SLUG, stateDir)?.pid).toBe(4242);
  });
});

describe("flow epic manage --foreground (HOME-isolated subprocess)", () => {
  it("exits 0 within one second of SIGINT, removes manager.json, logs stopped, and never opens tmux", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      GH_PROMPT_DISABLED: "1",
    };
    for (const k of [
      "FLOW_SLUG",
      "FLOW_PIPELINE",
      "TMUX",
      "TMUX_PANE",
      "FLOW_NOTIFY",
    ])
      delete env[k];
    const flow = path.resolve(__dirname, "..", "flow");
    const child = spawn("bun", [flow, "epic", "manage", SLUG, "--foreground"], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    const managerFile = path.join(
      managerDir(SLUG, path.join(home, ".flow", "state")),
      "manager.json",
    );
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(managerFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(managerFile), out).toBe(true);
    // Let at least one tick finish so the loop is genuinely running.
    await new Promise((r) => setTimeout(r, 500));
    const signalledAt = Date.now();
    child.kill("SIGINT");
    const code = await exited;
    expect(Date.now() - signalledAt).toBeLessThan(1000);
    expect(code, out).toBe(0);
    expect(fs.existsSync(managerFile)).toBe(false);
    const log = readManagerLog(SLUG, path.join(home, ".flow", "state")).map(
      (e) => e.kind,
    );
    expect(log[0]).toBe("started");
    expect(log.at(-1)).toBe("stopped");
    expect(log).not.toContain("launch");
  }, 20_000);
});
