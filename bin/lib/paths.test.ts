/**
 * Direct, independently-derived contract tests for `bin/lib/paths.ts`'s
 * `repoCacheKey`, a rename tripwire for the agent-memory constants, and the
 * call-time HOME resolution of every home-derived accessor (the repo-wide
 * load-time-capture scan lives in bin/home-capture-lint.test.ts).
 *
 * Every expectation below is computed inline from `node:crypto` /
 * `node:path` — never by calling `repoCacheKey` to build the expected
 * value. Deriving the expected value FROM the function under test would
 * make this suite pass even if the key formula, the realpath resolution,
 * or the truncation width silently drifted.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import { DEFAULT_TARGETS } from "./sources";
import {
  AGENT_MEMORY_DIRNAME,
  AGENT_MEMORY_RELPATH,
  flowRunAttributionLogPath,
  flowTelemetryLogPath,
  repoCacheKey,
} from "./paths";

function expectedKey(dir: string): string {
  const real = fs.realpathSync(dir);
  const base = path.basename(real);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

describe("repoCacheKey", () => {
  let dir!: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-repo-cache-key-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches the documented shape: <basename>-<8 hex chars>", () => {
    expect(repoCacheKey(dir)).toMatch(/^[^/]+-[0-9a-f]{8}$/);
  });

  it("equals basename(real) + '-' + sha256(real) truncated to 8 hex chars", () => {
    expect(repoCacheKey(dir)).toBe(expectedKey(dir));
  });

  it("resolves through a symlink to the same key as its real target", () => {
    const linkParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-link-"),
    );
    const linkPath = path.join(linkParent, "link-to-dir");
    fs.symlinkSync(dir, linkPath);
    try {
      expect(repoCacheKey(linkPath)).toBe(expectedKey(dir));
      expect(repoCacheKey(linkPath)).toBe(repoCacheKey(dir));
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("disambiguates two identically-named directories at different paths", () => {
    const parentA = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-a-"),
    );
    const parentB = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-b-"),
    );
    const dirA = path.join(parentA, "same-name");
    const dirB = path.join(parentB, "same-name");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    try {
      expect(path.basename(dirA)).toBe(path.basename(dirB));
      expect(repoCacheKey(dirA)).not.toBe(repoCacheKey(dirB));
      expect(repoCacheKey(dirA)).toBe(expectedKey(dirA));
      expect(repoCacheKey(dirB)).toBe(expectedKey(dirB));
    } finally {
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
    }
  });
});

describe("agent-memory constants (rename tripwire)", () => {
  // Deliberately hardcoded literals on BOTH sides — never
  // `AGENT_MEMORY_DIRNAME`/`AGENT_MEMORY_RELPATH` referenced against
  // themselves. A future rename of the constant's VALUE must fail this
  // test even though every call site still compiles and stays internally
  // consistent.
  it("AGENT_MEMORY_DIRNAME is the literal 'agent-memory-local'", () => {
    expect(AGENT_MEMORY_DIRNAME).toBe("agent-memory-local");
  });

  it("AGENT_MEMORY_RELPATH is the literal '.claude/agent-memory-local'", () => {
    expect(AGENT_MEMORY_RELPATH).toBe(".claude/agent-memory-local");
  });
});

describe("flowTelemetryLogPath", () => {
  it("resolves under the passed homeDir, not the real HOME", () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-telemetry-home-"),
    );
    try {
      const result = flowTelemetryLogPath(tmpHome);
      expect(result).toBe(
        path.join(tmpHome, ".flow", "telemetry", "events.jsonl"),
      );
      expect(result.startsWith(tmpHome)).toBe(true);
      expect(result).not.toContain(os.homedir());
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("defaults to the current home when no homeDir is passed", () => {
    expect(flowTelemetryLogPath()).toBe(
      path.join(os.homedir(), ".flow", "telemetry", "events.jsonl"),
    );
  });
});

describe("flowRunAttributionLogPath", () => {
  it("resolves under the passed homeDir", () => {
    expect(flowRunAttributionLogPath("/tmp/h")).toBe(
      path.join("/tmp/h", ".flow", "telemetry", "run-attribution.jsonl"),
    );
  });

  it("defaults to the current home when no homeDir is passed", () => {
    expect(flowRunAttributionLogPath()).toBe(
      path.join(os.homedir(), ".flow", "telemetry", "run-attribution.jsonl"),
    );
  });
});

const loadTimeHome = process.env.HOME as string;

const HOME_ACCESSORS = Object.entries(paths)
  .filter(
    ([name, value]) => typeof value === "function" && name !== "repoCacheKey",
  )
  .map(([name]) => name);

const pathFns = paths as unknown as Record<string, (...a: never[]) => unknown>;

const NOT_HOME_PATHS = new Set([
  "configuredFlowSource",
  "resolveFlowSource",
  "currentHome",
]);

const ZERO_ARG_ACCESSORS = HOME_ACCESSORS.filter(
  (name) => !NOT_HOME_PATHS.has(name) && pathFns[name].length === 0,
);

describe("home-derived paths resolve at call time", () => {
  let laterHome!: string;

  beforeEach(() => {
    laterHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "paths-later-home-")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(laterHome, { recursive: true, force: true });
  });

  it("follows a HOME change made after import", () => {
    vi.stubEnv("HOME", laterHome);

    for (const name of ZERO_ARG_ACCESSORS) {
      const resolved = pathFns[name]() as string;
      expect(resolved.startsWith(laterHome + path.sep), name).toBe(true);
    }
    expect(paths.installedHelperPath("flow").startsWith(laterHome)).toBe(true);
    expect(paths.resolveFlowSource()).toBeTypeOf("string");
    expect(paths.flowTelemetryLogPath().startsWith(laterHome)).toBe(true);
    for (const [key, value] of Object.entries(DEFAULT_TARGETS)) {
      expect(value.startsWith(laterHome + path.sep), key).toBe(true);
    }
  });

  it("currentHome follows a HOME change made after import", () => {
    vi.stubEnv("HOME", laterHome);
    expect(paths.currentHome()).toBe(laterHome);
  });

  it("exports no value captured from the import-time home", () => {
    for (const [name, value] of Object.entries(paths)) {
      if (typeof value !== "string") continue;
      expect(
        path.isAbsolute(value) && value.startsWith(loadTimeHome),
        name,
      ).toBe(false);
    }
  });
});
