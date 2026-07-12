import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildNewSessionArgs,
  buildNewWindowArgs,
  buildRenameArgs,
  buildSendKeysArgs,
  buildSetOptionArgs,
  createWindowVerified,
  findWindowBySlug,
  panePid,
  parseAliveStatus,
  parsePaneNonEmpty,
  parsePanePid,
  parseWindowList,
  resolveSlugFromPane,
  respawnWindowVerified,
  seedWindowOptions,
  setWindowPhase,
  type SpawnResult,
  type TmuxWindow,
} from "./tmux";

/**
 * A representative non-empty pane capture used for the string-free readiness
 * gate (parsePaneNonEmpty → true). It is just "claude has drawn something" — the
 * launcher no longer matches any TUI substring, so the exact contents are
 * irrelevant beyond being non-whitespace.
 */
const READY_CAPTURE = "❯ a rendered claude pane";

/**
 * Paste-chip frame: what capture-pane shows once a long multi-line paste lands —
 * the marker is collapsed into `[Pasted text …]` chips and never rendered as
 * text. deliverSeed must therefore verify the leading line BEFORE the remainder.
 */
const CHIP_CAPTURE = "❯ [Pasted text #1 +9 lines][Pasted text #2 +8 lines]";

/**
 * Models the delivery lifecycle through the launcher seams so the chunked
 * leading-line handshake in deliverSeed is exercised end to end: readPane echoes
 * the seed's leading line only AFTER a literal chunk lands, and `consumed()`
 * flips once the submit Enter is sent. Options drive the branches:
 *   - `blankDraws`: N empty captures first (late draw), ridden out by readiness.
 *   - `dropLeadingEchoes`: the first N post-send captures echo a TRUNCATED
 *     leading line ⇒ the C-u + resend branch fires.
 * Once the remainder is typed the capture collapses to a paste chip (no marker),
 * so a re-verification there would falsely fail — proving verify ran earlier.
 */
function makeLaunchSeam(
  seed: string,
  opts: { blankDraws?: number; dropLeadingEchoes?: number } = {},
) {
  const leadingLine = seed.split("\n")[0] ?? seed;
  let blank = opts.blankDraws ?? 0;
  let leadingSent = false;
  let leadingVerified = false;
  let remainderSent = false;
  let echoChecks = 0;
  let submitted = false;
  const sendKeys = vi.fn((_slug: string, keys: string, literal: boolean) => {
    if (literal) {
      if (leadingVerified) remainderSent = true;
      else leadingSent = true;
    }
    if (!literal && keys === "Enter") submitted = true;
    return { ok: true, stderr: "" };
  });
  const readPane = () => {
    if (blank > 0) {
      blank--;
      return "";
    }
    if (!leadingSent) return READY_CAPTURE; // settle-gate / pre-send
    if (remainderSent) return CHIP_CAPTURE; // long paste collapsed to chips
    echoChecks++;
    if (echoChecks <= (opts.dropLeadingEchoes ?? 0)) {
      return `${READY_CAPTURE}\n${leadingLine.slice(3)}`; // dropped prefix
    }
    leadingVerified = true;
    return `${READY_CAPTURE}\n${leadingLine}`;
  };
  const consumed = () => submitted;
  return { sendKeys, readPane, consumed };
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

describe(parsePanePid, () => {
  it("returns the numeric pid from a window's pane report", () => {
    expect(parsePanePid("4242")).toBe(4242);
  });

  it("only inspects the first pane", () => {
    expect(parsePanePid("4242\n9999\n")).toBe(4242);
  });

  it("returns null for empty stdout (no panes)", () => {
    expect(parsePanePid("")).toBeNull();
  });

  it("returns null when the pid is unparseable", () => {
    expect(parsePanePid("not-a-pid")).toBeNull();
  });

  it("returns null when the pid is non-positive", () => {
    expect(parsePanePid("0")).toBeNull();
  });
});

describe(panePid, () => {
  it("returns null for a nonexistent slug/window", () => {
    // Safe in any environment (tmux absent, or a live `flow` session with
    // unrelated windows): findWindowBySlug never matches this slug, so
    // panePid returns null without depending on real tmux pane state.
    expect(
      panePid("flow-p3-file-liveness-test-nonexistent-slug-zzz"),
    ).toBeNull();
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

describe(parsePaneNonEmpty, () => {
  it("returns false for an empty or whitespace-only capture", () => {
    expect(parsePaneNonEmpty("")).toBe(false);
    expect(parsePaneNonEmpty("   \n\t  ")).toBe(false);
  });

  it("returns true for any non-whitespace content (string-free liveness, no TUI match)", () => {
    // Readiness is "the pane rendered SOMETHING" — deliberately version-
    // independent, matching no Claude Code TUI substring. A bare glyph, a
    // rendered banner, or an active-turn line all count equally.
    expect(parsePaneNonEmpty("x")).toBe(true);
    expect(parsePaneNonEmpty(READY_CAPTURE)).toBe(true);
    expect(parsePaneNonEmpty("  ⏺ Bash(flow-state-update)  ")).toBe(true);
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
  // no-op and a tiny `readyAttempts`/`consumeAttempts` budget is injected so the
  // bounded polls run instantly. createWindowVerified takes a `seed` 4th
  // positional arg (deps 5th) and owns seed delivery; `consumed()` is the
  // version-independent (state-file-poll) consumption signal that replaced the
  // retired TUI-string scan. The new-window/new-session argv shape stays covered
  // by the buildNewWindowArgs / buildNewSessionArgs tests above.
  const noopSleep = () => undefined;
  const SEED = "Use the /flow-pipeline skill for: csv export";
  const budget = { readyAttempts: 3, consumeAttempts: 3 };

  it("Case A: create ok but the pane never becomes ready → status 'failed' AND kills the half-created window", () => {
    // DEAD case: isAlive false short-circuits pollUntilReady before readPane, so
    // no readPane/consumed seam is reached.
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
        consumed: () => false,
        ...budget,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/never became ready|pane not alive/);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("csv-export", "flow");
  });

  it("Case B: create ok, pane ready (non-empty), seed delivered + consumed → status 'started' and never kills", () => {
    const kill = vi.fn(() => true);
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
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
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("propagates a failed create as status 'failed' without probing or killing", () => {
    const isAlive = vi.fn(() => true);
    const kill = vi.fn(() => true);
    const consumed = vi.fn(() => false);
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
        consumed,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "failed", stderr: "index 0 in use" });
    expect(isAlive).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("catches the alive-then-dies race: alive on the first probe but dead at the end → status 'failed'", () => {
    // The pane is alive for the first 2 probes then dies. pollUntilReady
    // requires READY_TAIL_PROBES (3) consecutive alive probes after seeing
    // ready, so the death on probe 2 resets tailCount before it reaches 3 —
    // all remaining probes see dead, and pollUntilReady returns false →
    // kill + status 'failed'.
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
        consumed: () => false,
        ...budget,
      },
    );
    expect(result.status).toBe("failed");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("sends the seed only after ready, with text and Enter as two SEPARATE ordered calls", () => {
    // SEED is single-line (leading line === whole seed, no remainder), so the
    // chunked handshake collapses to one literal leading-line send that echoes
    // intact, then a separate submit Enter — send-keys fires exactly twice, in
    // order, pinning the literal-text-then-separate-Enter path (no C-u).
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
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
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
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

  it("vestigial guard: consumed() already true at ready-time skips send-keys (marker/baseline pre-satisfied)", () => {
    // The seed-ingested marker (or resume baseline) is already satisfied, so
    // consumed() is true from the start. The vestigial guard skips both
    // send-keys calls but the consumption poll still confirms success.
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
        readPane: () => READY_CAPTURE,
        consumed: () => true,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    expect(sendKeys).toHaveBeenCalledTimes(0);
  });

  it("short-budget consume-timeout with an ALIVE pane → 'launched-not-confirmed' and NEVER kills (non-destructive)", () => {
    // The KEY new behaviour: the pane is ready, the seed is delivered, and the
    // pane stays alive, but the supervisor never advances the phase within the
    // short consume budget (its first phase write lands ~60s out). The timeout
    // is NON-DESTRUCTIVE: status 'launched-not-confirmed', window NEVER killed.
    const kill = vi.fn(() => true);
    const { sendKeys, readPane } = makeLaunchSeam(SEED);
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
        readPane, // delivered, but the state-file phase never advances
        consumed: () => false,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("launched-not-confirmed");
    expect(kill).not.toHaveBeenCalled();
  });

  it("budget-exhausted with tail incomplete (everConsumed=true, aliveAtEnd=true) → status 'started'", () => {
    // Exercises the `if (everConsumed) return "started"` fallback at the end of
    // pollUntilConsumed. With a 3-attempt consume budget and consumption first
    // observed on attempt index 1, only 2 tail probes fit before the budget
    // exhausts (CONSUME_TAIL_PROBES = 3 requires 3), so the early `return
    // "started"` never fires — the fallback yields started because
    // everConsumed=true and aliveAtEnd=true.
    const kill = vi.fn(() => true);
    const { sendKeys, readPane } = makeLaunchSeam(SEED);
    let consumeProbe = 0;
    const consumed = () => consumeProbe++ >= 2;
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
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("consume-then-die (Mode 3) → status 'failed' AND kills the window", () => {
    // The pane becomes ready, the seed is delivered + consumed (phase advanced),
    // then claude dies before the end of the consume budget. Consumption LATCHES
    // (monotonic) but the FINAL liveness reading is false → status 'failed' and
    // the create path kills.
    const kill = vi.fn(() => true);
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
    let aliveAfterConsumed = 1;
    const isAlive = () => {
      if (!consumed()) return true;
      return aliveAfterConsumed-- > 0;
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
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("failed");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("dead pane at consume-timeout (ready passed, then dead, never consumed) → status 'failed' AND kills", () => {
    // Readiness passes (alive for the 3 tail probes), then the pane dies during
    // the consume phase before ever consuming → !everConsumed && !aliveAtEnd →
    // 'failed', and the create path still kills the half-created window.
    const kill = vi.fn(() => true);
    let probe = 0;
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => probe++ < 3, // 3 alive (readiness), then dead (consume)
        kill,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
        consumed: () => false,
        sendKeys: vi.fn(() => ({ ok: true, stderr: "" })),
        ...budget,
      },
    );
    expect(result.status).toBe("failed");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("onProgress fires once per interval across a multi-interval consume wait", () => {
    // readyAttempts:1 means readiness returns after a single attempt (no
    // inter-probe wait), so every onProgress call comes from the consume loop —
    // one per interval after attempt 0, with monotonically increasing elapsedMs.
    const onProgress = vi.fn();
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
        readPane: () => READY_CAPTURE,
        consumed: () => false, // never consumed → rides the whole short budget
        sendKeys: vi.fn(() => ({ ok: true, stderr: "" })),
        onProgress,
        readyAttempts: 1,
        consumeAttempts: 4,
      },
    );
    expect(result.status).toBe("launched-not-confirmed");
    // 4 consume attempts → 3 inter-interval progress emissions (300/600/900ms).
    expect(onProgress.mock.calls).toEqual([[300], [600], [900]]);
  });

  it("widened ready budget rides out a late draw (empty captures first, then drawn) → status 'started'", () => {
    // The pane is alive but draws nothing for the first two probes, then renders.
    // The wide readiness budget rides that out and readiness passes without
    // failing the launch; the seed is then delivered and consumption latches →
    // started.
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED, {
      blankDraws: 2,
    });
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
        readPane, // "" for the first two probes (late draw), then renders
        consumed,
        sendKeys,
        readyAttempts: 10,
        consumeAttempts: 5,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
  });

  it("happy path early-exits shortly after consumption latches instead of running the full consume budget", () => {
    // pollUntilConsumed must NOT block for the whole budget on success: once
    // consumed() latches it breaks into a short alive-confirm window. With a
    // large consumeAttempts budget and a pane that consumes on the first probe,
    // the liveness probe count must stay far below the budget — pre-fix the loop
    // ran the full `consumeAttempts` even on the happy path (issue #80).
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
    let aliveProbes = 0;
    const isAlive = () => {
      aliveProbes++;
      return true;
    };
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        readyAttempts: 1,
        consumeAttempts: 500,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    // 1 ready probe + 1 latch probe + a short alive-confirm window — a handful,
    // not the injected 500-attempt budget.
    expect(aliveProbes).toBeLessThan(20);
  });

  // --- chunked leading-line delivery (the seed-truncation hardening) ---

  const MULTI =
    "[pipeline-slug: csv-export]\nUse the /flow-pipeline skill for: csv export";
  const MULTI_LEAD = "[pipeline-slug: csv-export]";
  const MULTI_REMAINDER = "\nUse the /flow-pipeline skill for: csv export";

  it("chunked healthy path: leading-line send + remainder send + exactly one Enter, no C-u, no re-send", () => {
    const { sendKeys, readPane, consumed } = makeLaunchSeam(MULTI);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    const literals = sendKeys.mock.calls
      .filter((c) => c[2] === true)
      .map((c) => c[1]);
    expect(literals).toEqual([MULTI_LEAD, MULTI_REMAINDER]);
    expect(sendKeys.mock.calls.filter((c) => c[1] === "Enter")).toHaveLength(1);
    expect(sendKeys.mock.calls.some((c) => c[1] === "C-u")).toBe(false);
  });

  it("dropped-leading-prefix: sends C-u and re-sends the leading line ONLY (never the whole seed), then Enter", () => {
    const { sendKeys, readPane, consumed } = makeLaunchSeam(MULTI, {
      dropLeadingEchoes: 1,
    });
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("started");
    const keyed = sendKeys.mock.calls.map((c) => [c[1], c[2]]);
    expect(keyed).toContainEqual(["C-u", false]);
    // The leading line is re-sent (twice total); the whole seed is never sent.
    expect(
      keyed.filter((c) => c[0] === MULTI_LEAD && c[1] === true),
    ).toHaveLength(2);
    expect(keyed.some((c) => c[0] === MULTI)).toBe(false);
    expect(keyed[keyed.length - 1]).toEqual(["Enter", false]);
  });

  it("chip-safety: verification runs before the remainder, so a post-remainder chip capture never triggers a re-send or exhaust", () => {
    // makeLaunchSeam's capture collapses to a paste chip (no marker) once the
    // remainder is typed. deliverSeed must not capture there, so the launcher
    // neither re-sends the leading line nor exhausts its budget.
    const { sendKeys, readPane, consumed } = makeLaunchSeam(MULTI);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("started");
    expect(sendKeys.mock.calls.some((c) => c[1] === "C-u")).toBe(false);
    expect(
      sendKeys.mock.calls.filter((c) => c[1] === MULTI_LEAD && c[2] === true),
    ).toHaveLength(1);
  });

  it("bounded exhaustion: leading line never echoes ⇒ Enter is NEVER sent and the live pane stays non-destructive", () => {
    const kill = vi.fn(() => true);
    const { sendKeys, readPane } = makeLaunchSeam(MULTI, {
      dropLeadingEchoes: 99,
    });
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill,
        sleep: noopSleep,
        readPane,
        consumed: () => false,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("launched-not-confirmed");
    expect(sendKeys.mock.calls.some((c) => c[1] === "Enter")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("failed literal send: Enter is NEVER sent, the pane stays non-destructive, and the tmux stderr is surfaced", () => {
    const kill = vi.fn(() => true);
    const sendKeys = vi.fn((_s: string, keys: string, literal: boolean) =>
      literal
        ? { ok: false, stderr: "command too long" }
        : { ok: true, stderr: "" },
    );
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
        consumed: () => false,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("launched-not-confirmed");
    expect(result.stderr).toBe("command too long");
    expect(sendKeys.mock.calls.some((c) => c[1] === "Enter")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("oversized seed: the remainder is delivered as multiple bounded literal sends followed by exactly one Enter", () => {
    const body = "x".repeat(9000); // remainder exceeds one send-keys chunk
    const seed = `[pipeline-slug: csv-export]\n${body}`;
    const { sendKeys, readPane, consumed } = makeLaunchSeam(seed);
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      seed,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    const literals = sendKeys.mock.calls.filter((c) => c[2] === true);
    expect(literals.length).toBeGreaterThan(1);
    for (const c of literals) {
      expect(Buffer.byteLength(c[1] as string, "utf8")).toBeLessThanOrEqual(
        8192,
      );
    }
    expect(sendKeys.mock.calls.filter((c) => c[1] === "Enter")).toHaveLength(1);
  });

  it("settle gate: no send fires until the pane capture is stable across probes", () => {
    const leadingLine = "[pipeline-slug: csv-export]";
    const seed = `${leadingLine}\nbody`;
    let probes = 0;
    let firstSendAtProbe = -1;
    let leadingSent = false;
    let submitted = false;
    const readPane = () => {
      probes++;
      if (probes <= 2) return `changing-${probes}`; // unstable
      if (!leadingSent) return READY_CAPTURE; // stable
      return `${READY_CAPTURE}\n${leadingLine}`; // echo after the send
    };
    const sendKeys = vi.fn((_s: string, keys: string, literal: boolean) => {
      if (firstSendAtProbe < 0) firstSendAtProbe = probes;
      if (literal) leadingSent = true;
      if (!literal && keys === "Enter") submitted = true;
      return { ok: true, stderr: "" };
    });
    const result = createWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      seed,
      {
        create: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        kill: vi.fn(() => true),
        sleep: noopSleep,
        readPane,
        consumed: () => submitted,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("started");
    // The first send must not fire until the capture has stabilised past the
    // two changing frames (probe ≥ 3).
    expect(firstSendAtProbe).toBeGreaterThanOrEqual(3);
  });
});

describe(respawnWindowVerified, () => {
  // Mirrors the createWindowVerified block via the `respawn` deps seam (the
  // resume-path analogue of `create`). The single behavioral DIFFERENCE between
  // the two launchers — respawn does NOT kill the window on ANY verification
  // failure, because it pre-existed the resume and the user may want its
  // scrollback — is pinned via a cast-threaded kill spy. The real isPaneAlive /
  // capture-pane / send-keys are never exercised (they shell out
  // unconditionally), `sleep` is a no-op, and a tiny `readyAttempts`/
  // `consumeAttempts` budget runs the bounded polls instantly. respawnWindowVerified
  // takes a `seed` 4th positional arg (deps → 5th) and gates on the same
  // version-independent `consumed()` state-file-poll signal as the create path.
  const noopSleep = () => undefined;
  const SEED = "Use the /flow-pipeline skill in --resume mode for: csv-export";
  const budget = { readyAttempts: 3, consumeAttempts: 3 };

  it("respawn ok, pane ready, seed delivered + consumed → status 'started'", () => {
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
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
        consumed,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
  });

  it("respawn ok but the pane never becomes ready → status 'failed' AND does NOT kill the window (the create-vs-respawn asymmetry)", () => {
    // The behavioural difference from createWindowVerified: a verification
    // failure on resume yields 'failed' but leaves the (pre-existing) window
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
        consumed: () => false,
        ...budget,
        kill,
      } as Parameters<typeof respawnWindowVerified>[4],
    );
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/never became ready|pane not alive/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("propagates a failed respawn as status 'failed' without probing the pane", () => {
    const isAlive = vi.fn(() => true);
    const consumed = vi.fn(() => false);
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
        consumed,
        ...budget,
      },
    );
    expect(result).toEqual({
      status: "failed",
      stderr: "window not found for slug 'csv-export'",
    });
    expect(isAlive).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });

  it("catches the alive-then-dies race: alive on the first probe but dead at the end → status 'failed'", () => {
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
        consumed: () => false,
        ...budget,
      },
    );
    expect(result.status).toBe("failed");
  });

  it("vestigial guard: consumed() already true at ready-time skips send-keys (marker/baseline pre-satisfied)", () => {
    const sendKeys = vi.fn(() => ({ ok: true, stderr: "" }));
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
        consumed: () => true,
        sendKeys,
        ...budget,
      },
    );
    expect(result).toEqual({ status: "started", stderr: "" });
    expect(sendKeys).toHaveBeenCalledTimes(0);
  });

  it("short-budget consume-timeout with an ALIVE pane → 'launched-not-confirmed', respawn called exactly once, NEVER kills", () => {
    // Story 4: ready + alive but never consumed within the short budget →
    // non-destructive success. The respawn seam fires exactly once (no
    // re-respawn) and the cast-threaded kill spy never fires.
    const kill = vi.fn(() => true);
    const respawn = vi.fn(() => ({ ok: true, stderr: "" }));
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn,
        isAlive: () => true,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE, // ready but never consumed
        consumed: () => false,
        sendKeys: vi.fn(() => ({ ok: true, stderr: "" })),
        ...budget,
        kill,
      } as Parameters<typeof respawnWindowVerified>[4],
    );
    expect(result.status).toBe("launched-not-confirmed");
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("consume-then-die (Mode 3) → status 'failed' and does NOT kill the window", () => {
    // The pane becomes ready, the seed is delivered + consumed, then claude dies
    // before the end of the consume budget. Consumption LATCHES (monotonic) but
    // the FINAL liveness reading is false, so the verdict is 'failed'. Unlike the
    // create path, the window is NOT killed — it pre-existed the resume
    // (cast-threaded kill spy locks the no-kill invariant).
    const kill = vi.fn(() => true);
    const { sendKeys, readPane, consumed } = makeLaunchSeam(SEED);
    // Alive through the entire ready poll, then alive for exactly the FIRST
    // consume probe (so consumption LATCHES) and dead thereafter.
    let aliveAfterConsumed = 1;
    const isAlive = () => {
      if (!consumed()) return true;
      return aliveAfterConsumed-- > 0;
    };
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      SEED,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive,
        sleep: noopSleep,
        readPane,
        consumed,
        sendKeys,
        ...budget,
        kill,
      } as Parameters<typeof respawnWindowVerified>[4],
    );
    expect(result.status).toBe("failed");
    expect(kill).not.toHaveBeenCalled();
  });

  it("failed literal send: Enter is NEVER sent and the tmux stderr is surfaced (resume path)", () => {
    // The resume analogue of the create-path failed-literal-send guard: a
    // rejected literal send must not be followed by a submit Enter, and the
    // tmux stderr must reach VerifiedLaunchResult.stderr on the live pane.
    const MULTI = "[pipeline-slug: csv-export]\nresume body";
    const sendKeys = vi.fn((_s: string, keys: string, literal: boolean) =>
      literal
        ? { ok: false, stderr: "command too long" }
        : { ok: true, stderr: "" },
    );
    const result = respawnWindowVerified(
      "csv-export",
      "/repo",
      ["claude", "x"],
      MULTI,
      {
        respawn: () => ({ ok: true, stderr: "" }),
        isAlive: () => true,
        sleep: noopSleep,
        readPane: () => READY_CAPTURE,
        consumed: () => false,
        sendKeys,
        ...budget,
      },
    );
    expect(result.status).toBe("launched-not-confirmed");
    expect(result.stderr).toBe("command too long");
    expect(sendKeys.mock.calls.some((c) => c[1] === "Enter")).toBe(false);
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

  /**
   * Multi-result fake: returns successive results per call index. Useful for
   * testing functions that make multiple sequential spawnTmux calls (e.g.
   * show-options then display-message).
   */
  function fakeSpawnSequence(results: SpawnResult[]): {
    calls: string[][];
    spawnTmux: (args: string[]) => SpawnResult;
  } {
    const calls: string[][] = [];
    let callIndex = 0;
    return {
      calls,
      spawnTmux: (args) => {
        calls.push(args);
        const result = results[callIndex] ?? results[results.length - 1];
        callIndex++;
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
    // fakeSpawn returns the same result for both calls:
    // 1) show-options → stdout "csv-export\n"
    // 2) display-message → stdout "csv-export\n" (treated as pane window id,
    //    but since listWindowsFn is absent → listWindows() → [] → no owner found
    //    → safe-degradation → slug returned unchanged)
    const { calls, spawnTmux } = fakeSpawn({
      stdout: "csv-export\n",
      stderr: "",
      exitCode: 0,
    });
    expect(resolveSlugFromPane({ env: { TMUX_PANE: "%42" }, spawnTmux })).toBe(
      "csv-export",
    );
    // First call: the show-options lookup for @flow-slug.
    expect(calls[0]).toEqual([
      "show-options",
      "-t",
      "%42",
      "-v",
      "-w",
      "@flow-slug",
    ]);
    // Second call: display-message for the cross-check.
    expect(calls[1]).toEqual([
      "display-message",
      "-t",
      "%42",
      "-p",
      "#{window_id}",
    ]);
  });

  // Cross-check tests: the second spawnTmux call is display-message.
  // A single spawnTmux mock returns different values per call index via
  // fakeSpawnSequence.

  it("cross-check: window-id match — returns the slug unchanged", () => {
    const { calls, spawnTmux } = fakeSpawnSequence([
      { stdout: "csv-export\n", stderr: "", exitCode: 0 }, // show-options
      { stdout: "@7\n", stderr: "", exitCode: 0 }, // display-message
    ]);
    const windows: TmuxWindow[] = [
      { id: "@7", name: "csv-export", slug: "csv-export", activity: 0 },
    ];
    const result = resolveSlugFromPane({
      env: { TMUX_PANE: "%42" },
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toBe("csv-export");
    expect(calls[0][0]).toBe("show-options");
    expect(calls[1][0]).toBe("display-message");
  });

  it("cross-check: window-id mismatch — warns to stderr and returns null", () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const writeStub = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    };
    process.stderr.write = writeStub as typeof process.stderr.write;
    const { spawnTmux } = fakeSpawnSequence([
      { stdout: "csv-export\n", stderr: "", exitCode: 0 }, // show-options
      { stdout: "@7\n", stderr: "", exitCode: 0 }, // display-message → pane is in @7
    ]);
    // But the slug is owned by @8, not @7 → mismatch
    const windows: TmuxWindow[] = [
      { id: "@8", name: "csv-export", slug: "csv-export", activity: 0 },
    ];
    const result = resolveSlugFromPane({
      env: { TMUX_PANE: "%42" },
      spawnTmux,
      listWindowsFn: () => windows,
    });
    process.stderr.write = origWrite;
    expect(result).toBeNull();
    const warning = stderrChunks.join("");
    expect(warning).toContain("csv-export");
    expect(warning).toContain("@8");
    expect(warning).toContain("@7");
  });

  it("cross-check: no window owns the slug — returns slug unchanged (no false negative)", () => {
    const { spawnTmux } = fakeSpawnSequence([
      { stdout: "csv-export\n", stderr: "", exitCode: 0 }, // show-options
      { stdout: "@7\n", stderr: "", exitCode: 0 }, // display-message
    ]);
    // listWindowsFn returns windows with different slugs — no owner found
    const windows: TmuxWindow[] = [
      { id: "@3", name: "other", slug: "other-pipeline", activity: 0 },
    ];
    const result = resolveSlugFromPane({
      env: { TMUX_PANE: "%42" },
      spawnTmux,
      listWindowsFn: () => windows,
    });
    expect(result).toBe("csv-export");
  });

  it("cross-check: display-message fails — returns slug unchanged (safe degradation)", () => {
    const { spawnTmux } = fakeSpawnSequence([
      { stdout: "csv-export\n", stderr: "", exitCode: 0 }, // show-options
      { stdout: "", stderr: "no client", exitCode: 1 }, // display-message fails
    ]);
    const windows: TmuxWindow[] = [
      { id: "@8", name: "csv-export", slug: "csv-export", activity: 0 },
    ];
    const result = resolveSlugFromPane({
      env: { TMUX_PANE: "%42" },
      spawnTmux,
      listWindowsFn: () => windows,
    });
    // display-message failure → safe degradation, no cross-check, slug returned
    expect(result).toBe("csv-export");
  });
});

describe("retired TUI-string detection surface", () => {
  // Standing CI guard for the whole point of this refactor (issue #85): the
  // version-coupled detection symbols — and the `v2.1.191` Claude Code version
  // literal they were pinned to — were deleted, but their deletion is otherwise
  // unguarded; a future change could silently reintroduce one and resurrect the
  // exact version coupling this PR removed. Read the source and assert each
  // stays absent, converting the PR's manual grep (Test Step #4) into a
  // deterministic regression test that fails CI on reintroduction.
  const RETIRED_SYMBOLS = [
    "parsePaneConsumed",
    "parsePaneReady",
    "CONSUMPTION_MARKERS",
    "READY_MARKERS",
    "WELCOME_BANNER_HEADER",
    "IDLE_INPUT_PLACEHOLDER",
    "v2.1.191",
  ];
  const tmuxSource = fs.readFileSync(
    fileURLToPath(new URL("./tmux.ts", import.meta.url)),
    "utf8",
  );

  it.each(RETIRED_SYMBOLS)(
    "does not reintroduce the retired symbol '%s' in tmux.ts",
    (symbol) => {
      expect(tmuxSource).not.toContain(symbol);
    },
  );
});
