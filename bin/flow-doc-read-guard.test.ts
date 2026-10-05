import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide } from "./flow-doc-read-guard";

const SCRIPT = fileURLToPath(
  new URL("./flow-doc-read-guard.ts", import.meta.url),
);
const HOME_DOC =
  "~/.flow/claude-home/.claude/skills/flow-module-core/skills/flow-pipeline/references/step3-threading.md";

const bash = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

const STALLED = String.raw`sed -n '/^\*\*Spawn prompt template.\*\*/,/^## Cross-model/p' ~/.flow/claude-home/.claude/skills/flow-module-core/skills/flow-pipeline/references/step3-threading.md | head -80`;

describe("flow-doc-read-guard decide()", () => {
  it("denies the verbatim stalled command", () => {
    expect(decide(bash(STALLED))?.permissionDecision).toBe("deny");
  });

  it("denies awk on an overlay path", () => {
    expect(
      decide(bash("awk 1 ~/.flow/overlays/some-slug/.claude/skills/x.md"))
        ?.permissionDecision,
    ).toBe("deny");
  });

  it("denies sed -i on a claude-home path", () => {
    expect(
      decide(bash(`sed -i 's/a/b/' ${HOME_DOC}`))?.permissionDecision,
    ).toBe("deny");
  });

  it("denies a risky segment after &&", () => {
    expect(
      decide(bash(`cd /tmp && awk '{print}' ${HOME_DOC}`))?.permissionDecision,
    ).toBe("deny");
  });

  it("allows line-number sed on the same path", () => {
    expect(decide(bash(`sed -n '40,90p' ${HOME_DOC}`))).toBeNull();
    expect(decide(bash(`sed -n '12p' ${HOME_DOC}`))).toBeNull();
    expect(decide(bash(`sed -n 12,20p ${HOME_DOC}`))).toBeNull();
    expect(decide(bash(`sed -n "3,9p" ${HOME_DOC}`))).toBeNull();
  });

  it("allows grep -n and cat on the same path", () => {
    expect(decide(bash(`grep -n '^## X' ${HOME_DOC}`))).toBeNull();
    expect(decide(bash(`cat ${HOME_DOC}`))).toBeNull();
  });

  it("allows pattern-range sed on a worktree file", () => {
    expect(
      decide(bash("sed -n '/^# A/,/^# B/p' $WORKTREE/.flow-tmp/plan.md")),
    ).toBeNull();
  });

  it("allows an awk segment that names no flow path", () => {
    expect(
      decide(bash(`grep -n '^## X' ${HOME_DOC} | awk -F: '{print $1}'`)),
    ).toBeNull();
  });

  it("allows non-Bash tools", () => {
    expect(
      decide({ tool_name: "Read", tool_input: { file_path: HOME_DOC } }),
    ).toBeNull();
  });

  it("allows malformed or non-object input", () => {
    expect(decide(null)).toBeNull();
    expect(decide("garbage")).toBeNull();
    expect(decide({ tool_name: "Bash" })).toBeNull();
    expect(
      decide({ tool_name: "Bash", tool_input: { command: 7 } }),
    ).toBeNull();
  });
});

describe("flow-doc-read-guard executable", () => {
  const run = (stdin: string) =>
    spawnSync(SCRIPT, [], { input: stdin, encoding: "utf8" });

  it("is executable", () => {
    expect(() => fs.accessSync(SCRIPT, fs.constants.X_OK)).not.toThrow();
  });

  it("prints a deny decision and exits 0 for awk on claude-home", () => {
    const r = run(JSON.stringify(bash(`awk 1 ${HOME_DOC}`)));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("prints nothing and exits 0 for garbage", () => {
    const r = run("not json{");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
