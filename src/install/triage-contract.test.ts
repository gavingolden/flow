import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INCLUDE_MARKER,
  renderWithTriageContract,
} from "./triage-contract.js";

describe("renderWithTriageContract", () => {
  let dir: string;
  let contractPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "triage-contract-"));
    contractPath = join(dir, "triage-contract.md");
    writeFileSync(
      contractPath,
      "shared body referencing ${REPO_ROOT}\n",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("expands the include marker exactly once", async () => {
    const raw = `prefix\n${INCLUDE_MARKER}\nsuffix\n`;
    const out = await renderWithTriageContract(raw, {
      repoRoot: "/repo",
      contractPath,
    });
    expect(out).toBe(
      "prefix\nshared body referencing /repo\nsuffix\n",
    );
  });

  it("substitutes ${REPO_ROOT} in both the wrapper and the partial", async () => {
    const raw = `wrapper at \${REPO_ROOT}\n${INCLUDE_MARKER}\n`;
    const out = await renderWithTriageContract(raw, {
      repoRoot: "/Users/me/code/repo",
      contractPath,
    });
    expect(out).toContain("wrapper at /Users/me/code/repo");
    expect(out).toContain(
      "shared body referencing /Users/me/code/repo",
    );
    expect(out).not.toContain("${REPO_ROOT}");
  });

  it("returns input unchanged (modulo ${REPO_ROOT}) when no marker is present", async () => {
    const raw = "no marker here, but \${REPO_ROOT} appears\n";
    const out = await renderWithTriageContract(raw, {
      repoRoot: "/r",
      contractPath,
    });
    expect(out).toBe("no marker here, but /r appears\n");
  });

  it("expands every occurrence when the marker appears more than once", async () => {
    const raw = `${INCLUDE_MARKER}\n---\n${INCLUDE_MARKER}\n`;
    const out = await renderWithTriageContract(raw, {
      repoRoot: "/r",
      contractPath,
    });
    expect(out.match(/shared body referencing/g)?.length).toBe(2);
  });

  it("trims trailing whitespace from the partial so there's no blank-line drift", async () => {
    writeFileSync(contractPath, "body\n\n\n");
    const raw = `before\n${INCLUDE_MARKER}\nafter\n`;
    const out = await renderWithTriageContract(raw, {
      repoRoot: "/r",
      contractPath,
    });
    expect(out).toBe("before\nbody\nafter\n");
  });
});
