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

describe("runModuleStatus --skill-path", () => {
  const home = "/fake/home-skills";
  const overlay = "/fake/overlays/pipe/.claude/skills";
  const withFiles = (files: string[], extra: Record<string, unknown> = {}) => ({
    ...fullDeps,
    homeSkillsDir: home,
    overlaySkills: () => overlay,
    fileExists: (p: string) => files.includes(p),
    ...extra,
  });
  const ui = (root: string, ref = "SKILL.md") =>
    `${root}/flow-module-core/skills/flow-ui-ux/${ref}`;

  it("prints the claude-home path for a bare or prefixed skill name", () => {
    const deps = withFiles([ui(home)]);
    for (const name of ["ui-ux", "flow-ui-ux"]) {
      const r = runModuleStatus(["--skill-path", name], deps);
      expect(r).toEqual({ code: 0, stdout: `${ui(home)}\n`, stderr: "" });
    }
  });

  it("honours FLOW_CLAUDE_HOME_SKILLS_DIR as the claude-home root when set", () => {
    const prior = process.env.FLOW_CLAUDE_HOME_SKILLS_DIR;
    process.env.FLOW_CLAUDE_HOME_SKILLS_DIR = "/eval/skills";
    try {
      const { homeSkillsDir: _unused, ...deps } = withFiles([
        ui("/eval/skills"),
      ]);
      const r = runModuleStatus(["--skill-path", "ui-ux"], deps);
      expect(r.stdout).toBe(`${ui("/eval/skills")}\n`);
    } finally {
      if (prior === undefined) delete process.env.FLOW_CLAUDE_HOME_SKILLS_DIR;
      else process.env.FLOW_CLAUDE_HOME_SKILLS_DIR = prior;
    }
  });

  it("prefers the pipeline overlay when it exists", () => {
    const deps = withFiles([overlay, ui(overlay), ui(home)], { slug: "pipe" });
    const r = runModuleStatus(["--skill-path", "ui-ux"], deps);
    expect(r.stdout).toBe(`${ui(overlay)}\n`);
  });

  it("falls back to claude-home when the slug has no overlay", () => {
    const deps = withFiles([ui(home)], { slug: "pipe" });
    expect(runModuleStatus(["--skill-path", "ui-ux"], deps).stdout).toBe(
      `${ui(home)}\n`,
    );
  });

  it("resolves a --ref under the skill", () => {
    const deps = withFiles([ui(home, "references/layout.md")]);
    const r = runModuleStatus(
      ["--skill-path", "ui-ux", "--ref", "references/layout.md"],
      deps,
    );
    expect(r.stdout).toBe(`${ui(home, "references/layout.md")}\n`);
  });

  it.each(["/etc/passwd", "../x.md", "references/../../x.md", "..\\x.md"])(
    "rejects --ref %s with exit 2",
    (ref) => {
      const r = runModuleStatus(
        ["--skill-path", "ui-ux", "--ref", ref],
        withFiles([]),
      );
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    },
  );

  it("exits 3 with a distinct line for an unknown skill or a missing file", () => {
    const unknown = runModuleStatus(
      ["--skill-path", "not-a-skill"],
      withFiles([]),
    );
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain("skill-path-not-found: not-a-skill");
    const missing = runModuleStatus(["--skill-path", "ui-ux"], withFiles([]));
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain(`skill-path-not-found: ${ui(home)}`);
  });

  it("exits 3 with the module notice for a deselected module", () => {
    const r = runModuleStatus(["--skill-path", "svelte"], {
      ...deselectedDeps,
      fileExists: () => true,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("stack-svelte");
  });

  it("requires a value and rejects --ref on its own", () => {
    expect(runModuleStatus(["--skill-path"], withFiles([])).code).toBe(2);
    expect(runModuleStatus(["--ref", "a.md"], withFiles([])).code).toBe(2);
  });
});
