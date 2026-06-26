import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Behavioral companion to `flow-research-budget-lint.test.ts`.
 *
 * The lint is `content.includes(...)` string-presence only: it freezes the doc
 * TEXT (defaults, model pins, warn prose) but cannot catch a RUNTIME regression
 * — e.g. a future edit that downgrades the explicit `read_budget` type-guard to
 * a presence-only `// default` read, which would let a present-but-wrong-type
 * `research.maxCalls` (e.g. `"twelve"`) flow straight into `--max-calls`. That
 * is exactly the failure mode the type-guard exists to prevent, and the string
 * lint stays green through it.
 *
 * This suite closes the gap WITHOUT duplicating the jq: it EXTRACTS the
 * `read_budget` helper + `RESEARCH_*` assignments + cross-model diversity guard
 * from the fenced ```bash block in discovery-instructions.md (the single source
 * of truth — the jq is inline-in-markdown by design because the discovery
 * subagent runs in a consumer worktree where flow's bin/lib is NOT on PATH, so
 * a committed shell-script copy would drift). It rewrites only the `CFG=` line to
 * point at a tmp fixture, runs it across the load-bearing cases, and asserts the
 * resolved values — testing the behavior the structural lint cannot.
 *
 * Gated on `jq` (on PATH locally + CI; skipped cleanly if absent, mirroring the
 * optional-tool pattern in `flow-pre-commit`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "product-planning",
  "references",
  "discovery-instructions.md",
);

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
const describeJq = hasJq ? describe : describe.skip;

/**
 * Pull the fenced ```bash block that contains `read_budget() {` out of the
 * markdown. Anchors on the fence + the helper name so it survives the doc
 * gaining other ```bash blocks above/below it (there is already one such block
 * earlier in the file). Returns the block body verbatim.
 */
function extractBudgetBlock(md: string): string {
  const fenceRe = /```bash\n([\s\S]*?)\n```/g;
  for (let m = fenceRe.exec(md); m !== null; m = fenceRe.exec(md)) {
    if (m[1].includes("read_budget() {")) return m[1];
  }
  throw new Error(
    "could not locate the fenced ```bash block containing `read_budget() {` " +
      `in ${DISCOVERY_INSTRUCTIONS_PATH}`,
  );
}

let scriptPath: string;
let tmpDir: string;

beforeAll(() => {
  if (!hasJq) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-budget-behavior-"));
  const md = fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8");
  const block = extractBudgetBlock(md);

  // Repoint the hardcoded CFG at the fixture passed as $1, and echo the
  // resolved values so the test can assert on them. We replace exactly the
  // `CFG=~/.flow/config.json` line; everything else (the type-guard jq, the
  // assignments, the diversity guard) runs verbatim from the source of truth.
  const repointed = block.replace(/^CFG=.*$/m, 'CFG="$1"');
  expect(
    repointed,
    "expected the extracted block to contain a `CFG=` line to repoint",
  ).not.toBe(block);

  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    repointed,
    "",
    'printf "MAX=%s\\n" "$RESEARCH_MAX_CALLS"',
    'printf "TIMEOUT=%s\\n" "$RESEARCH_TIMEOUT"',
    'printf "MODEL=%s\\n" "$RESEARCH_MODEL"',
    'printf "REFUTE=%s\\n" "$RESEARCH_REFUTE_MODEL"',
    "",
  ].join("\n");

  scriptPath = path.join(tmpDir, "budget.sh");
  fs.writeFileSync(scriptPath, script);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the extracted budget script against a config-json fixture. */
function runBudget(config: unknown): {
  status: number | null;
  stdout: string;
  stderr: string;
  vars: Record<string, string>;
} {
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const res = spawnSync("bash", [scriptPath, cfgPath], { encoding: "utf8" });
  const vars: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, vars };
}

describeJq("F2 research budget runtime behavior (extracted from doc)", () => {
  it("absent keys resolve to the v1 defaults", () => {
    const r = runBudget({});
    expect(r.status).toBe(0);
    expect(r.vars.MAX).toBe("12");
    expect(r.vars.TIMEOUT).toBe("3m");
    expect(r.vars.MODEL).toBe("Gemini 3.1 Pro (High)");
    expect(r.vars.REFUTE).toBe("Claude Opus 4.6 (Thinking)");
  });

  it("a present-but-wrong-type maxCalls warns and falls back to the default (never the bad value)", () => {
    const r = runBudget({ research: { maxCalls: "twelve" } });
    expect(r.status).toBe(0); // never throws / aborts
    expect(r.vars.MAX).toBe("12"); // NOT "twelve" — the type-guard caught it
    expect(r.vars.MAX).not.toBe("twelve");
    expect(r.stderr).toContain("research.maxCalls is present but not a number");
  });

  it("a present-but-wrong-type model (number) warns and falls back to the default string", () => {
    const r = runBudget({ research: { model: 7 } });
    expect(r.status).toBe(0);
    expect(r.vars.MODEL).toBe("Gemini 3.1 Pro (High)");
    expect(r.stderr).toContain("research.model is present but not a string");
  });

  it("a valid override passes through unchanged", () => {
    const r = runBudget({
      research: {
        maxCalls: 25,
        timeout: "5m",
        model: "GPT-OSS 120B (Medium)",
        refuteModel: "Claude Opus 4.6 (Thinking)",
      },
    });
    expect(r.status).toBe(0);
    expect(r.vars.MAX).toBe("25");
    expect(r.vars.TIMEOUT).toBe("5m");
    expect(r.vars.MODEL).toBe("GPT-OSS 120B (Medium)");
    expect(r.vars.REFUTE).toBe("Claude Opus 4.6 (Thinking)");
  });

  it("a malformed config file degrades to defaults without throwing", () => {
    const cfgPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(cfgPath, "{ this is not json");
    const res = spawnSync("bash", [scriptPath, cfgPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("MAX=12");
    expect(res.stdout).toContain("MODEL=Gemini 3.1 Pro (High)");
  });

  it("a refuteModel colliding with the gather model falls back to a different variant (diversity guard)", () => {
    const r = runBudget({
      research: {
        model: "Claude Opus 4.6 (Thinking)",
        refuteModel: "Claude Opus 4.6 (Thinking)",
      },
    });
    expect(r.status).toBe(0);
    expect(r.vars.MODEL).toBe("Claude Opus 4.6 (Thinking)");
    expect(r.vars.REFUTE).not.toBe(r.vars.MODEL);
    expect(r.vars.REFUTE).toBe("GPT-OSS 120B (Medium)");
    expect(r.stderr).toContain("preserve adversarial diversity");
  });

  it("the diversity guard also fires for the default gather model when refute is forced equal", () => {
    const r = runBudget({
      research: { refuteModel: "Gemini 3.1 Pro (High)" },
    });
    expect(r.status).toBe(0);
    expect(r.vars.MODEL).toBe("Gemini 3.1 Pro (High)");
    expect(r.vars.REFUTE).not.toBe(r.vars.MODEL);
    expect(r.vars.REFUTE).toBe("Claude Opus 4.6 (Thinking)");
  });
});
