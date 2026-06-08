import { describe, expect, it, vi } from "vitest";
import {
  buildOsascriptScript,
  buildPayload,
  buildTerminalNotifierArgs,
  dispatch,
  escapeForAppleScript,
  parseArgs,
  run,
  type Deps,
} from "./flow-notify";

describe("parseArgs", () => {
  it("requires --status", () => {
    expect(parseArgs([])).toEqual({ error: "--status is required" });
  });

  it("rejects an invalid status", () => {
    const result = parseArgs(["--status", "bogus"]);
    expect(result).toMatchObject({
      error: expect.stringContaining("--status must be one of"),
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--bogus", "x"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("rejects a flag with no value", () => {
    expect(parseArgs(["--status"])).toEqual({
      error: "--status requires a value",
    });
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(parseArgs(["--status", "--reason"])).toEqual({
      error: "--status requires a value",
    });
  });

  it("parses a full arg set", () => {
    expect(
      parseArgs([
        "--status",
        "merged",
        "--slug",
        "csv-export",
        "--reason",
        "all green",
        "--url",
        "https://github.com/o/r/pull/1",
      ]),
    ).toEqual({
      status: "merged",
      slug: "csv-export",
      reason: "all green",
      url: "https://github.com/o/r/pull/1",
    });
  });

  it.each(["merged", "gated", "needs-human"])("accepts status %s", (status) => {
    expect(parseArgs(["--status", status])).toMatchObject({ status });
  });
});

describe("buildPayload", () => {
  it("uses the status in the title and the slug as subtitle", () => {
    expect(buildPayload({ status: "merged", slug: "csv-export" })).toEqual({
      title: "flow: merged",
      subtitle: "csv-export",
      message: "(no reason)",
    });
  });

  it("falls back to '(no reason)' when reason is missing", () => {
    expect(buildPayload({ status: "needs-human" }).message).toBe("(no reason)");
  });

  it("collapses whitespace and trims a long reason", () => {
    const long = `${"x".repeat(125)}\n\nmore`;
    const payload = buildPayload({ status: "gated", reason: long });
    expect(payload.message.endsWith("…")).toBe(true);
    expect(payload.message.length).toBe(121);
  });

  it("preserves a short single-line reason verbatim", () => {
    expect(
      buildPayload({ status: "gated", reason: "validate the smoke test" })
        .message,
    ).toBe("validate the smoke test");
  });
});

describe("escapeForAppleScript", () => {
  it("escapes quotes and backslashes in order", () => {
    expect(escapeForAppleScript('a "b" \\c')).toBe('a \\"b\\" \\\\c');
  });

  it("collapses newlines into spaces", () => {
    expect(escapeForAppleScript("a\nb\r\nc")).toBe("a b c");
  });
});

describe("buildOsascriptScript", () => {
  it("includes title, subtitle, and message", () => {
    const script = buildOsascriptScript({
      title: "flow: merged",
      subtitle: "csv-export",
      message: "all green",
    });
    expect(script).toContain('with title "flow: merged"');
    expect(script).toContain('subtitle "csv-export"');
    expect(script).toContain('display notification "all green"');
  });

  it("omits the subtitle clause when subtitle is empty", () => {
    const script = buildOsascriptScript({
      title: "flow: merged",
      subtitle: "",
      message: "all green",
    });
    expect(script).not.toContain("subtitle");
  });
});

describe("buildTerminalNotifierArgs", () => {
  it("appends -open when a url is provided", () => {
    const argv = buildTerminalNotifierArgs(
      { title: "flow: merged", subtitle: "csv-export", message: "all green" },
      "https://github.com/o/r/pull/1",
    );
    expect(argv).toEqual([
      "-title",
      "flow: merged",
      "-subtitle",
      "csv-export",
      "-message",
      "all green",
      "-open",
      "https://github.com/o/r/pull/1",
    ]);
  });

  it("omits -open when no url", () => {
    const argv = buildTerminalNotifierArgs(
      { title: "flow: gated", subtitle: "csv-export", message: "validate" },
      undefined,
    );
    expect(argv).not.toContain("-open");
  });

  it("omits -subtitle when subtitle is empty", () => {
    const argv = buildTerminalNotifierArgs(
      { title: "flow: needs-human", subtitle: "", message: "verify-exhausted" },
      undefined,
    );
    expect(argv).not.toContain("-subtitle");
  });
});

function makeDeps(
  overrides: Partial<Deps> = {},
): Deps & { calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    platform: "darwin",
    env: { FLOW_NOTIFY: "1" },
    hasTerminalNotifier: () => false,
    spawnDetached: (cmd, args) => {
      calls.push({ cmd, args });
    },
    resolveSlug: () => null,
    calls,
    ...overrides,
  };
}

describe("dispatch", () => {
  it("is a no-op when FLOW_NOTIFY is unset", () => {
    const deps = makeDeps({ env: {} });
    const result = dispatch({ status: "merged" }, deps);
    expect(result).toEqual({ dispatched: false, reason: "no-opt-in" });
    expect(deps.calls).toHaveLength(0);
  });

  it.each(["0", "true", "yes", ""])("is a no-op when FLOW_NOTIFY=%s", (val) => {
    const deps = makeDeps({ env: { FLOW_NOTIFY: val } });
    const result = dispatch({ status: "merged" }, deps);
    expect(result).toEqual({ dispatched: false, reason: "no-opt-in" });
    expect(deps.calls).toHaveLength(0);
  });

  it("is a no-op on non-darwin even when FLOW_NOTIFY=1", () => {
    const deps = makeDeps({ platform: "linux" });
    const result = dispatch({ status: "merged" }, deps);
    expect(result).toEqual({ dispatched: false, reason: "non-darwin" });
    expect(deps.calls).toHaveLength(0);
  });

  it("uses terminal-notifier when available", () => {
    const deps = makeDeps({ hasTerminalNotifier: () => true });
    const result = dispatch(
      {
        status: "merged",
        slug: "csv-export",
        url: "https://github.com/o/r/pull/1",
      },
      deps,
    );
    expect(result).toMatchObject({
      dispatched: true,
      backend: "terminal-notifier",
    });
    expect(deps.calls).toEqual([
      {
        cmd: "terminal-notifier",
        args: [
          "-title",
          "flow: merged",
          "-subtitle",
          "csv-export",
          "-message",
          "(no reason)",
          "-open",
          "https://github.com/o/r/pull/1",
        ],
      },
    ]);
  });

  it("falls back to osascript when terminal-notifier is missing", () => {
    const deps = makeDeps({ hasTerminalNotifier: () => false });
    const result = dispatch(
      { status: "needs-human", reason: "verify-exhausted" },
      deps,
    );
    expect(result).toMatchObject({ dispatched: true, backend: "osascript" });
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]?.cmd).toBe("osascript");
    expect(deps.calls[0]?.args[0]).toBe("-e");
    expect(deps.calls[0]?.args[1]).toContain("flow: needs-human");
    expect(deps.calls[0]?.args[1]).toContain("verify-exhausted");
  });

  it("auto-resolves --slug from $TMUX_PANE when omitted", () => {
    const deps = makeDeps({
      hasTerminalNotifier: () => true,
      resolveSlug: () => "csv-export",
    });
    dispatch({ status: "merged" }, deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]?.args).toContain("csv-export");
  });

  it("prefers an explicit --slug over the pane resolver (back-compat)", () => {
    const deps = makeDeps({
      hasTerminalNotifier: () => true,
      // Resolver returns a different slug than the explicit flag — explicit wins.
      resolveSlug: () => "other-pipeline",
    });
    dispatch({ status: "merged", slug: "csv-export" }, deps);
    expect(deps.calls[0]?.args).toContain("csv-export");
    expect(deps.calls[0]?.args).not.toContain("other-pipeline");
  });

  it("dispatches with an empty subtitle when no slug is given and pane has none", () => {
    const deps = makeDeps({
      hasTerminalNotifier: () => true,
      resolveSlug: () => null,
    });
    const result = dispatch(
      { status: "needs-human", reason: "verify-exhausted" },
      deps,
    );
    expect(result).toMatchObject({ dispatched: true });
    // No -subtitle flag at all — buildTerminalNotifierArgs omits it for empty subtitle.
    expect(deps.calls[0]?.args).not.toContain("-subtitle");
  });
});

describe("run", () => {
  it("returns 2 on a parse error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run([])).toBe(2);
    errSpy.mockRestore();
  });

  it("returns 0 even when the dispatch is suppressed", () => {
    expect(
      run(["--status", "merged"], {
        platform: "darwin",
        env: {},
        hasTerminalNotifier: () => false,
        spawnDetached: () => {},
      }),
    ).toBe(0);
  });

  it("returns 0 on a successful dispatch and invokes spawnDetached once", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exit = run(["--status", "merged", "--slug", "csv-export"], {
      platform: "darwin",
      env: { FLOW_NOTIFY: "1" },
      hasTerminalNotifier: () => false,
      spawnDetached: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("osascript");
  });
});
