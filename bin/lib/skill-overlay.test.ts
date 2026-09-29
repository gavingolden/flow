/**
 * Tests for the per-pipeline private skill copy. Every path is a tmp dir —
 * never the developer's real ~/.flow/overlays (prune against a tmp stateDir
 * would otherwise delete live pipelines' copies).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFlowSource } from "./paths";
import { writeState, type PipelineState } from "./state";
import {
  isFlowSelfRepo,
  materializeSkillOverlay,
  readOverlayOrigin,
  overlayPluginRoots,
  overlaySkillsDir,
  pruneStaleOverlays,
  syncSkillOverlay,
} from "./skill-overlay";

const realFlowSource = resolveFlowSource();
const SLUG = "demo-slug";

let scratch!: string;
let source!: string;
let overlaysDir!: string;
let stateDir!: string;

function put(rel: string, body: string): void {
  const p = path.join(source, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function build(): string[] {
  return materializeSkillOverlay({
    slug: SLUG,
    contentSource: source,
    installRoot: realFlowSource,
    moduleIds: ["core"],
    overlaysDir,
  });
}

function copyPath(...rest: string[]): string {
  return path.join(
    overlaySkillsDir(SLUG, overlaysDir),
    "flow-module-core",
    ...rest,
  );
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-skill-overlay-"));
  source = path.join(scratch, "source");
  overlaysDir = path.join(scratch, "overlays");
  stateDir = path.join(scratch, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  put("skills/pipeline/probe-a/SKILL.md", "probe a v1\n");
  put("skills/pipeline/probe-a/references/notes.md", "notes\n");
  put("skills/universal/probe-b/SKILL.md", "probe b\n");
  put("agents/core/probe-agent.md", "agent v1\n");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("materializeSkillOverlay", () => {
  it("copies skills and agents as real files under a flow-owned plugin root", () => {
    const roots = build();
    expect(roots).toEqual([
      path.join(overlaySkillsDir(SLUG, overlaysDir), "flow-module-core"),
    ]);
    for (const p of [
      copyPath("skills", "probe-a"),
      copyPath("skills", "probe-a", "SKILL.md"),
      copyPath("skills", "probe-a", "references", "notes.md"),
      copyPath("agents"),
      copyPath("agents", "probe-agent.md"),
    ]) {
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    }
    expect(
      fs.readFileSync(copyPath("skills", "probe-a", "SKILL.md"), "utf8"),
    ).toBe("probe a v1\n");
  });

  it("keeps reading after the source directory is deleted", () => {
    build();
    fs.rmSync(source, { recursive: true, force: true });
    expect(
      fs.readFileSync(copyPath("skills", "probe-b", "SKILL.md"), "utf8"),
    ).toBe("probe b\n");
  });

  it("only routes into the requested module ids and leaves no build dir", () => {
    build();
    expect(fs.readdirSync(overlaysDir)).toEqual([SLUG]);
    expect(fs.readdirSync(overlaySkillsDir(SLUG, overlaysDir))).toEqual([
      "flow-module-core",
    ]);
  });
});

describe("readOverlayOrigin", () => {
  it("records the kind and source when the copy is built", () => {
    expect(readOverlayOrigin(SLUG, overlaysDir)).toBeNull();
    materializeSkillOverlay({
      slug: SLUG,
      contentSource: source,
      installRoot: realFlowSource,
      moduleIds: ["core"],
      overlaysDir,
      kind: "skills-from",
    });
    expect(readOverlayOrigin(SLUG, overlaysDir)).toEqual({
      kind: "skills-from",
      source,
    });
  });

  it("defaults to flow-self", () => {
    build();
    expect(readOverlayOrigin(SLUG, overlaysDir)?.kind).toBe("flow-self");
  });
});

describe("copying a checkout with symlinks", () => {
  it("skips links that resolve outside the checkout and survives a self-referencing directory link", () => {
    const secret = path.join(scratch, "secret.env");
    fs.writeFileSync(secret, "TOKEN=1\n");
    const outsideDir = path.join(scratch, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "x.md"), "outside\n");
    const skill = path.join(source, "skills/pipeline/probe-a");
    fs.symlinkSync(secret, path.join(skill, "leak.md"));
    fs.symlinkSync(outsideDir, path.join(skill, "outdir"));
    fs.symlinkSync(".", path.join(skill, "loop"));
    fs.symlinkSync("SKILL.md", path.join(skill, "inside-link.md"));
    build();
    expect(fs.existsSync(copyPath("skills", "probe-a", "leak.md"))).toBe(false);
    expect(fs.existsSync(copyPath("skills", "probe-a", "outdir"))).toBe(false);
    expect(fs.existsSync(copyPath("skills", "probe-a", "loop"))).toBe(false);
    expect(
      fs.readFileSync(copyPath("skills", "probe-a", "inside-link.md"), "utf8"),
    ).toBe("probe a v1\n");
  });
});

describe("overlayPluginRoots", () => {
  it("is null without a copy and lists the roots with one", () => {
    expect(overlayPluginRoots(SLUG, overlaysDir)).toBeNull();
    build();
    expect(overlayPluginRoots(SLUG, overlaysDir)).toHaveLength(1);
  });
});

describe("syncSkillOverlay", () => {
  it("is byte-exact, keeps unchanged mtimes, and reports nothing when in sync", () => {
    build();
    const before = fs.statSync(copyPath("skills", "probe-b", "SKILL.md"));
    const res = syncSkillOverlay({
      slug: SLUG,
      contentSource: source,
      overlaysDir,
    });
    expect(res).toEqual({ written: [], removed: [], notExercised: [] });
    const after = fs.statSync(copyPath("skills", "probe-b", "SKILL.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rewrites an edited skill in place and does not flag it as not-exercised", () => {
    build();
    put("skills/pipeline/probe-a/SKILL.md", "probe a v2\n");
    const res = syncSkillOverlay({
      slug: SLUG,
      contentSource: source,
      overlaysDir,
    });
    expect(res.written).toEqual(["flow-module-core/skills/probe-a/SKILL.md"]);
    expect(res.notExercised).toEqual([]);
    expect(
      fs.readFileSync(copyPath("skills", "probe-a", "SKILL.md"), "utf8"),
    ).toBe("probe a v2\n");
  });

  it("adds new skills and agent defs and lists them as not-exercised", () => {
    build();
    put("skills/pipeline/probe-new/SKILL.md", "new\n");
    put("skills/pipeline/probe-new/extra.md", "extra\n");
    put("agents/core/second-agent.md", "agent 2\n");
    const res = syncSkillOverlay({
      slug: SLUG,
      contentSource: source,
      overlaysDir,
    });
    expect(res.notExercised.sort()).toEqual([
      "flow-module-core/agents/second-agent.md",
      "flow-module-core/skills/probe-new",
    ]);
    expect(
      fs.readFileSync(copyPath("skills", "probe-new", "extra.md"), "utf8"),
    ).toBe("extra\n");
  });

  it("deletes skills and files absent from the source", () => {
    build();
    fs.rmSync(path.join(source, "skills/universal/probe-b"), {
      recursive: true,
    });
    fs.rmSync(path.join(source, "skills/pipeline/probe-a/references"), {
      recursive: true,
    });
    const res = syncSkillOverlay({
      slug: SLUG,
      contentSource: source,
      overlaysDir,
    });
    expect(res.removed.sort()).toEqual([
      "flow-module-core/skills/probe-a/references/notes.md",
      "flow-module-core/skills/probe-b/SKILL.md",
    ]);
    expect(fs.existsSync(copyPath("skills", "probe-b"))).toBe(false);
    expect(fs.existsSync(copyPath("skills", "probe-a", "references"))).toBe(
      false,
    );
    expect(fs.existsSync(copyPath("skills"))).toBe(true);
  });
});

describe("pruneStaleOverlays", () => {
  const OLD = Date.now() + 60 * 60 * 1000;

  function seed(slug: string, phase: string | null): void {
    materializeSkillOverlay({
      slug,
      contentSource: source,
      installRoot: realFlowSource,
      moduleIds: ["core"],
      overlaysDir,
    });
    if (phase !== null) {
      writeState(
        {
          slug,
          phase,
          repo: "/r",
          updatedAt: new Date().toISOString(),
        } as PipelineState,
        stateDir,
      );
    }
  }

  it("keeps a gated or needs-human copy (resumable) even when not alive", () => {
    seed("waiting-gate", "gated");
    seed("waiting-human", "needs-human");
    seed("done", "cancelled");
    const pruned = pruneStaleOverlays({
      overlaysDir,
      stateDir,
      isAlive: () => false,
      now: OLD,
    });
    expect(pruned).toEqual(["done"]);
    expect(fs.readdirSync(overlaysDir).sort()).toEqual([
      "waiting-gate",
      "waiting-human",
    ]);
  });

  it("keeps a live or in-flight slug, deletes absent-state and terminal-not-alive ones", () => {
    seed("live-one", "merged");
    seed("in-flight", "implementing");
    seed("no-state", null);
    seed("finished", "merged");
    const pruned = pruneStaleOverlays({
      overlaysDir,
      stateDir,
      isAlive: (slug) => slug === "live-one",
      now: OLD,
    });
    expect(pruned.sort()).toEqual(["finished", "no-state"]);
    expect(fs.readdirSync(overlaysDir).sort()).toEqual([
      "in-flight",
      "live-one",
    ]);
  });

  it("never deletes a copy modified in the last 30 minutes", () => {
    seed("fresh", null);
    expect(pruneStaleOverlays({ overlaysDir, stateDir })).toEqual([]);
    expect(fs.existsSync(path.join(overlaysDir, "fresh"))).toBe(true);
  });

  it("is a no-op when the overlays dir is absent", () => {
    expect(pruneStaleOverlays({ overlaysDir, stateDir })).toEqual([]);
  });
});

describe("isFlowSelfRepo", () => {
  function git(args: string[], cwd: string): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  function flowLikeRepo(dir: string): void {
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "flow"), "#!/usr/bin/env bun\n");
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "T"], dir);
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
  }

  it("is true for the canonical root and a linked worktree of it, false for another repo", () => {
    const canonical = path.join(scratch, "canonical");
    fs.mkdirSync(canonical);
    flowLikeRepo(canonical);
    const linked = path.join(scratch, "linked");
    git(["worktree", "add", "-b", "feat", linked], canonical);
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    flowLikeRepo(other);

    expect(isFlowSelfRepo(canonical, canonical)).toBe(true);
    expect(isFlowSelfRepo(linked, canonical)).toBe(true);
    expect(isFlowSelfRepo(other, canonical)).toBe(false);
    expect(isFlowSelfRepo(path.join(scratch, "not-a-repo"), canonical)).toBe(
      false,
    );
  });
});
