import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideRepoFit, type TermHit } from "./flow-repo-fit";

const SCRIPT = join(import.meta.dirname, "flow-repo-fit.ts");

const path = (paths: string[]): TermHit => ({ term: "p", kind: "path", paths });
const noun = (paths: string[]): TermHit => ({ term: "n", kind: "noun", paths });

describe("decideRepoFit", () => {
  it("is fit when any path term exists", () => {
    expect(decideRepoFit([path(["a.ts"]), noun([])], 0)).toBe("fit");
  });
  it("is fit when two noun terms hit", () => {
    expect(decideRepoFit([noun(["a"]), noun(["b"])], 0)).toBe("fit");
  });
  it("is unclear with a single noun hit", () => {
    expect(decideRepoFit([noun(["a"]), noun([])], 0)).toBe("unclear");
  });
  it("is wrong-repo when nothing hits", () => {
    expect(decideRepoFit([path([]), noun([])], 0)).toBe("wrong-repo");
  });
  it("a name match prevents wrong-repo", () => {
    expect(decideRepoFit([path([]), noun([])], 1)).toBe("unclear");
  });
});

describe("flow-repo-fit CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-fit-"));
    writeFileSync(join(dir, "README.md"), "# Widget Garden\n");
    writeFileSync(join(dir, "package.json"), '{"name":"widget-garden"}');
    writeFileSync(join(dir, "src.ts"), "const sprocket = 1; // gizmo\n");
    mkdirSync(join(dir, ".flow-tmp"));
    writeFileSync(join(dir, ".flow-tmp", "plan.md"), "flibbertigibbet\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...terms: string[]) => {
    const args = ["--repo", dir, "--json"];
    for (const t of terms) args.push("--term", t);
    const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
  };

  it("fit when a path term exists", () => {
    const r = cli("src.ts");
    expect(r.status).toBe(0);
    expect(r.out.verdict).toBe("fit");
  });
  it("fit with two noun hits", () => {
    expect(cli("sprocket", "gizmo").out.verdict).toBe("fit");
  });
  it("unclear with one noun hit", () => {
    expect(cli("sprocket", "nothing-here").out.verdict).toBe("unclear");
  });
  it("wrong-repo when nothing hits, exit 0", () => {
    const r = cli("nope-one", "nope-two");
    expect(r.status).toBe(0);
    expect(r.out.verdict).toBe("wrong-repo");
  });
  it("README title match prevents wrong-repo", () => {
    expect(cli("widget", "nope-two").out.verdict).toBe("unclear");
  });
  it("excludes .flow-tmp from grep hits", () => {
    const r = cli("flibbertigibbet", "other-missing");
    expect(r.out.hits[0].paths).toEqual([]);
    expect(r.out.verdict).toBe("wrong-repo");
  });
  it("usage error exits 2", () => {
    const r = spawnSync("bun", [SCRIPT, "--repo", dir], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
