/**
 * `flow-skill-overlay` CLI behaviour, driven through `runSkillOverlay` with a
 * tmp overlays dir (never the real ~/.flow/overlays), plus one real-process
 * run proving the committed file is executable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillOverlay } from "./flow-skill-overlay";
import { resolveFlowSource } from "./lib/paths";
import { materializeSkillOverlay } from "./lib/skill-overlay";

const realFlowSource = resolveFlowSource();
let scratch!: string;
let source!: string;
let overlaysDir!: string;

function put(rel: string, body: string): void {
  const p = path.join(source, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const run = (...argv: string[]) =>
  runSkillOverlay([...argv, "--overlays-dir", overlaysDir]);

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-skill-overlay-cli-"));
  source = path.join(scratch, "source");
  overlaysDir = path.join(scratch, "overlays");
  put("skills/pipeline/probe/SKILL.md", "v1\n");
  put("agents/core/probe-agent.md", "agent\n");
  put("bin/lib/modules.ts", "export {};\n");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function build(kind: "flow-self" | "skills-from" = "flow-self"): void {
  materializeSkillOverlay({
    kind,
    slug: "demo",
    contentSource: source,
    installRoot: realFlowSource,
    moduleIds: ["core"],
    overlaysDir,
  });
}

describe("flow-skill-overlay", () => {
  it("status reports exists:false without a copy and the roots with one", () => {
    const none = run("status", "--slug", "demo");
    expect(none.code).toBe(0);
    expect(JSON.parse(none.stdout)).toEqual({ exists: false, roots: [] });
    build();
    const some = JSON.parse(run("status", "--slug", "demo").stdout);
    expect(some.exists).toBe(true);
    expect(some.roots).toHaveLength(1);
  });

  it("sync reports written / removed / notExercised as one JSON line", () => {
    build();
    put("skills/pipeline/probe/SKILL.md", "v2\n");
    put("skills/pipeline/fresh/SKILL.md", "new\n");
    put("agents/core/other-agent.md", "agent 2\n");
    const res = run("sync", "--slug", "demo", "--from", source);
    expect(res.code).toBe(0);
    expect(res.stdout.trimEnd().split("\n")).toHaveLength(1);
    const out = JSON.parse(res.stdout);
    expect(out.ran).toBe(true);
    expect(out.written.sort()).toEqual([
      "flow-module-core/agents/other-agent.md",
      "flow-module-core/skills/fresh/SKILL.md",
      "flow-module-core/skills/probe/SKILL.md",
    ]);
    expect(out.removed).toEqual([]);
    expect(out.notExercised.sort()).toEqual([
      "flow-module-core/agents/other-agent.md",
      "flow-module-core/skills/fresh",
    ]);
    fs.rmSync(path.join(source, "skills/pipeline/fresh"), { recursive: true });
    const again = JSON.parse(
      run("sync", "--slug", "demo", "--from", source).stdout,
    );
    expect(again.removed).toEqual(["flow-module-core/skills/fresh/SKILL.md"]);
  });

  it("sync never overwrites a --skills-from copy with the pipeline's own worktree", () => {
    build("skills-from");
    const worktree = path.join(scratch, "pipeline-worktree");
    fs.mkdirSync(path.join(worktree, "skills", "pipeline", "other"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(worktree, "skills", "pipeline", "other", "SKILL.md"),
      "x\n",
    );
    fs.mkdirSync(path.join(worktree, "bin", "lib"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "bin", "lib", "modules.ts"), "");
    const res = run("sync", "--slug", "demo", "--from", worktree);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      ran: false,
      skipReason: "pinned-source",
    });
    const status = JSON.parse(run("status", "--slug", "demo").stdout);
    expect(
      fs.existsSync(path.join(status.roots[0], "skills", "probe", "SKILL.md")),
    ).toBe(true);
  });

  it("sync from a non-flow directory is a graceful skip that touches nothing", () => {
    build();
    const consumer = path.join(scratch, "consumer");
    fs.mkdirSync(path.join(consumer, "skills"), { recursive: true });
    const res = run("sync", "--slug", "demo", "--from", consumer);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      ran: false,
      skipReason: "not-a-flow-checkout",
    });
    const status = JSON.parse(run("status", "--slug", "demo").stdout);
    expect(
      fs.existsSync(path.join(status.roots[0], "skills", "probe", "SKILL.md")),
    ).toBe(true);
  });

  it("sync with no copy is a graceful skip (exit 0)", () => {
    const res = run("sync", "--slug", "demo", "--from", source);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      ran: false,
      skipReason: "no-overlay",
    });
  });

  it("bad arguments exit 2 with usage on stderr and nothing on stdout", () => {
    for (const argv of [
      [],
      ["frobnicate"],
      ["status"],
      ["status", "--slug", "Not A Slug"],
      ["sync", "--slug", "demo"],
      ["sync", "--slug", "demo", "--from", path.join(scratch, "missing")],
      ["status", "--slug"],
      ["status", "--slug", "demo", "--bogus", "x"],
    ]) {
      const res = runSkillOverlay(argv);
      expect(res.code, argv.join(" ")).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("usage:");
    }
  });

  it("is committed executable and runs directly as a command", () => {
    const file = fileURLToPath(
      new URL("./flow-skill-overlay.ts", import.meta.url),
    );
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    const r = spawnSync(
      file,
      [
        "status",
        "--slug",
        "no-such-pipeline-836",
        "--overlays-dir",
        overlaysDir,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).exists).toBe(false);
  });
});
