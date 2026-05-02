import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFixture, wrapImplementorPrompt } from "./eval-runner";

let scratch!: string;
let flowSource!: string;
let fixtureDir!: string;
let artefactsDir!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
  flowSource = path.join(scratch, "flow");
  fixtureDir = path.join(scratch, "fixture");
  artefactsDir = path.join(scratch, "artefacts");

  // Fake flow source with one skill present (eval-config tolerates missing ones).
  const skillDir = path.join(flowSource, "skills", "pipeline", "new-feature");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: new-feature\nmodel: x\n---\n");

  // Fixture: seed has one file; rubric expects a new file to be created.
  fs.mkdirSync(path.join(fixtureDir, "seed"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "seed", "README.md"), "starter\n");
  fs.writeFileSync(path.join(fixtureDir, "prompt.md"), "/new-feature add a bin/cli.ts file\n");
  fs.writeFileSync(
    path.join(fixtureDir, "rubric.yml"),
    `hard:
  must_pass: ["true"]
  must_create: ["bin/cli.ts"]
  must_not_modify: ["package.json"]
soft: []
`,
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("runFixture", () => {
  it("passes when the implementor satisfies the rubric", async () => {
    const r = await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async (_prompt, repoDir) => {
        // Stub: write the file the rubric expects.
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "console.log('hi');\n");
        return JSON.stringify({
          type: "result",
          subtype: "success",
          total_cost_usd: 0.0042,
        });
      },
    });

    expect(r.pass).toBe(true);
    expect(r.hard.pass).toBe(true);
    expect(r.soft.pass).toBe(true);
    expect(r.implCost.usd).toBe(0.0042);
    expect(r.fixture).toBe(path.basename(fixtureDir));
  });

  it("fails when the implementor does not create the expected file", async () => {
    const r = await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async () => JSON.stringify({ type: "result", total_cost_usd: 0 }),
    });
    expect(r.pass).toBe(false);
    expect(r.hard.pass).toBe(false);
    expect(r.hard.failures.some((f) => f.check === "must_create")).toBe(true);
  });

  it("fails when the implementor touches a must_not_modify path", async () => {
    fs.writeFileSync(path.join(fixtureDir, "seed", "package.json"), "{}\n");
    const r = await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async (_p, repoDir) => {
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "");
        fs.writeFileSync(path.join(repoDir, "package.json"), '{"changed": true}\n');
        return JSON.stringify({ type: "result", total_cost_usd: 0 });
      },
    });
    expect(r.pass).toBe(false);
    expect(r.hard.failures.some((f) => f.check === "must_not_modify")).toBe(true);
  });

  it("writes implementor.jsonl, final.diff, hard.json, soft.json artefacts", async () => {
    await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async (_p, repoDir) => {
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "");
        return "stream";
      },
    });
    expect(fs.readFileSync(path.join(artefactsDir, "implementor.jsonl"), "utf8")).toBe("stream");
    expect(fs.existsSync(path.join(artefactsDir, "final.diff"))).toBe(true);
    expect(fs.existsSync(path.join(artefactsDir, "hard.json"))).toBe(true);
    expect(fs.existsSync(path.join(artefactsDir, "soft.json"))).toBe(true);
  });

  it("symlinks .claude/skills/ from the resolved skill set", async () => {
    await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async (_p, repoDir) => {
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "");
        return "";
      },
    });
    const link = path.join(artefactsDir, "repo", ".claude", "skills", "new-feature");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("exposes the diff to soft checks (empty diff path is honoured)", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "rubric.yml"),
      `hard: { must_pass: ["true"] }\nsoft: []\n`,
    );
    const r = await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async () => "",
    });
    expect(r.soft.pass).toBe(true);
    expect(r.implCost.usd).toBe(0);
  });

  it("wraps the implementor prompt with an auto-approval directive", async () => {
    let observedPrompt = "";
    await runFixture({
      fixtureDir,
      config: "pr7",
      flowSource,
      artefactsDir,
      invokeImplementor: async (prompt, repoDir) => {
        observedPrompt = prompt;
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "");
        return "";
      },
    });
    // Skills like /new-feature have an interactive approval gate that hangs a
    // single-shot `claude -p` invocation. The runner must inject a directive
    // that tells the implementor to proceed without waiting for human approval.
    expect(observedPrompt).toContain("auto-approval");
    expect(observedPrompt).toContain("/new-feature add a bin/cli.ts file");
  });

  it("passes the unwrapped prompt to the soft-check judge", async () => {
    // The judge should evaluate against the user's actual request, not the
    // harness's auto-approval scaffolding. We can only assert this indirectly
    // here: confirm wrapImplementorPrompt is the only place the wrapper appears.
    const original = "/new-feature add a bin/cli.ts file";
    const wrapped = wrapImplementorPrompt(original);
    expect(wrapped).toContain("auto-approval");
    expect(wrapped).toContain(original);
    expect(wrapped).not.toBe(original);
  });

  it("uses a stripped skill mirror under defaults config", async () => {
    const r = await runFixture({
      fixtureDir,
      config: "defaults",
      flowSource,
      artefactsDir,
      invokeImplementor: async (_p, repoDir) => {
        fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(repoDir, "bin", "cli.ts"), "");
        return "";
      },
    });

    expect(r.config).toBe("defaults");
    // The runner should have built a per-run mirror at <artefactsDir>/skills-mirror.
    const mirror = path.join(artefactsDir, "skills-mirror", "new-feature", "SKILL.md");
    expect(fs.existsSync(mirror)).toBe(true);
    const md = fs.readFileSync(mirror, "utf8");
    // Frontmatter `model:` was stripped; original beforeEach seed had `model: x`.
    expect(md).not.toContain("model:");
    expect(md).toContain("name: new-feature");

    // The repo's `.claude/skills/new-feature` symlink should resolve into the
    // mirror, not the live skills tree.
    const link = path.join(artefactsDir, "repo", ".claude", "skills", "new-feature");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(link);
    expect(target).toBe(path.join(artefactsDir, "skills-mirror", "new-feature"));
  });
});
