import { describe, expect, it, vi } from "vitest";
import {
  buildNewSessionArgs,
  buildNewWindowArgs,
  buildRenameArgs,
  buildSendKeysArgs,
  buildSetOptionArgs,
  createWindowVerified,
  findWindowBySlug,
  parseAliveStatus,
  parsePaneConsumed,
  parsePaneReady,
  parseWindowList,
  resolveSlugFromPane,
  respawnWindowVerified,
  seedWindowOptions,
  setWindowPhase,
  type SpawnResult,
  type TmuxWindow,
} from "./tmux";

/** A ready-but-not-yet-consumed pane capture (TUI drawn, empty input box). */
const READY_CAPTURE = "  ? for shortcuts";
/** A consumed pane capture (an active supervisor turn is underway). */
const CONSUMED_CAPTURE = "esc to interrupt";

/**
 * A two-phase readPane + matching sendKeys spy modelling the real lifecycle:
 * the pane reads ready-but-not-consumed until the seed is SUBMITTED (the Enter
 * send-keys call flips the latch), after which it reads consumed. This is
 * independent of the private poll-budget constants — consumption appears exactly
 * when the launcher submits, never before — so the double-submit guard and the
 * separate-text-then-Enter ordering are exercised faithfully.
 */
function makeSeedSeams() {
  let submitted = false;
  const readPane = () => (submitted ? CONSUMED_CAPTURE : READY_CAPTURE);
  const sendKeys = vi.fn((_slug: string, keys: string, literal: boolean) => {
    // The literal seed text comes first, then a separate non-literal "Enter"
    // that submits — only the Enter advances the pane to a consumed state.
    if (!literal && keys === "Enter") submitted = true;
    return { ok: true, stderr: "" };
  });
  return { readPane, sendKeys };
}

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

  it("emits the -w (window) form for @flow-slug WRITES (Story 4 regression)", () => {
    // resolveSlugFromPane already pins the -w READ side; this pins the WRITE side
    // so @flow-slug can never silently drift to a session/global option scope.
    expect(buildSetOptionArgs("@7", "@flow-slug", "csv-export")).toEqual([
      "set-option",
      "-w",
      "-t",
      "@7",
      "@flow-slug",
      "csv-export",
    ]);
  });
});

describe(buildSendKeysArgs, () => {
  it("uses -l -- for literal text (the shell-free seed delivery path)", () => {
    expect(buildSendKeysArgs("@7", "hello world", true)).toEqual([
      "send-keys",
      "-t",
      "@7",
      "-l",
      "--",
      "hello world",
    ]);
  });

  it("emits a bare key name for non-literal keystrokes (the separate Enter submit)", () => {
    expect(buildSendKeysArgs("@7", "Enter", false)).toEqual([
      "send-keys",
      "-t",
      "@7",
      "Enter",
    ]);
  });
});

describe(parsePaneReady, () => {
  it("returns false for an empty / whitespace capture", () => {
    expect(parsePaneReady("")).toBe(false);
    expect(parsePaneReady("   \n  ")).toBe(false);
  });

  it("returns true for a drawn TUI ('? for shortcuts'), case-insensitively", () => {
    expect(parsePaneReady("  ? for Shortcuts")).toBe(true);
    expect(parsePaneReady("Welcome to Claude Code")).toBe(true);
  });

  it("treats a consumed pane as ready (positional auto-ran)", () => {
    expect(parsePaneReady("esc to interrupt")).toBe(true);
  });

  it("returns false for a banner with no input box and no active turn", () => {
    expect(parsePaneReady("loading...")).toBe(false);
  });
});

describe(parsePaneConsumed, () => {
  it("returns false for an empty capture", () => {
    expect(parsePaneConsumed("")).toBe(false);
  });

  it("returns true for the active-turn marker ('esc to interrupt'), case-insensitively", () => {
    expect(parsePaneConsumed("ESC to interrupt")).toBe(true);
    // "to interrupt" subsumes "esc to interrupt" under includes(), so the bare
    // interrupt hint (no "esc" prefix) must also count as consumed.
    expect(parsePaneConsumed("Press ctrl+c to interrupt")).toBe(true);
  });

  it("returns false for a ready-but-not-consumed idle pane (empty input box)", () => {
    // The marker must never match an idle TUI footer — a token/usage counter
    // ("thinking"/"tokens") would fail OPEN (false-success on a never-started
    // supervisor), the exact Mode-1 bug this module exists to kill.
    expect(parsePaneConsumed("  ? for shortcuts")).toBe(false);
    expect(parsePaneConsumed("✻ Thinking… (esc to clear) · 12.3k tokens")).toBe(
      false,
    );
  });
});

describe(seedWindowOptions, () => {
  // The repo root threaded in from createWindow's `cwd`; @flow-repo is its
  // basename, distinct from the slug to prove the two are independent.
  const REPO_ROOT = "/Users/x/code/econ-data";

  it("sets @flow-slug then seeds @flow-repo / @flow-phase / @flow-phase-short", () => {
    const { calls, spawnTmux } = fakeSpawn();
    const result = seedWindowOptions("@7", "csv-export", REPO_ROOT, spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@7", "@flow-slug", "csv-export"],
      ["set-option", "-w", "-t", "@7", "@flow-repo", "econ-data"],
      ["set-option", "-w", "-t", "@7", "@flow-phase", "starting"],
      ["set-option", "-w", "-t", "@7", "@flow-phase-short", "start"],
    ]);
  });

  it("fails creation when the @flow-slug set fails (identity is load-bearing)", () => {
    // Slug set fails — the option is the canonical lookup key, so creation
    // must fail and the additive mirrors must not even be attempted.
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      return { stdout: "", stderr: "boom", exitCode: 1 };
    };
    const result = seedWindowOptions("@7", "csv-export", REPO_ROOT, spawnTmux);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("@flow-slug");
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@7", "@flow-slug", "csv-export"],
    ]);
  });

  it("still succeeds when only the @flow-phase seed fails (best-effort mirror)", () => {
    // Slug set succeeds, raw-phase seed fails — creation must still report ok,
    // since @flow-phase is an additive convenience, not load-bearing. The
    // @flow-phase-short element ("@flow-phase-short") is not an exact match for
    // "@flow-phase", so only the raw set is forced to fail here.
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      const isRawPhase = args.includes("@flow-phase");
      return {
        stdout: "",
        stderr: isRawPhase ? "boom" : "",
        exitCode: isRawPhase ? 1 : 0,
      };
    };
    const result = seedWindowOptions("@7", "csv-export", REPO_ROOT, spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(4);
  });

  it("still succeeds when only the @flow-repo set fails (best-effort mirror)", () => {
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      const isRepo = args.includes("@flow-repo");
      return {
        stdout: "",
        stderr: isRepo ? "boom" : "",
        exitCode: isRepo ? 1 : 0,
      };
    };
    const result = seedWindowOptions("@7", "csv-export", REPO_ROOT, spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(4);
  });

  it("still succeeds when only the @flow-phase-short set fails (best-effort mirror)", () => {
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      const isShort = args.includes("@flow-phase-short");
      return {
        stdout: "",
        stderr: isShort ? "boom" : "",
        exitCode: isShort ? 1 : 0,
      };
    };
    const result = seedWindowOptions("@7", "csv-export", REPO_ROOT, spawnTmux);
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(4);
  });
});

describe(createWindowVerified, () => {
  // The create call shells out via the module-private `tmux` spawn — fakeSpawn
  // can't reach it and the fix must not mutate createWindow — so the create
  // result is driven through the `create` deps seam. The alive-probe, readPane,
  // and sendKeys are stubbed (the real impls shell out unconditionally;
  // exercising them is the anti-pattern these seams exist to avoid). `sleep` is a
  // no-op so the bounded polls run instantly. createWindowVerified now takes a
  // `seed` as its 4th positional arg (deps moves to 5th) and owns seed delivery.
  // The new-window/new-session argv shape stays covered by the buildNewWindowArgs
  // / buildNewSessionArgs tests above.
  const noopSleep = () => undefined;
  const SEED = "Use the /flow-pipeline skill for: csv export";

  it("Case A: create ok but the pane never becomes ready → returns ok:false AND kills the half-created window", () => {
    // DEAD case: isAlive false short-circuits pollUntilReady before readPane, so
    // no readPane/sendKeys seam is needed beyond the seed arg.
    const kill = vi.fn(() => true);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => false, // dead at the end of the budget
        kill,
        sleep: noopSleep,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/never became ready|pane not alive/);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("csv-export", "flow");
  });

  it("Case B: create ok, pane ready, seed delivered + consumed → returns ok:true and never kills", () => {
    const kill = vi.fn(() => true);
    const { readPane, sendKeys } = makeSeedSeams();
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill,
        sleep: noopSleep,
        readPane,
        sendKeys,
      },
    );
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("propagates a failed create verbatim without probing or killing", () => {
    const isAlive = vi.fn(() => true);
    const kill = vi.fn(() => true);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: false, stderr: "index 0 in use" }),
        isAlive,
        kill,
        sleep: noopSleep,
      },
    );
    expect(result).toEqual({ ok: false, stderr: "index 0 in use" });
    expect(isAlive).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("catches the alive-then-dies race: alive on the first probe but dead at the end → ok:false", () => {
    // The pane is alive early then exits mid-budget. The ready poll runs first
    // and its FINAL probe sees isAlive false → pollUntilReady returns false →
    // kill + ok:false. Only the final reading is the verdict, so the launch is
    // rejected and the window killed.
    const kill = vi.fn(() => true);
    let probe = 0;
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => probe++ < 2, // true, true, then false for the rest
        kill,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
      },
    );
    expect(result.ok).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("sends the seed only after ready, with text and Enter as two SEPARATE ordered calls", () => {
    // readPane returns ready-but-not-consumed during the ready poll, then a
    // consumed string once the seed is submitted — so send-keys fires (the
    // double-submit guard sees a not-yet-consumed pane) exactly twice, in order.
    const { readPane, sendKeys } = makeSeedSeams();
    const kill = vi.fn(() => true);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill,
        sleep: noopSleep,
        readPane,
        sendKeys,
      },
    );
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(sendKeys).toHaveBeenCalledTimes(2);
    expect(sendKeys.mock.calls[0]).toEqual(["csv-export", SEED, true, "flow"]);
    expect(sendKeys.mock.calls[1]).toEqual([
      "csv-export",
      "Enter",
      false,
      "flow",
    ]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("double-submit guard: an already-consumed pane at ready-time skips send-keys (positional auto-ran)", () => {
    // readPane reports a consumed pane from the start (the positional prompt
    // auto-ran the seed), so the guard skips both send-keys calls but the
    // consumption poll still confirms success.
    const sendKeys = vi.fn(() => ({ ok: true, stderr: "" }));
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane: () => CONSUMED_CAPTURE,
        sendKeys,
      },
    );
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(sendKeys).toHaveBeenCalledTimes(0);
  });

  it("consumption never reached (Mode 1) → ok:false AND kills the window", () => {
    // The pane is ready and stays alive but never advances past the empty input
    // box: pollUntilConsumed never latches → ok:false, and the create path kills.
    const kill = vi.fn(() => true);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE, // ready but never consumed
        sendKeys: vi.fn(() => ({ ok: true, stderr: "" })),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/never consumed/);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("consume-then-die (Mode 3) → ok:false AND kills the window", () => {
    // The pane becomes ready, the seed is delivered + consumed, then claude dies
    // before the end of the consume budget. Consumption LATCHES (monotonic) but
    // the FINAL liveness reading is false, so the verdict is false and the create
    // path kills. Modelled without the private poll-budget constants: the pane
    // reads READY until Enter submits (so the ready poll passes via the
    // READY_MARKERS and the seed IS delivered) then CONSUMED; `isAlive` reports
    // dead from the moment the pane has gone consumed (post-submit) — i.e. it
    // stays alive through the whole ready poll and dies right at consume-time.
    const kill = vi.fn(() => true);
    let submitted = false;
    const readPane = () => (submitted ? CONSUMED_CAPTURE : READY_CAPTURE);
    const sendKeys = vi.fn((_slug: string, keys: string, literal: boolean) => {
      if (!literal && keys === "Enter") submitted = true;
      return { ok: true, stderr: "" };
    });
    // Alive through the entire ready poll, then alive for exactly the FIRST
    // consume probe (so consumption LATCHES) and dead thereafter — the genuine
    // consume-then-die shape: everConsumed=true but aliveAtEnd=false → false.
    let aliveAfterSubmit = 1;
    const isAlive = () => {
      if (!submitted) return true;
      return aliveAfterSubmit-- > 0;
    };
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive,
        kill,
        sleep: noopSleep,
        readPane,
        sendKeys,
      },
    );
    expect(result.ok).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe(respawnWindowVerified, () => {
  // Mirrors the createWindowVerified block via the `respawn` deps seam (the
  // resume-path analogue of `create`). The single behavioral DIFFERENCE between
  // the two launchers — respawn does NOT kill the window on ANY verification
  // failure, because it pre-existed the resume and the user may want its
  // scrollback — is pinned via a cast-threaded kill spy. The real isPaneAlive /
  // capture-pane / send-keys are never exercised (they shell out
  // unconditionally), and `sleep` is a no-op so the bounded polls run instantly.
  // respawnWindowVerified now takes a `seed` 4th positional arg (deps → 5th).
  const noopSleep = () => undefined;
  const SEED = "Use the /flow-pipeline skill in --resume mode for: csv-export";

  it("respawn ok, pane ready, seed delivered + consumed → returns ok:true", () => {
    const { readPane, sendKeys } = makeSeedSeams();
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        sleep: noopSleep,
        readPane,
        sendKeys,
      },
    );
    expect(result).toEqual({ ok: true, stderr: "" });
  });

  it("respawn ok but the pane never becomes ready → ok:false AND does NOT kill the window (the create-vs-respawn asymmetry)", () => {
    // The single behavioral difference from createWindowVerified: a verification
    // failure on resume yields ok:false but leaves the (pre-existing) window
    // intact. A kill spy is threaded through a cast so that even a future
    // re-addition of a kill seam to this path would trip this assertion.
    const kill = vi.fn(() => true);
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => false, // dead at the end of the budget
        sleep: noopSleep,
        kill,
      } as Parameters<typeof respawnWindowVerified>[4],
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/never became ready|pane not alive/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("propagates a failed respawn verbatim without probing the pane", () => {
    const isAlive = vi.fn(() => true);
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({
          ok: false,
          stderr: "window not found for slug 'csv-export'",
        }),
        isAlive,
        sleep: noopSleep,
      },
    );
    expect(result).toEqual({
      ok: false,
      stderr: "window not found for slug 'csv-export'",
    });
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("catches the alive-then-dies race: alive on the first probe but dead at the end → ok:false", () => {
    let probe = 0;
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => probe++ < 2, // true, true, then false for the rest
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
      },
    );
    expect(result.ok).toBe(false);
  });

  it("consumption never reached (Mode 1) → ok:false and does NOT kill the window", () => {
    // Ready and alive throughout, but the pane never advances past the empty
    // input box → pollUntilConsumed never latches → ok:false. The respawn path
    // never kills (cast-threaded kill spy locks the asymmetry).
    const kill = vi.fn(() => true);
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE, // ready but never consumed
        sendKeys: vi.fn(() => ({ ok: true, stderr: "" })),
        kill,
      } as Parameters<typeof respawnWindowVerified>[4],
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/never consumed/);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe(setWindowPhase, () => {
  const windows: TmuxWindow[] = [
    { id: "@2", name: "renamed by user", slug: "csv-export", activity: 0 },
  ];

  it("resolves the window by @flow-slug and sets @flow-phase + @flow-phase-short on its id (rename-safe)", () => {
    // Display name diverges from the slug — the helper must target @2 via the
    // @flow-slug match, not the name. Both the raw phase and its abbreviation
    // are mirrored (shortPhase("reviewing") === "review").
    const { calls, spawnTmux } = fakeSpawn();
    const result = setWindowPhase("csv-export", "reviewing", {
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@2", "@flow-phase", "reviewing"],
      ["set-option", "-w", "-t", "@2", "@flow-phase-short", "review"],
    ]);
  });

  it("preserves ok:true when only the @flow-phase-short mirror fails (best-effort)", () => {
    // The raw @flow-phase set drives the return; a non-zero exit on the
    // additive @flow-phase-short mirror is swallowed and never flips ok.
    const calls: string[][] = [];
    const spawnTmux = (args: string[]): SpawnResult => {
      calls.push(args);
      const isShort = args.includes("@flow-phase-short");
      return {
        stdout: "",
        stderr: isShort ? "nope" : "",
        exitCode: isShort ? 1 : 0,
      };
    };
    const result = setWindowPhase("csv-export", "reviewing", {
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toEqual({ ok: true, stderr: "" });
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@2", "@flow-phase", "reviewing"],
      ["set-option", "-w", "-t", "@2", "@flow-phase-short", "review"],
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
