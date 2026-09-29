import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserTeardownMock = vi.hoisted(() => ({
  buildDefaultDeps: vi.fn(() => ({
    listProcs: () => [] as unknown[],
    kill: vi.fn(),
    alive: () => false,
    sleepMs: () => {},
    env: {} as NodeJS.ProcessEnv,
    selfPid: 1,
    homeDir: "/home/test",
    tmpDir: "/tmp",
    nowMs: () => 0,
    selfPgid: 4242,
    groupMembers: () => null,
  })),
  runOrphanSweep: vi.fn((_deps: unknown, _opts: { yes: boolean }) => ({
    ran: true,
    found: [] as unknown[],
    foundServers: [] as unknown[],
    signalled: [] as number[],
  })),
}));
vi.mock("../flow-browser-teardown", () => browserTeardownMock);

// Poison the frozen-at-import defaults: a probe that dropped a `deps` path and
// fell back to one of these would write into a directory the test can observe.
const POISON = vi.hoisted(
  () => `${process.env.TMPDIR ?? "/tmp"}/flow-doctor-poison-${process.pid}`,
);
vi.mock("./paths", async (orig) => ({
  ...(await orig<typeof import("./paths")>()),
  FLOW_STATE_DIR: `${POISON}/state`,
  FLOW_MANIFEST: `${POISON}/installed.json`,
}));

import { runDoctorCli } from "./doctor-cli";
import type { DoctorDeps, DoctorReport } from "./doctor";
import { makeDeps, scriptedRun } from "./doctor-test-deps";
import { appendRow } from "./proc-registry";
import { writeState, type PipelineState } from "./state";

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cli-")));
  out = [];
  err = [];
  // vitest runs under Node, where the `Bun` global the liveness probe shells
  // through does not exist; every pid reads as absent.
  vi.stubGlobal("Bun", {
    spawnSync: () => ({ exitCode: 1, stdout: Buffer.from("") }),
  });
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void out.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void err.push(a.join(" ")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A clean install: a flow checkout with one registered helper and the wrapper,
 * both symlinked into the bin dir and listed in the install record. */
function healthyDeps(): DoctorDeps {
  const deps = makeDeps(root, {
    run: scriptedRun((cmd, args) => {
      if (cmd === "gh" || cmd === "claude") return { status: 0, stdout: "ok" };
      if (cmd === "git" && args.includes("worktree"))
        return { status: 0, stdout: "" };
      return undefined;
    }),
  });
  fs.mkdirSync(path.join(deps.installRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(deps.installRoot, "package.json"),
    '{"dependencies":{}}',
  );
  fs.mkdirSync(deps.reapBaseDir!, { recursive: true });
  appendRow(
    {
      pgid: 999_999,
      pid: 999_999,
      startEpoch: 1,
      slug: "old-run",
      class: "default",
      argv: ["node"],
      recordedAt: 0,
      sessionPid: 999_998,
      sessionStartEpoch: 1,
    },
    deps.reapBaseDir!,
  );
  writeState(
    {
      slug: "old-run",
      phase: "epic-approved",
      repo: root,
      pid: 999_997,
      procStartedAt: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as PipelineState,
    deps.stateDir,
  );
  fs.mkdirSync(deps.targets.binDir, { recursive: true });
  const symlinks = [
    ["flow", "flow"],
    ["flow-pre-commit.ts", "flow-pre-commit"],
  ].map(([file, name]) => {
    const source = path.join(deps.installRoot, "bin", file);
    fs.writeFileSync(source, "");
    const target = path.join(deps.targets.binDir, name);
    fs.symlinkSync(source, target);
    return { source, target, kind: "bin" };
  });
  fs.mkdirSync(path.dirname(deps.manifestPath), { recursive: true });
  fs.writeFileSync(deps.manifestPath, JSON.stringify({ version: 1, symlinks }));
  return deps;
}

function snapshot(dir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  const walk = (p: string): void => {
    const st = fs.lstatSync(p);
    const digest = st.isFile()
      ? createHash("sha1").update(fs.readFileSync(p)).digest("hex")
      : st.isSymbolicLink()
        ? fs.readlinkSync(p)
        : "dir";
    snap[p] = `${digest}@${st.mtimeMs}`;
    if (st.isDirectory())
      for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(dir);
  return snap;
}

const jsonReport = (): DoctorReport => JSON.parse(out.join("\n"));

describe("runDoctorCli arguments", () => {
  it("prints help and returns 0 for --help / -h", async () => {
    for (const flag of ["--help", "-h"]) {
      out = [];
      expect(await runDoctorCli([flag], { probes: [] })).toBe(0);
      expect(out.join("\n")).toMatch(/^flow doctor/);
    }
  });

  it("returns 2 and prints usage to stderr on an unknown flag", async () => {
    expect(await runDoctorCli(["--bogus"], { probes: [] })).toBe(2);
    expect(err.join("\n")).toContain("unknown flag: --bogus");
    expect(err.join("\n")).toContain("usage: flow doctor [--json]");
    expect(out).toEqual([]);
  });

  it("prints text by default and the documented JSON shape with --json", async () => {
    const probes = [
      () => [
        {
          id: "x",
          section: "tools" as const,
          title: "X",
          status: "warn" as const,
          summary: "meh",
          details: [],
          fix: "do it",
        },
      ],
    ];
    expect(await runDoctorCli([], { probes })).toBe(0);
    expect(out.join("\n")).toContain("fix: do it");
    out = [];
    expect(await runDoctorCli(["--json"], { probes })).toBe(0);
    expect(jsonReport()).toMatchObject({
      version: 1,
      ok: true,
      counts: { pass: 0, warn: 1, fail: 0, skip: 0 },
    });
    expect(jsonReport().checks).toHaveLength(1);
  });

  it("returns 1 when any check fails and survives a throwing probe", async () => {
    const probes = [
      () => {
        throw new Error("kaput");
      },
      () => [
        {
          id: "f",
          section: "install" as const,
          title: "F",
          status: "fail" as const,
          summary: "broken",
          details: [],
          fix: "fix",
        },
      ],
    ];
    expect(await runDoctorCli(["--json"], { probes })).toBe(1);
    const r = jsonReport();
    expect(r.ok).toBe(false);
    expect(r.checks[0].summary).toBe("could not run: kaput");
  });
});

describe("runDoctorCli full probe run in a sandbox", () => {
  it("a healthy install is all pass/skip and exits 0", async () => {
    const deps = healthyDeps();
    expect(await runDoctorCli(["--json"], { deps })).toBe(0);
    const r = jsonReport();
    const bad = r.checks.filter(
      (c) => c.status === "warn" || c.status === "fail",
    );
    expect(bad).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "install-links",
        "install-modules",
        "install-packages",
        "shell-flow-slug",
        "shell-path",
        "tools-gh",
        "tools-tmux",
        "tools-claude",
        "tools-agy",
        "leftovers-worktrees",
        "leftovers-processes",
      ]),
    );
    const procs = r.checks.find((c) => c.id === "leftovers-processes")!;
    expect(procs.status).toBe("pass");
    expect(procs.details.join(" ")).toContain("1 stale registry entry");
    expect(r.checks.find((c) => c.id === "tools-tmux")?.status).toBe("skip");
    expect(r.checks.find((c) => c.id === "tools-agy")?.status).toBe("skip");
  });

  it("a registered helper with no link and no record fails the run with the fix", async () => {
    const deps = healthyDeps();
    fs.writeFileSync(
      path.join(deps.installRoot, "bin", "flow-state-update.ts"),
      "",
    );
    expect(await runDoctorCli(["--json"], { deps })).toBe(1);
    const c = jsonReport().checks.find((x) => x.id === "install-modules")!;
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("flow-state-update");
    expect(c.fix).toBe("flow install --upgrade");
  });

  it("never writes, signals or reaps: every sandbox byte and mtime is unchanged", async () => {
    const deps = healthyDeps();
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, sig) => {
        if (sig === 0)
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      });
    const before = snapshot(root);
    await runDoctorCli([], { deps });
    await runDoctorCli(["--json"], { deps });
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(POISON)).toBe(false);
    expect(killSpy.mock.calls.filter(([, sig]) => sig !== 0)).toEqual([]);
    const teardownDeps = browserTeardownMock.buildDefaultDeps.mock.results.map(
      (r) => r.value as { kill: ReturnType<typeof vi.fn> },
    );
    expect(teardownDeps.length).toBeGreaterThan(0);
    for (const d of teardownDeps) expect(d.kill).not.toHaveBeenCalled();
    for (const call of browserTeardownMock.runOrphanSweep.mock.calls) {
      expect(call[1]).toMatchObject({ yes: false });
    }
  });
});
