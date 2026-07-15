/**
 * CLI exit-code + notice behavior for `flow-module-status`, driven via
 * `runModuleStatus(argv, deps)` with injected fixture deps — never a real
 * subprocess against `~/.flow`.
 */

import { describe, expect, it } from "vitest";
import { runModuleStatus } from "./flow-module-status";
import type { Manifest, SymlinkRecord } from "./lib/manifest";
import { MODULES } from "./lib/modules";

const EMPTY_MANIFEST: Manifest = { version: 1, symlinks: [] };

function record(name: string): SymlinkRecord {
  return {
    source: `/fake/src/${name}`,
    target: `/fake/home/${name}`,
    kind: "bin",
  };
}

function fullManifest(): Manifest {
  const symlinks: SymlinkRecord[] = [];
  for (const m of MODULES) {
    for (const name of [
      ...m.skills,
      ...m.agents,
      ...m.helpers,
      ...m.validators,
    ]) {
      symlinks.push(record(name));
    }
  }
  return { version: 1, symlinks };
}

/** Everything but `core` deselected (fallback path, unset selection). */
const deselectedDeps = {
  readManifest: () => EMPTY_MANIFEST,
  readSelection: () => undefined,
};

/** `copilot` selected alongside the mandatory `core`. */
const copilotActiveDeps = {
  readManifest: () => EMPTY_MANIFEST,
  readSelection: () => ["copilot"],
};

/** Every module fully linked — the `--all` no-op case. */
const fullDeps = { readManifest: () => fullManifest() };

describe("runModuleStatus --check", () => {
  it("an inactive module exits 3 with a notice on stderr", () => {
    const result = runModuleStatus(["--check", "research"], deselectedDeps);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("research");
    expect(result.stderr).toContain("flow install --modules research");
    expect(result.stdout).toBe("");
  });

  it("an active module exits 0 with no stderr", () => {
    const result = runModuleStatus(["--check", "copilot"], copilotActiveDeps);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("an unknown module id exits 2", () => {
    const result = runModuleStatus(["--check", "nope"], deselectedDeps);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nope");
  });

  it("--json on an inactive module prints the skipEnvelope and exits 0", () => {
    const result = runModuleStatus(
      ["--json", "--check", "research"],
      deselectedDeps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ran: false,
      skipReason: "research-module-deselected",
    });
  });

  it("--json on an active module prints {ran:true} and exits 0", () => {
    const result = runModuleStatus(
      ["--json", "--check", "copilot"],
      copilotActiveDeps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ran: true });
  });
});

describe("runModuleStatus --check-skill", () => {
  it("a skill owned by a deselected module exits 3", () => {
    const result = runModuleStatus(["--check-skill", "svelte"], deselectedDeps);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("stack-svelte");
  });

  it("a skill owned by an active module exits 0", () => {
    const result = runModuleStatus(["--check-skill", "svelte"], fullDeps);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("an unknown skill exits 0 (not gated)", () => {
    const result = runModuleStatus(
      ["--check-skill", "not-a-real-skill"],
      deselectedDeps,
    );
    expect(result.code).toBe(0);
  });

  it("--json on a skill owned by a deselected module prints the owning module's skipEnvelope", () => {
    const result = runModuleStatus(
      ["--json", "--check-skill", "svelte"],
      deselectedDeps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ran: false,
      skipReason: "stack-svelte-module-deselected",
    });
  });

  it("--json on a skill owned by an active module prints {ran:true}", () => {
    const result = runModuleStatus(
      ["--json", "--check-skill", "svelte"],
      fullDeps,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ran: true });
  });
});

describe("runModuleStatus --summary", () => {
  it("a full selection lists zero inactive optionals and shows core active", () => {
    const result = runModuleStatus(["--summary"], fullDeps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("core: active");
    expect(result.stdout).not.toMatch(/inactive/);
  });

  it("no args behaves the same as --summary", () => {
    const bare = runModuleStatus([], fullDeps);
    const withFlag = runModuleStatus(["--summary"], fullDeps);
    expect(bare).toEqual(withFlag);
  });

  it("a deselected fixture lists the deselected optionals as inactive", () => {
    const result = runModuleStatus(["--summary"], deselectedDeps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("research: inactive");
  });
});
