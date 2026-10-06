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

  describe("sed option parsing", () => {
    it.each([
      `sed -e 's/a/b/' ${HOME_DOC}`,
      `sed -ne 's/a/b/p' ${HOME_DOC}`,
      `sed --expression='s/a/b/' ${HOME_DOC}`,
      `sed --expression 's/a/b/' ${HOME_DOC}`,
      `sed -f script.sed ${HOME_DOC}`,
      `sed -n -f script.sed ${HOME_DOC}`,
      `sed --in-place 's/a/b/' ${HOME_DOC}`,
      `sed -ni 's/a/b/p' ${HOME_DOC}`,
      `sed -i.bak 's/a/b/' ${HOME_DOC}`,
      `sed -n -e '12,20p' -e '/x/p' ${HOME_DOC}`,
    ])("denies %s", (command) => {
      expect(decide(bash(command))?.permissionDecision).toBe("deny");
    });

    it.each([
      `sed -n -e '12,20p' ${HOME_DOC}`,
      `sed -n -e'12,20p' ${HOME_DOC}`,
      `sed -ne '12,20p' ${HOME_DOC}`,
      `sed -n --expression='12,20p' ${HOME_DOC}`,
      `sed -n -e 12p -e 14,16p ${HOME_DOC}`,
      `sed -n -e '$p' ${HOME_DOC}`,
    ])("allows line-number-only %s", (command) => {
      expect(decide(bash(command))).toBeNull();
    });
  });

  describe("segment splitting", () => {
    it("does not split on a | or ; inside quotes", () => {
      expect(decide(bash(`grep -n 'x|awk y' ${HOME_DOC}`))).toBeNull();
      expect(decide(bash(`grep -n "x;awk y" ${HOME_DOC}`))).toBeNull();
      expect(decide(bash(`grep -n 'x&&awk y' ${HOME_DOC}`))).toBeNull();
      expect(
        decide(bash("sed -n '/A\\|B/p' $WORKTREE/.flow-tmp/plan.md")),
      ).toBeNull();
      expect(
        decide(bash(`awk -F'|' '{print $1}' $WORKTREE/.flow-tmp/plan.md`)),
      ).toBeNull();
    });

    it.each([
      [";", `cd /tmp; awk 1 ${HOME_DOC}`],
      ["newline", `cd /tmp\nawk 1 ${HOME_DOC}`],
      ["&", `sleep 1 & awk 1 ${HOME_DOC}`],
      ["||", `false || awk 1 ${HOME_DOC}`],
      ["pipe", `cat x | awk 1 ${HOME_DOC}`],
    ])("denies a risky segment after %s", (_name, command) => {
      expect(decide(bash(command))?.permissionDecision).toBe("deny");
    });

    it("keeps &&, >& and 2>&1 intact rather than splitting them", () => {
      expect(decide(bash(`sed -n 12p ${HOME_DOC} 2>&1`))).toBeNull();
      expect(decide(bash(`sed -n 12p ${HOME_DOC} >&2`))).toBeNull();
      expect(decide(bash(`sed -n 12p ${HOME_DOC} &> /dev/null`))).toBeNull();
      expect(decide(bash(`true && sed -n 12p ${HOME_DOC}`))).toBeNull();
    });
  });

  describe("command-word normalization", () => {
    it.each([
      `env awk 1 ${HOME_DOC}`,
      `env -i awk 1 ${HOME_DOC}`,
      `LC_ALL=C awk 1 ${HOME_DOC}`,
      `/usr/bin/awk 1 ${HOME_DOC}`,
      `sudo -u x awk 1 ${HOME_DOC}`,
      `xargs -0 awk 1 ${HOME_DOC}`,
      `nice -n 5 awk 1 ${HOME_DOC}`,
      `gawk 1 ${HOME_DOC}`,
      `env sed -i s/a/b/ ${HOME_DOC}`,
      `(awk 1 ${HOME_DOC})`,
    ])("denies %s", (command) => {
      expect(decide(bash(command))?.permissionDecision).toBe("deny");
    });

    it("still allows a wrapped line-number sed", () => {
      expect(decide(bash(`env -i sed -n 12p ${HOME_DOC}`))).toBeNull();
      expect(decide(bash(`sudo -u x sed -n 12,20p ${HOME_DOC}`))).toBeNull();
    });
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
