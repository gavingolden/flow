import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveArtifactSetForSource } from "./modules-source-resolve";
import { resolveArtifactSet } from "./modules";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "flow-modules-source-resolve-"),
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function writeSourceModules(contents: string): string {
  const flowSource = path.join(scratch, "worktree");
  fs.mkdirSync(path.join(flowSource, "bin", "lib"), { recursive: true });
  fs.writeFileSync(path.join(flowSource, "bin", "lib", "modules.ts"), contents);
  return flowSource;
}

describe(resolveArtifactSetForSource, () => {
  it("takes the fast path (compiled-in registry) when flowSource === installRoot, never touching disk under flowSource", async () => {
    // A flowSource path that doesn't even exist on disk — the fast path must
    // never read bin/lib/modules.ts under it.
    const nonExistentRoot = path.join(scratch, "does-not-exist-at-all");
    const result = await resolveArtifactSetForSource(
      nonExistentRoot,
      nonExistentRoot,
      ["core"],
    );
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });

  it("prefers the SOURCE tree's own resolveArtifactSet when it diverges from the compiled-in one", async () => {
    const flowSource = writeSourceModules(`
      export function resolveArtifactSet(selectedIds) {
        return {
          skills: ["source-only-skill"],
          agents: [],
          helpers: [],
          validators: [],
        };
      }
    `);
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.artifactSet).toEqual({
      skills: ["source-only-skill"],
      agents: [],
      helpers: [],
      validators: [],
    });
    // Sanity: this really did diverge from the compiled-in result.
    expect(result.artifactSet).not.toEqual(resolveArtifactSet(["core"]));
  });

  it("falls back to the compiled-in result, with a named warning, when the source tree has no bin/lib/modules.ts", async () => {
    const flowSource = path.join(scratch, "no-modules-file");
    fs.mkdirSync(flowSource, { recursive: true });
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain(
      path.join(flowSource, "bin", "lib", "modules.ts"),
    );
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });

  it("falls back to the compiled-in result when the source tree's modules.ts throws on import (syntax error)", async () => {
    const flowSource = writeSourceModules(`this is not valid javascript {{{`);
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });

  it("falls back to the compiled-in result when the source tree's modules.ts imports successfully but has no resolveArtifactSet export", async () => {
    const flowSource = writeSourceModules(`
      export function somethingElse() { return "not it"; }
    `);
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("resolveArtifactSet");
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });

  it("falls back to the compiled-in result when resolveArtifactSet runs but returns a non-ArtifactSet shape", async () => {
    const flowSource = writeSourceModules(`
      export function resolveArtifactSet(selectedIds) {
        return "not an artifact set";
      }
    `);
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });

  it("falls back to the compiled-in result when resolveArtifactSet returns an object with a non-array property", async () => {
    const flowSource = writeSourceModules(`
      export function resolveArtifactSet(selectedIds) {
        return {
          skills: ["ok"],
          agents: [],
          helpers: [],
          validators: "not-an-array",
        };
      }
    `);
    const installRoot = path.join(scratch, "canonical");
    fs.mkdirSync(installRoot, { recursive: true });

    const result = await resolveArtifactSetForSource(flowSource, installRoot, [
      "core",
    ]);
    expect(result.usedSourceRegistry).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("ArtifactSet");
    expect(result.artifactSet).toEqual(resolveArtifactSet(["core"]));
  });
});
