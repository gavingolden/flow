import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBranchBin } from "./branch-bin";

let root: string;
let wt: string;
let installed: string;

function write(rel: string, text: string): void {
  const abs = path.join(wt, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function sh(cmd: string, shimDir: string) {
  return spawnSync("sh", ["-c", cmd], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}:${installed}:${process.env.PATH ?? ""}`,
    },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "branch bin-"));
  wt = path.join(root, "wt dir");
  installed = path.join(root, "installed");
  fs.mkdirSync(path.join(wt, "skills"), { recursive: true });
  fs.mkdirSync(installed);
  write("bin/lib/modules.ts", "");
  write("bin/flow-x.ts", 'console.log("branch");\n');
  write(
    "bin/flow",
    '#!/usr/bin/env bun\nconsole.log("flow", process.argv.slice(2).join(" "));\n',
  );
  const stub = path.join(installed, "flow-x");
  fs.writeFileSync(stub, "#!/bin/sh\necho installed\n", { mode: 0o755 });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("ensureBranchBin", () => {
  it("runs the branch copy ahead of an installed helper, even with a space in the path", () => {
    const dir = ensureBranchBin(wt)!;
    expect(dir).toBe(path.join(wt, ".flow-tmp", "branch-bin"));
    expect(sh("flow-x", dir).stdout.trim()).toBe("branch");
  });

  it("routes other verbs through bin/flow but refuses install", () => {
    const dir = ensureBranchBin(wt)!;
    expect(sh("flow ls", dir).stdout.trim()).toBe("flow ls");
    const r = sh("flow install --upgrade", dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("flow install is not run from the branch");
  });

  it("skips tests and maintainer-only helpers, and deletes a stale shim", () => {
    write("bin/flow-x.test.ts", "");
    write("bin/flow-eval.ts", "");
    const dir = ensureBranchBin(wt)!;
    expect(fs.readdirSync(dir).sort()).toEqual(["flow", "flow-x"]);
    fs.rmSync(path.join(wt, "bin", "flow-x.ts"));
    ensureBranchBin(wt);
    expect(fs.readdirSync(dir)).toEqual(["flow"]);
  });

  it("returns null outside a flow checkout", () => {
    expect(ensureBranchBin(root)).toBeNull();
  });
});
