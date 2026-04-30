import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRendered } from "./skills.js";
import { INCLUDE_MARKER } from "./triage-contract.js";

describe("ensureRendered (skill install with include marker)", () => {
  let dir: string;
  let sourceDir: string;
  let installPath: string;
  let contractPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-render-"));
    sourceDir = join(dir, "source", "flow-add");
    installPath = join(dir, "target", "flow-add");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(dir, "target"), { recursive: true });
    contractPath = join(dir, "source", "triage-contract.md");
    writeFileSync(contractPath, "shared partial body\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(skillBody: string): void {
    writeFileSync(join(sourceDir, "SKILL.md"), skillBody);
  }

  it("expands the include marker in SKILL.md when rendering a marker-bearing skill", async () => {
    // The default contract path resolves relative to the install/triage-
    // contract.ts module. Easier to test this by invoking renderWithTriageContract
    // directly with an injected path; but ensureRendered uses the default
    // resolver. Use the real templates/triage-contract.md from the repo.
    writeSkill(
      `---\nname: x\n---\nbefore\n${INCLUDE_MARKER}\nafter\n`,
    );
    const result = await ensureRendered(installPath, sourceDir, "/r");
    expect(result).toBe("created");
    const out = readFileSync(join(installPath, "SKILL.md"), "utf8");
    // The real partial mentions the triage agent role — assert by substring
    // so test is robust to copy edits.
    expect(out).not.toContain(INCLUDE_MARKER);
    expect(out).toContain("triage agent");
    // ${REPO_ROOT} should be substituted into the partial body too.
    expect(out).not.toContain("${REPO_ROOT}");
    expect(out).toContain("/r");
  });

  it("substitutes ${REPO_ROOT} in marker-free files alongside SKILL.md", async () => {
    writeSkill(
      `---\nname: x\n---\nbody at \${REPO_ROOT}\n${INCLUDE_MARKER}\n`,
    );
    writeFileSync(
      join(sourceDir, "extra.md"),
      "extra at ${REPO_ROOT}\n",
    );
    await ensureRendered(installPath, sourceDir, "/abs/path");
    const skill = readFileSync(join(installPath, "SKILL.md"), "utf8");
    expect(skill).toContain("body at /abs/path");
    const extra = readFileSync(join(installPath, "extra.md"), "utf8");
    expect(extra).toBe("extra at /abs/path\n");
  });

  it("replaces a stale symlink at the install path with a real directory", async () => {
    writeSkill(`${INCLUDE_MARKER}\n`);
    // Simulate a pre-render install: symlink from target → source.
    symlinkSync(sourceDir, installPath);
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true);
    const result = await ensureRendered(installPath, sourceDir, "/r");
    expect(result).toBe("updated");
    expect(lstatSync(installPath).isDirectory()).toBe(true);
    expect(readFileSync(join(installPath, "SKILL.md"), "utf8")).not.toContain(
      INCLUDE_MARKER,
    );
  });

  it("returns 'updated' when re-rendering an existing rendered directory (no skip on idempotent re-run)", async () => {
    writeSkill(`${INCLUDE_MARKER}\n`);
    await ensureRendered(installPath, sourceDir, "/r");
    const result = await ensureRendered(installPath, sourceDir, "/r");
    // Always re-render so upstream edits to the partial propagate without a
    // content-hash dance. Reflected as 'updated' even when bytes are the same.
    expect(result).toBe("updated");
  });

  it("sweeps stale files left in the install dir when an upstream file is removed", async () => {
    // First install: source has SKILL.md + extra.md.
    writeSkill(`${INCLUDE_MARKER}\n`);
    writeFileSync(join(sourceDir, "extra.md"), "extra body\n");
    await ensureRendered(installPath, sourceDir, "/r");
    expect(lstatSync(join(installPath, "SKILL.md")).isFile()).toBe(true);
    expect(lstatSync(join(installPath, "extra.md")).isFile()).toBe(true);

    // Upstream deletes extra.md. A re-render must remove the orphan from
    // the install dir; otherwise stale skill files linger across installs
    // and Claude Code may load partials that no longer match the source.
    rmSync(join(sourceDir, "extra.md"));
    await ensureRendered(installPath, sourceDir, "/r");
    expect(lstatSync(join(installPath, "SKILL.md")).isFile()).toBe(true);
    expect(() => lstatSync(join(installPath, "extra.md"))).toThrow();
  });
});
