import { describe, expect, it } from "vitest";
import { parseArgs, run, type SpawnResult } from "./flow-rename-window";
import type { TmuxWindow } from "./lib/tmux";

function w(overrides: Partial<TmuxWindow>): TmuxWindow {
  return { id: "@1", name: "csv-export", slug: "csv-export", activity: 0, ...overrides };
}

describe(parseArgs, () => {
  it("parses <slug> <title>", () => {
    expect(parseArgs(["csv-export", "add CSV export"])).toEqual({
      slug: "csv-export",
      title: "add CSV export",
    });
  });

  it("recognises --help anywhere in argv", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["csv-export", "--help"])).toEqual({ kind: "help" });
  });

  it("recognises -h", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("stops scanning for help at -- (so a literal -h title doesn't trigger help)", () => {
    // Edge case: title is literally "-h". The user passes `--` to end
    // option parsing. parseArgs sees the `--`, skips help-scan past it,
    // and now treats the remaining `-h` as the title positional.
    expect(parseArgs(["slug", "--", "-h"])).toEqual({
      error:
        "too many positional arguments — quote the title (e.g. flow-rename-window slug \"my title\")",
    });
  });

  it("rejects missing arguments", () => {
    expect(parseArgs([])).toEqual({ error: "<slug> and <title> are both required" });
    expect(parseArgs(["just-slug"])).toEqual({
      error: "<slug> and <title> are both required",
    });
  });

  it("rejects extra positional arguments (unquoted multi-word title)", () => {
    expect(parseArgs(["slug", "two", "words"])).toEqual({
      error:
        "too many positional arguments — quote the title (e.g. flow-rename-window slug \"my title\")",
    });
  });

  it("rejects an empty slug or title", () => {
    expect(parseArgs(["", "title"])).toEqual({ error: "<slug> must not be empty" });
    expect(parseArgs(["slug", "  "])).toEqual({ error: "<title> must not be empty" });
  });
});

describe(run, () => {
  function harness(windows: TmuxWindow[], spawn: (args: string[]) => SpawnResult) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[][] = [];
    const exit = run(["csv-export", "add CSV export"], {
      listWindows: () => windows,
      spawnTmux: (args) => {
        calls.push(args);
        return spawn(args);
      },
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
    });
    return { exit, out, err, calls };
  }

  it("renames the window by id (not by name) on the happy path", () => {
    const { exit, calls } = harness(
      [w({ id: "@7", name: "csv export prototype", slug: "csv-export" })],
      () => ({ exitCode: 0, stderr: "" }),
    );
    expect(exit).toBe(0);
    expect(calls).toEqual([
      ["rename-window", "-t", "@7", "add CSV export"],
    ]);
  });

  it("succeeds against a renamed window — slug lookup, not name", () => {
    // Display name is something the user typed via `tmux ,` already; the
    // helper still resolves the slug via @flow-slug.
    const { exit, calls } = harness(
      [
        w({ id: "@2", name: "totally-unrelated-display", slug: "csv-export" }),
        w({ id: "@9", name: "csv-export", slug: "other-pipeline" }),
      ],
      () => ({ exitCode: 0, stderr: "" }),
    );
    expect(exit).toBe(0);
    // Critical: target id is @2 (slug match), not @9 (name match for a
    // *different* pipeline).
    expect(calls[0][2]).toBe("@2");
  });

  it("falls back to name lookup for pre-upgrade windows (no @flow-slug set)", () => {
    const { exit, calls } = harness(
      [w({ id: "@3", name: "csv-export", slug: "" })],
      () => ({ exitCode: 0, stderr: "" }),
    );
    expect(exit).toBe(0);
    expect(calls[0][2]).toBe("@3");
  });

  it("exits 1 with a clear message when the slug doesn't resolve", () => {
    const { exit, err, calls } = harness(
      [w({ id: "@1", name: "other", slug: "other" })],
      () => ({ exitCode: 0, stderr: "" }),
    );
    expect(exit).toBe(1);
    expect(calls).toEqual([]); // never spawned tmux rename-window
    expect(err.join("")).toContain("no flow window matches slug 'csv-export'");
  });

  it("exits 1 and surfaces tmux's stderr when rename-window itself fails", () => {
    const { exit, err } = harness(
      [w({ id: "@7", slug: "csv-export" })],
      () => ({ exitCode: 1, stderr: "can't find window @7" }),
    );
    expect(exit).toBe(1);
    expect(err.join("")).toContain("can't find window @7");
  });

  it("--help short-circuits before any tmux call", () => {
    let lookups = 0;
    let spawns = 0;
    const out: string[] = [];
    const exit = run(["--help"], {
      listWindows: () => {
        lookups++;
        return [];
      },
      spawnTmux: () => {
        spawns++;
        return { exitCode: 0, stderr: "" };
      },
      writeOut: (s) => out.push(s),
      writeErr: () => {},
    });
    expect(exit).toBe(0);
    expect(lookups).toBe(0);
    expect(spawns).toBe(0);
    expect(out.join("")).toMatch(/^flow-rename-window/);
  });

  it("exits 2 on argument-parse error so misuse is loud", () => {
    const err: string[] = [];
    const exit = run([], {
      listWindows: () => [],
      spawnTmux: () => ({ exitCode: 0, stderr: "" }),
      writeOut: () => {},
      writeErr: (s) => err.push(s),
    });
    expect(exit).toBe(2);
    expect(err.join("")).toContain("usage: flow-rename-window");
  });
});
