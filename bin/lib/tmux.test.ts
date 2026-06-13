import { describe, expect, it } from "vitest";
import {
  buildNewSessionArgs,
  buildNewWindowArgs,
  buildRenameArgs,
  buildSetOptionArgs,
  findWindowBySlug,
  parseAliveStatus,
  parseWindowList,
  resolveSlugFromPane,
  seedWindowOptions,
  setWindowPhase,
  type SpawnResult,
  type TmuxWindow,
} from "./tmux";

/** A capturing fake `tmux` spawn: records every argv, returns the queued result. */
function fakeSpawn(
  result: SpawnResult = { stdout: "", stderr: "", exitCode: 0 },
) {
  const calls: string[][] = [];
  const spawnTmux = (args: string[]): SpawnResult => {
    calls.push(args);
    return result;
  };
  return { calls, spawnTmux };
}

describe(parseAliveStatus, () => {
  it("returns true when pane_dead is 0 and pid probe succeeds", () => {
    expect(parseAliveStatus("0 4242", () => true)).toBe(true);
  });

  it("returns false when pane_dead is 1 (remain-on-exit corpse)", () => {
    expect(parseAliveStatus("1 4242", () => true)).toBe(false);
  });

  it("returns false when pid probe says the process is gone", () => {
    expect(parseAliveStatus("0 4242", () => false)).toBe(false);
  });

  it("returns false when stdout is empty (no panes)", () => {
    expect(parseAliveStatus("", () => true)).toBe(false);
  });

  it("returns false when the pid is unparseable", () => {
    expect(parseAliveStatus("0 not-a-pid", () => true)).toBe(false);
  });

  it("returns false when the pid is non-positive", () => {
    expect(parseAliveStatus("0 0", () => true)).toBe(false);
  });

  it("only inspects the first pane (the one we always launch into)", () => {
    const stdout = "0 4242\n1 9999\n";
    expect(parseAliveStatus(stdout, () => true)).toBe(true);
  });
});

describe(buildNewWindowArgs, () => {
  // Regression: bare `-t flow` resolves against the active window in some
  // tmux configs, so `new-window -t flow` from inside an existing flow
  // window fails with "index N in use" instead of picking the lowest free
  // slot. The trailing colon forces session-target semantics. The `-P -F
  // #{window_id}` suffix lets createWindow capture the new window's id so
  // it can immediately set the @flow-slug option on it.
  it("targets the session with a trailing colon and prints the new window id", () => {
    expect(
      buildNewWindowArgs("flow", "my-win", "/tmp", ["echo", "hi"]),
    ).toEqual([
      "new-window",
      "-t",
      "flow:",
      "-n",
      "my-win",
      "-c",
      "/tmp",
      "-P",
      "-F",
      "#{window_id}",
      "--",
      "echo",
      "hi",
    ]);
  });
});

describe(buildNewSessionArgs, () => {
  it("creates a detached session and prints the new window id", () => {
    expect(
      buildNewSessionArgs("flow", "first", "/tmp", ["echo", "hi"]),
    ).toEqual([
      "new-session",
      "-d",
      "-s",
      "flow",
      "-n",
      "first",
      "-c",
      "/tmp",
      "-P",
      "-F",
      "#{window_id}",
      "--",
      "echo",
      "hi",
    ]);
  });
});

describe(buildRenameArgs, () => {
  it("renames by window id, not by name", () => {
    expect(buildRenameArgs("@7", "safe rename")).toEqual([
      "rename-window",
      "-t",
      "@7",
      "safe rename",
    ]);
  });

  it("preserves spaces in the title (tmux quotes its own argv)", () => {
    expect(buildRenameArgs("@7", "title with spaces")).toEqual([
      "rename-window",
      "-t",
      "@7",
      "title with spaces",
    ]);
  });
});

describe(buildSetOptionArgs, () => {
  it("builds a window-scoped set-option argv targeting the window id", () => {
    expect(buildSetOptionArgs("@7", "@flow-phase", "reviewing")).toEqual([
      "set-option",
      "-w",
      "-t",
      "@7",
      "@flow-phase",
      "reviewing",
    ]);
  });
});

describe(seedWindowOptions, () => {
  it("sets @flow-slug then seeds @flow-phase=starting on the new window", () => {
    const { calls, spawnTmux } = fakeSpawn();
    const result = seedWindowOptions("@7", "csv-export", spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@7", "@flow-slug", "csv-export"],
      ["set-option", "-w", "-t", "@7", "@flow-phase", "starting"],
    ]);
  });

  it("fails creation when the @flow-slug set fails (identity is load-bearing)", () => {
    // Slug set fails — the option is the canonical lookup key, so creation
    // must fail and the @flow-phase seed must not even be attempted.
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      return { stdout: "", stderr: "boom", exitCode: 1 };
    };
    const result = seedWindowOptions("@7", "csv-export", spawnTmux);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("@flow-slug");
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@7", "@flow-slug", "csv-export"],
    ]);
  });

  it("still succeeds when only the @flow-phase seed fails (best-effort mirror)", () => {
    // Slug set succeeds, phase seed fails — creation must still report ok,
    // since @flow-phase is an additive convenience, not load-bearing.
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      const isPhase = args.includes("@flow-phase");
      return {
        stdout: "",
        stderr: isPhase ? "boom" : "",
        exitCode: isPhase ? 1 : 0,
      };
    };
    const result = seedWindowOptions("@7", "csv-export", spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(2);
  });
});

describe(setWindowPhase, () => {
  const windows: TmuxWindow[] = [
    { id: "@2", name: "renamed by user", slug: "csv-export", activity: 0 },
  ];

  it("resolves the window by @flow-slug and sets @flow-phase on its id (rename-safe)", () => {
    // Display name diverges from the slug — the helper must target @2 via the
    // @flow-slug match, not the name.
    const { calls, spawnTmux } = fakeSpawn();
    const result = setWindowPhase("csv-export", "reviewing", {
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@2", "@flow-phase", "reviewing"],
    ]);
  });

  it("soft-fails without throwing or spawning when no window owns the slug", () => {
    const { calls, spawnTmux } = fakeSpawn();
    const result = setWindowPhase("missing", "gating", {
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("missing");
    expect(calls).toEqual([]); // never shelled out
  });

  it("returns ok:false when the set-option exits non-zero (tmux hiccup)", () => {
    const { spawnTmux } = fakeSpawn({
      stdout: "",
      stderr: "nope",
      exitCode: 1,
    });
    const result = setWindowPhase("csv-export", "merging", {
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toEqual({ ok: false, stderr: "nope" });
  });
});

describe(parseWindowList, () => {
  it("parses tab-separated id/name/slug/activity rows", () => {
    const stdout = [
      "@1\tcsv-export\tcsv-export\t1700000000",
      "@2\tprototype\tcsv-export-v2\t1700001234",
    ].join("\n");
    expect(parseWindowList(stdout)).toEqual([
      {
        id: "@1",
        name: "csv-export",
        slug: "csv-export",
        activity: 1700000000,
      },
      {
        id: "@2",
        name: "prototype",
        slug: "csv-export-v2",
        activity: 1700001234,
      },
    ]);
  });

  it("treats empty @flow-slug as the empty string (pre-upgrade window)", () => {
    const stdout = "@9\tlegacy\t\t1700000000";
    expect(parseWindowList(stdout)).toEqual([
      { id: "@9", name: "legacy", slug: "", activity: 1700000000 },
    ]);
  });

  it("returns [] for empty stdout", () => {
    expect(parseWindowList("")).toEqual([]);
  });

  it("ignores blank lines (stray newlines from tmux trailers)", () => {
    const stdout = "\n@1\tw\ts\t100\n\n";
    expect(parseWindowList(stdout)).toEqual([
      { id: "@1", name: "w", slug: "s", activity: 100 },
    ]);
  });
});

describe(findWindowBySlug, () => {
  function w(overrides: Partial<TmuxWindow>): TmuxWindow {
    return { id: "@1", name: "w", slug: "", activity: 0, ...overrides };
  }

  it("matches @flow-slug regardless of display name (the rename-survival case)", () => {
    const windows = [
      w({ id: "@1", name: "csv export prototype", slug: "csv-export" }),
    ];
    expect(findWindowBySlug(windows, "csv-export")).toEqual(windows[0]);
  });

  it("falls back to display name when @flow-slug is empty (pre-upgrade window)", () => {
    const windows = [w({ id: "@5", name: "legacy", slug: "" })];
    expect(findWindowBySlug(windows, "legacy")).toEqual(windows[0]);
  });

  it("prefers a slug match over a name fallback (no shadowing across pipelines)", () => {
    // @1 is a renamed window whose old name happens to equal the slug
    // we're looking up — but @2 is the real owner via @flow-slug. The
    // slug-keyed pass must run before the name pass, so @2 wins.
    const windows = [
      w({ id: "@1", name: "csv-export", slug: "old-pipeline" }),
      w({ id: "@2", name: "renamed", slug: "csv-export" }),
    ];
    expect(findWindowBySlug(windows, "csv-export")?.id).toBe("@2");
  });

  it("returns the first match when two windows share a slug (deterministic by list order)", () => {
    const windows = [
      w({ id: "@3", name: "a", slug: "dup" }),
      w({ id: "@4", name: "b", slug: "dup" }),
    ];
    expect(findWindowBySlug(windows, "dup")?.id).toBe("@3");
  });

  it("does not name-fallback onto a window that already has a different slug", () => {
    // @1's name happens to be 'csv-export' but its slug is something else.
    // Looking up 'csv-export' must NOT return @1 — that would steal a
    // pipeline lookup for the unrelated owner of @1.
    const windows = [w({ id: "@1", name: "csv-export", slug: "other" })];
    expect(findWindowBySlug(windows, "csv-export")).toBeUndefined();
  });

  it("returns undefined when neither slug nor name match", () => {
    const windows = [w({ id: "@1", name: "a", slug: "b" })];
    expect(findWindowBySlug(windows, "missing")).toBeUndefined();
  });
});

describe(resolveSlugFromPane, () => {
  function fakeSpawn(result: SpawnResult): {
    calls: string[][];
    spawnTmux: (args: string[]) => SpawnResult;
  } {
    const calls: string[][] = [];
    return {
      calls,
      spawnTmux: (args) => {
        calls.push(args);
        return result;
      },
    };
  }

  it("returns null when $TMUX_PANE is unset (helper invoked outside tmux)", () => {
    const { calls, spawnTmux } = fakeSpawn({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(resolveSlugFromPane({ env: {}, spawnTmux })).toBeNull();
    // Don't even shell out — short-circuit on the env miss.
    expect(calls).toEqual([]);
  });

  it("returns null when tmux exits non-zero (option unset on the window)", () => {
    const { spawnTmux } = fakeSpawn({
      stdout: "",
      stderr: "no such option",
      exitCode: 1,
    });
    expect(
      resolveSlugFromPane({ env: { TMUX_PANE: "%42" }, spawnTmux }),
    ).toBeNull();
  });

  it("returns null when the option resolves to an empty / whitespace string", () => {
    const { spawnTmux } = fakeSpawn({
      stdout: "  \n",
      stderr: "",
      exitCode: 0,
    });
    expect(
      resolveSlugFromPane({ env: { TMUX_PANE: "%42" }, spawnTmux }),
    ).toBeNull();
  });

  it("returns the trimmed slug when the option is set on the window", () => {
    const { calls, spawnTmux } = fakeSpawn({
      stdout: "csv-export\n",
      stderr: "",
      exitCode: 0,
    });
    expect(resolveSlugFromPane({ env: { TMUX_PANE: "%42" }, spawnTmux })).toBe(
      "csv-export",
    );
    // Targets the pane (not the session) and reads the window-scoped
    // user option with -v so we get just the value.
    expect(calls).toEqual([
      ["show-options", "-t", "%42", "-v", "-w", "@flow-slug"],
    ]);
  });
});
