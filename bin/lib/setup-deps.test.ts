import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMissingRuntimeDeps, formatMissingDepsError } from "./setup-deps";

let root!: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-deps-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writePackageJson(deps: Record<string, string>, devDeps?: Record<string, string>): void {
  const pkg: Record<string, unknown> = { name: "fixture", dependencies: deps };
  if (devDeps) pkg.devDependencies = devDeps;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
}

function stubModule(name: string): void {
  const dir = path.join(root, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
}

describe("findMissingRuntimeDeps", () => {
  it("returns empty missing when every runtime dep resolves in node_modules", () => {
    writePackageJson({ picomatch: "^4.0.0", execa: "^9.0.0" });
    stubModule("picomatch");
    stubModule("execa");
    expect(findMissingRuntimeDeps(root)).toEqual({ missing: [] });
  });

  it("reports a runtime dep absent from node_modules", () => {
    writePackageJson({ picomatch: "^4.0.0", execa: "^9.0.0" });
    stubModule("execa");
    expect(findMissingRuntimeDeps(root)).toEqual({ missing: ["picomatch"] });
  });

  it("does not gate devDependencies (absent devDep is not reported)", () => {
    // vitest is a devDependency here; its absence from node_modules must not
    // surface in `missing` because only `dependencies` are gated.
    writePackageJson({ picomatch: "^4.0.0" }, { vitest: "^2.0.0", typescript: "^5.0.0" });
    stubModule("picomatch");
    expect(findMissingRuntimeDeps(root)).toEqual({ missing: [] });
  });

  it("returns empty missing (no throw) when package.json is absent", () => {
    expect(findMissingRuntimeDeps(root)).toEqual({ missing: [] });
  });

  it("returns empty missing (no throw) when package.json is malformed", () => {
    fs.writeFileSync(path.join(root, "package.json"), "{not valid json");
    expect(findMissingRuntimeDeps(root)).toEqual({ missing: [] });
  });
});

describe("formatMissingDepsError", () => {
  it("names the missing package and the npm install remediation", () => {
    const msg = formatMissingDepsError(["picomatch"], "/canonical/flow");
    expect(msg).toContain("picomatch");
    expect(msg).toContain("npm install");
    expect(msg).toContain("/canonical/flow");
    expect(msg).toContain("--install-deps");
  });

  it("comma-joins multiple missing packages (whole-node_modules-absent case)", () => {
    const msg = formatMissingDepsError(["picomatch", "execa"], "/canonical/flow");
    expect(msg).toContain("picomatch, execa");
  });
});
