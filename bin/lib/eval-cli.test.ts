import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildGraderContext, type Deps } from "./eval-cli";
import type { MaterializedFixture } from "./eval-fixture";
import type { ResolvedScenario } from "./eval-suite";
import { transcriptMetrics } from "./eval-transcript";

function noop(): void {}

function makeDeps(): Deps {
  return {
    probeClaude: (() => ({ ok: true })) as unknown as Deps["probeClaude"],
    probeFlowInstall: (() => ({
      ok: true,
    })) as unknown as Deps["probeFlowInstall"],
    materializeFixture: (() => {}) as unknown as Deps["materializeFixture"],
    runScenarioOnce: (() => {}) as unknown as Deps["runScenarioOnce"],
    gradeAll: (() => ({
      grades: [],
      score: { pass: true, gateFailures: [] },
    })) as unknown as Deps["gradeAll"],
    gitHead: () => "deadbeef",
    gitDirty: () => false,
    now: () => new Date(0),
    writeFile: noop,
    readFile: () => "",
    mkdirp: noop,
    rm: noop,
    exists: () => false,
    progress: noop,
    sessionId: () => "sess",
    readdir: () => [],
  };
}

function makeFixture(pluginRoots: string[]): MaterializedFixture {
  return {
    root: "/fixture-root",
    repoDir: "/fixture-root/repo",
    claudeHome: "/fixture-root/claude-home",
    bareClaudeHome: "/fixture-root/bare-claude-home",
    pluginRoots,
    shimDir: "/fixture-root/shim",
    slug: "eval-slug",
    stateDir: "/fixture-root/state",
    teardown: noop,
  };
}

function makeScenario(): ResolvedScenario {
  return {
    id: "s1",
    title: "t",
    provenance: "p",
    prompt: "prompt.md",
    graders: [],
    runs: 1,
    maxBudgetUsd: 1,
    timeoutSec: 60,
    allowedTools: [],
    dir: "/fixture-root/scenario",
  };
}

describe("buildGraderContext — command-grader PATH prefix", () => {
  it("prepends the fixture's plugin bin/ to the spawn PATH", () => {
    const pluginRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eval-cli-plugin-root-"),
    );
    const binDir = path.join(pluginRoot, "bin");
    fs.mkdirSync(binDir);
    const scriptPath = path.join(binDir, "print-path");
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "$PATH"\n');
    fs.chmodSync(scriptPath, 0o755);

    const fixture = makeFixture([pluginRoot]);
    const ctx = buildGraderContext(
      fixture,
      makeScenario(),
      {
        streamPath: "/tmp/stream.jsonl",
        assistantTextPath: "/tmp/assistant.txt",
        result: null,
        transcript: transcriptMetrics([], null),
      },
      makeDeps(),
    );

    const out = ctx.runCommand(["print-path"], "/tmp");
    // shimDir leads (matches eval-runner.ts's arm-conditional PATH build —
    // the `gh` shim is scenario infrastructure, not flow scaffold), then
    // the fixture's plugin bin/.
    expect(out.stdout.split(":")[0]).toBe(fixture.shimDir);
    expect(out.stdout.split(":")[1]).toBe(binDir);
  });

  it("still resolves and runs a command that lives only in the plugin bin/", () => {
    const pluginRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eval-cli-plugin-root-2-"),
    );
    const binDir = path.join(pluginRoot, "bin");
    fs.mkdirSync(binDir);
    const scriptPath = path.join(binDir, "only-in-plugin-bin");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
    fs.chmodSync(scriptPath, 0o755);

    const fixture = makeFixture([pluginRoot]);
    const ctx = buildGraderContext(
      fixture,
      makeScenario(),
      {
        streamPath: "/tmp/stream.jsonl",
        assistantTextPath: "/tmp/assistant.txt",
        result: null,
        transcript: transcriptMetrics([], null),
      },
      makeDeps(),
    );

    const out = ctx.runCommand(["only-in-plugin-bin"], "/tmp");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("ok");
  });
});

describe("buildGraderContext — path resolution", () => {
  it("resolves relative scenario/outcome paths to absolute paths", () => {
    const fixture = makeFixture([]);
    const scenario: ResolvedScenario = {
      ...makeScenario(),
      dir: "evals/foo/s1",
    };
    const relativeStreamPath = ".flow-tmp/eval/x/stream.jsonl";
    const relativeAssistantTextPath = ".flow-tmp/eval/x/assistant.txt";

    const ctx = buildGraderContext(
      fixture,
      scenario,
      {
        streamPath: relativeStreamPath,
        assistantTextPath: relativeAssistantTextPath,
        result: null,
        transcript: transcriptMetrics([], null),
      },
      makeDeps(),
    );

    expect(path.isAbsolute(ctx.fixtureRoot)).toBe(true);
    expect(path.isAbsolute(ctx.streamPath)).toBe(true);
    expect(path.isAbsolute(ctx.assistantTextPath)).toBe(true);
    expect(ctx.fixtureRoot).toBe(path.resolve(scenario.dir));
    expect(ctx.streamPath).toBe(path.resolve(relativeStreamPath));
    expect(ctx.assistantTextPath).toBe(path.resolve(relativeAssistantTextPath));
  });
});
