import { describe, expect, it } from "vitest";
import {
  STACK_TABLE,
  declaredScriptsOf,
  npmRunCheck,
  resolveChecks,
  type ReadPackageJson,
} from "./stack-table";

// Inject the package.json read seam so no real file is touched — mirrors
// copilot-config.test.ts's `reader = (raw) => () => raw` idiom.
const pkg =
  (raw: unknown): ReadPackageJson =>
  () =>
    raw;

describe("resolveChecks — node Layer 1 (declared scripts)", () => {
  it("emits declared check, lint, test in the table's order (pokemon apps/web shape)", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["check", "lint", "test"]),
      workspacePath: "apps/web",
    });
    expect(checks.map((c) => c.name)).toEqual([
      "npm run check -w apps/web",
      "npm run lint -w apps/web",
      "npm run test -w apps/web",
    ]);
  });

  it("first-present-wins within the typecheck/check group — only check present → check, never an invented typecheck", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["check"]),
      workspacePath: "apps/web",
    });
    expect(checks.map((c) => c.name)).toEqual(["npm run check -w apps/web"]);
  });

  it("first-present-wins prefers typecheck over check when both are declared", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["typecheck", "check"]),
    });
    expect(checks.map((c) => c.name)).toEqual(["npm run typecheck"]);
  });

  it("does not emit a script the package never declared", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["test"]),
    });
    expect(checks.map((c) => c.name)).toEqual(["npm run test"]);
  });

  it("emits the bare root form (no -w) when no workspacePath is supplied", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["typecheck", "test", "lint"]),
    });
    expect(checks.map((c) => c.argv)).toEqual([
      ["npm", "run", "typecheck"],
      ["npm", "run", "lint"],
      ["npm", "run", "test"],
    ]);
  });
});

describe("resolveChecks — denylist safety (NAME-based, not body scan)", () => {
  it("does NOT emit format even when declared (format = prettier --write, tree-mutating in both live repos)", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["check", "lint", "test", "format"]),
    });
    expect(checks.map((c) => c.name)).not.toContain("npm run format");
    expect(checks.map((c) => c.name)).toEqual([
      "npm run check",
      "npm run lint",
      "npm run test",
    ]);
  });

  it("never emits a :watch script (econ-data's interactive test:watch)", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["test:watch", "test"]),
    });
    expect(checks.map((c) => c.name)).toEqual(["npm run test"]);
    expect(checks.map((c) => c.name)).not.toContain("npm run test:watch");
  });

  it("skips dev/build/preview/:e2e/smoketest by name", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set([
        "dev",
        "build",
        "preview",
        "test:e2e",
        "smoketest",
        "test",
      ]),
    });
    expect(checks.map((c) => c.name)).toEqual(["npm run test"]);
  });

  it("emits a legit `test` (econ-data body 'npm run test:watch -- --run') — name is `test`, denylist matches NAMES not bodies", () => {
    // econ-data declares test/lint/check/format. The denylist must match the
    // declared NAME `test`, never substring-scan its body (which references
    // the denylisted `test:watch`). `lint`'s body 'prettier --check . && eslint .'
    // likewise must not be denied for containing 'prettier'.
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["check", "lint", "test", "format"]),
    });
    expect(checks.map((c) => c.name)).toEqual([
      "npm run check",
      "npm run lint",
      "npm run test",
    ]);
  });
});

describe("resolveChecks — Layer 2 (stack default)", () => {
  it("falls back to the go default vet+test when no node scripts apply", () => {
    const checks = resolveChecks({ marker: "go.mod" });
    expect(checks).toEqual([
      { name: "go vet ./...", argv: ["go", "vet", "./..."] },
      { name: "go test ./...", argv: ["go", "test", "./..."] },
    ]);
  });

  it("a node package declaring no verify-class script resolves to [] (silent pass — node default is empty)", () => {
    const checks = resolveChecks({
      marker: "package.json",
      declaredScripts: new Set(["start", "release"]),
    });
    expect(checks).toEqual([]);
  });

  it("an unknown marker resolves to []", () => {
    expect(resolveChecks({ marker: "Cargo.toml" })).toEqual([]);
  });
});

describe("resolveChecks — ReadPackageJson seam + tolerant reads", () => {
  it("drives Layer 1 through the injected readPackageJson seam", () => {
    const checks = resolveChecks({
      marker: "package.json",
      readPackageJson: pkg({
        scripts: { check: "svelte-check", test: "vitest" },
      }),
      pkgPath: "apps/web/package.json",
      workspacePath: "apps/web",
    });
    expect(checks.map((c) => c.name)).toEqual([
      "npm run check -w apps/web",
      "npm run test -w apps/web",
    ]);
  });

  it("missing/empty package.json → no node checks (and no throw)", () => {
    expect(
      resolveChecks({
        marker: "package.json",
        readPackageJson: pkg(undefined),
        pkgPath: "apps/web/package.json",
      }),
    ).toEqual([]);
    expect(
      resolveChecks({
        marker: "package.json",
        readPackageJson: pkg({}),
        pkgPath: "apps/web/package.json",
      }),
    ).toEqual([]);
  });
});

describe("declaredScriptsOf", () => {
  it("extracts script names from a well-formed package.json", () => {
    expect(declaredScriptsOf({ scripts: { a: "x", b: "y" } })).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("collapses malformed/absent shapes to an empty set without throwing", () => {
    expect(declaredScriptsOf(undefined)).toEqual(new Set());
    expect(declaredScriptsOf(null)).toEqual(new Set());
    expect(declaredScriptsOf("nope")).toEqual(new Set());
    expect(declaredScriptsOf({ scripts: "nope" })).toEqual(new Set());
    expect(declaredScriptsOf({})).toEqual(new Set());
  });
});

describe("npmRunCheck", () => {
  it("builds the bare root form", () => {
    expect(npmRunCheck("test")).toEqual({
      name: "npm run test",
      argv: ["npm", "run", "test"],
    });
  });

  it("builds the workspace-scoped -w form", () => {
    expect(npmRunCheck("check", "apps/web")).toEqual({
      name: "npm run check -w apps/web",
      argv: ["npm", "run", "check", "-w", "apps/web"],
    });
  });
});

describe("STACK_TABLE shape", () => {
  it("pins the node probe order and name-based denylist", () => {
    const node = STACK_TABLE["package.json"];
    expect(node.verifyScriptOrder).toEqual([
      ["typecheck", "check"],
      ["lint"],
      ["test"],
      ["format:check"],
    ]);
    expect(node.denylist).toContain("format");
    expect(node.denylistSuffixes).toEqual([":watch", ":e2e"]);
  });
});
