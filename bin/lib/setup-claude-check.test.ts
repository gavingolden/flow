import { describe, it, expect } from "vitest";
import {
  checkClaudeRunnable,
  formatClaudeCheckWarning,
} from "./setup-claude-check";

describe("checkClaudeRunnable", () => {
  it("ok when the injected runner reports a clean probe", () => {
    const result = checkClaudeRunnable(() => ({
      ok: true,
      stdout: "2.1.216 (Claude Code)",
    }));
    expect(result).toEqual({ ok: true });
  });

  it("not-on-path when the runner throws (missing binary)", () => {
    const result = checkClaudeRunnable(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), {
        code: "ENOENT",
      });
    });
    expect(result).toEqual({ ok: false, reason: "not-on-path" });
  });

  it("probe-failed with detail when the probe exits non-zero", () => {
    const result = checkClaudeRunnable(() => ({
      ok: false,
      stderr: "segfault\n",
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe-failed: segfault");
  });

  it("probe-failed with a generic detail when the probe emits nothing", () => {
    const result = checkClaudeRunnable(() => ({ ok: false }));
    expect(result.reason).toBe("probe-failed: exit non-zero");
  });
});

describe("formatClaudeCheckWarning", () => {
  it("names the PATH problem and points at the fix", () => {
    const msg = formatClaudeCheckWarning("not-on-path");
    expect(msg).toMatch(/not on PATH/);
    expect(msg).toMatch(/claude --version/);
  });

  it("carries the probe detail through", () => {
    const msg = formatClaudeCheckWarning("probe-failed: segfault");
    expect(msg).toMatch(/probe-failed: segfault/);
  });
});
