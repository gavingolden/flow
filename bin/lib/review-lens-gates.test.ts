import { describe, expect, it } from "vitest";
import { AGENT_LENS_MAP } from "../flow-pr-agent-lens";
import { composeSpawnSet } from "./review-tier";
import {
  evaluateGates,
  hasNewBareImports,
  isDocsOnly,
  matchesAny,
  OPTIONAL_LENSES,
  SECURITY_SENSITIVE_GLOBS,
} from "./review-lens-gates";

describe("evaluateGates", () => {
  it("skips supply-chain when no changed file matches a manifest/lockfile", () => {
    const gates = evaluateGates(["src/foo.ts"], { enabled: true });
    expect(gates["supply-chain"].run).toBe(false);
    expect(gates["supply-chain"].reason).toContain(
      "no manifest/lockfile among",
    );
  });

  it("runs supply-chain when package.json or bun.lock changed", () => {
    expect(
      evaluateGates(["package.json"], { enabled: true })["supply-chain"].run,
    ).toBe(true);
    expect(
      evaluateGates(["bun.lock"], { enabled: true })["supply-chain"].run,
    ).toBe(true);
  });

  it("runs supply-chain when bunfig.toml / .yarnrc.yml / a nested .npmrc / .github/dependabot.yml / a nested Dockerfile changed", () => {
    for (const file of [
      "bunfig.toml",
      ".yarnrc.yml",
      "apps/web/.npmrc",
      ".github/dependabot.yml",
      "docker/service/Dockerfile.prod",
    ]) {
      expect(evaluateGates([file], { enabled: true })["supply-chain"].run).toBe(
        true,
      );
    }
  });

  it("gate-skips supply-chain with no manifest changed and no bare import — composeSpawnSet is now the site that forces it back on when static analysis hits", () => {
    const gates = evaluateGates(["src/foo.ts"], {
      enabled: true,
    });
    expect(gates["supply-chain"].run).toBe(false);

    const composed = composeSpawnSet({
      gates,
      tier: "standard",
      staticAnalysisHits: ["supply-chain"],
    });
    expect(composed["supply-chain"].run).toBe(true);
  });

  it("gates performance, security and test-coverage off on a docs-only file set and keeps bug-detection and pattern-consistency on", () => {
    const gates = evaluateGates(["docs/foo.md", "README.md"], {
      enabled: true,
    });
    expect(gates.performance.run).toBe(false);
    expect(gates.security.run).toBe(false);
    expect(gates["test-coverage"].run).toBe(false);
    expect(gates["bug-detection"].run).toBe(true);
    expect(gates["pattern-consistency"].run).toBe(true);
  });

  it("does not apply the docs-only rule when the set includes skills/**, agents/**, .github/**, AGENTS.md, CLAUDE.md or templates/**", () => {
    for (const file of [
      "skills/foo/SKILL.md",
      "agents/core/foo.md",
      ".github/workflows/ci.yml",
      "AGENTS.md",
      "CLAUDE.md",
      "templates/AGENTS.md.template",
    ]) {
      const gates = evaluateGates(["docs/x.md", file], { enabled: true });
      expect(gates.performance.run).toBe(true);
      expect(gates["test-coverage"].run).toBe(true);
    }
  });

  it("gate-skips security on a docs-only set — composeSpawnSet is now the site that forces it back on when static analysis hits", () => {
    const gates = evaluateGates(["docs/foo.md"], {
      enabled: true,
    });
    expect(gates.security.run).toBe(false);

    const composed = composeSpawnSet({
      gates,
      tier: "standard",
      staticAnalysisHits: ["security"],
    });
    expect(composed.security.run).toBe(true);
  });

  it("returns run:true reason 'gates disabled' for every lens when enabled:false, except optional lenses (gated on a precondition, never on `enabled`)", () => {
    const gates = evaluateGates(["docs/foo.md"], { enabled: false });
    for (const name of Object.keys(AGENT_LENS_MAP)) {
      if ((OPTIONAL_LENSES as readonly string[]).includes(name)) continue;
      expect(gates[name as keyof typeof gates]).toEqual({
        run: true,
        reason: "gates disabled",
      });
    }
  });

  it("gates the product lens on brief presence, run true only when a brief resolved", () => {
    const found = evaluateGates(["src/foo.ts"], {
      enabled: true,
      productBrief: { found: true, scope: "repo" },
    });
    expect(found.product).toEqual({
      run: true,
      reason: "product brief resolved (repo)",
    });

    const absent = evaluateGates(["src/foo.ts"], {
      enabled: true,
      productBrief: { found: false },
    });
    expect(absent.product).toEqual({
      run: false,
      reason: "no product brief resolved",
    });

    const noOpt = evaluateGates(["src/foo.ts"], { enabled: true });
    expect(noOpt.product).toEqual({
      run: false,
      reason: "no product brief resolved",
    });
  });

  it("keeps the product lens off under enabled:false + brief absent, never fabricating 'gates disabled'", () => {
    const gates = evaluateGates(["docs/foo.md"], {
      enabled: false,
      productBrief: { found: false },
    });
    expect(gates.product).toEqual({
      run: false,
      reason: "no product brief resolved",
    });
  });

  it("treats an empty file list as NOT docs-only so no lens is gated by the docs rule", () => {
    expect(isDocsOnly([])).toBe(false);
    const gates = evaluateGates([], { enabled: true });
    expect(gates.performance.run).toBe(true);
    expect(gates.security.run).toBe(true);
    expect(gates["test-coverage"].run).toBe(true);
  });

  it("produces a verdict for every AgentName key in AGENT_LENS_MAP", () => {
    const gates = evaluateGates(["src/foo.ts"], { enabled: true });
    expect(new Set(Object.keys(gates))).toEqual(
      new Set(Object.keys(AGENT_LENS_MAP)),
    );
  });

  it("runs supply-chain with reason 'new bare-specifier import in diff' when opts.newBareImports is true and no manifest changed", () => {
    const gates = evaluateGates(["src/foo.ts"], {
      enabled: true,
      newBareImports: true,
    });
    expect(gates["supply-chain"]).toEqual({
      run: true,
      reason: "new bare-specifier import in diff",
    });
  });
});

describe("hasNewBareImports", () => {
  it('returns true for an added `import x from "picomatch"` line', () => {
    expect(hasNewBareImports('+import x from "picomatch";')).toBe(true);
  });

  it('returns true for an added `const y = require("chalk")` line', () => {
    expect(hasNewBareImports('+const y = require("chalk");')).toBe(true);
  });

  it("returns false for relative, absolute, node:, and bun: specifiers", () => {
    expect(hasNewBareImports('+import x from "./foo";')).toBe(false);
    expect(hasNewBareImports('+import x from "/abs/foo";')).toBe(false);
    expect(hasNewBareImports('+import fs from "node:fs";')).toBe(false);
    expect(hasNewBareImports('+import { Bun } from "bun:test";')).toBe(false);
  });

  it("returns false for +++ file-header lines and for removed (-) lines", () => {
    expect(hasNewBareImports("+++ b/file.ts")).toBe(false);
    expect(hasNewBareImports('-import x from "picomatch";')).toBe(false);
  });

  it('returns true for a prettier-wrapped `} from "pkg"` continuation line', () => {
    expect(hasNewBareImports('+} from "picomatch";')).toBe(true);
  });

  it('returns true for a dynamic `import("pkg")` line', () => {
    expect(hasNewBareImports('+const m = await import("picomatch");')).toBe(
      true,
    );
  });

  it('returns true for a side-effect `import "pkg"` line', () => {
    expect(hasNewBareImports('+import "picomatch";')).toBe(true);
  });

  it('returns true for an `export ... from "pkg"` re-export line', () => {
    expect(hasNewBareImports('+export { foo } from "picomatch";')).toBe(true);
  });

  it("returns true for a scoped package with a single-quoted specifier", () => {
    expect(hasNewBareImports("+import x from '@scope/pkg';")).toBe(true);
  });

  it("returns false for a Node `#subpath` import", () => {
    expect(hasNewBareImports('+import x from "#internal/foo";')).toBe(false);
  });

  it("returns false for unprefixed Node builtin module names", () => {
    expect(hasNewBareImports('+import fs from "fs";')).toBe(false);
    expect(hasNewBareImports('+const cp = require("child_process");')).toBe(
      false,
    );
    expect(hasNewBareImports('+import p from "path";')).toBe(false);
  });

  it("does not exhibit polynomial backtracking on a crafted long whitespace line", () => {
    const crafted = `+import ${" ".repeat(20000)}from "picomatch";`;
    const start = performance.now();
    hasNewBareImports(crafted);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("SECURITY_SENSITIVE_GLOBS", () => {
  const cases: [string, boolean][] = [
    ["src/auth/login.ts", true],
    ["src/security/policy.ts", true],
    ["src/secrets/config.ts", true], // directory form — was a gap before **/*secret*/**
    ["src/config-secret.ts", true], // filename-substring form
    ["src/credential-store.ts", true],
    ["src/credentials/store.ts", true],
    ["keys/server.pem", true],
    ["keys/server.key", true],
    [".env.production", true],
    ["config/.env", true],
    ["src/reset-password.ts", true],
    ["src/password/reset.ts", true],
    ["src/crypto/hash.ts", true],
    ["src/permissions/roles.ts", true],
    ["src/widgets/button.tsx", false],
    ["docs/README.md", false],
  ];
  for (const [file, expected] of cases) {
    it(`${expected ? "matches" : "does not match"} '${file}'`, () => {
      expect(matchesAny(file, SECURITY_SENSITIVE_GLOBS)).toBe(expected);
    });
  }
});
