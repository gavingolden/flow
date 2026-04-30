/**
 * Drift guard between the two triage front doors.
 *
 * `flow start` (CLI) and `/flow add` (skill) must produce byte-identical
 * triage rules — that's the whole point of pulling the contract into
 * `templates/triage-contract.md`. This test renders both consumers from
 * source and asserts the bytes between `<!-- start: shared -->` and
 * `<!-- end: shared -->` are byte-equal. If anyone edits one consumer's
 * body without updating the partial, the slice differs and the test fails.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderWithTriageContract } from "./triage-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_PLACEHOLDER = "/__test__/repo";

const TEMPLATES_DIR = path.resolve(HERE, "..", "..", "templates");
const SYSTEM_PROMPT_PATH = path.join(TEMPLATES_DIR, "triage-system-prompt.md");
const SKILL_PATH = path.resolve(
  HERE,
  "..",
  "..",
  "skills",
  "pipeline",
  "flow-add",
  "SKILL.md",
);

const START = "<!-- start: shared -->";
const END = "<!-- end: shared -->";

function sliceShared(text: string, label: string): string {
  const startIdx = text.indexOf(START);
  const endIdx = text.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `${label} is missing the shared markers ${START}…${END} after rendering`,
    );
  }
  return text.slice(startIdx + START.length, endIdx).trim();
}

async function render(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8");
  return renderWithTriageContract(raw, {
    repoRoot: REPO_ROOT_PLACEHOLDER,
  });
}

describe("triage contract drift guard", () => {
  it("renders the same shared body for the system prompt and the SKILL.md", async () => {
    const systemPrompt = await render(SYSTEM_PROMPT_PATH);
    const skill = await render(SKILL_PATH);
    const sharedFromSystem = sliceShared(systemPrompt, "system prompt");
    const sharedFromSkill = sliceShared(skill, "SKILL.md");
    expect(sharedFromSkill).toBe(sharedFromSystem);
  });

  it("leaves no `<!-- include:` markers in either rendered output", async () => {
    const systemPrompt = await render(SYSTEM_PROMPT_PATH);
    const skill = await render(SKILL_PATH);
    expect(systemPrompt).not.toMatch(/<!--\s*include:/);
    expect(skill).not.toMatch(/<!--\s*include:/);
  });

  it("substitutes ${REPO_ROOT} in both rendered outputs", async () => {
    const systemPrompt = await render(SYSTEM_PROMPT_PATH);
    const skill = await render(SKILL_PATH);
    expect(systemPrompt).not.toContain("${REPO_ROOT}");
    expect(skill).not.toContain("${REPO_ROOT}");
    expect(systemPrompt).toContain(REPO_ROOT_PLACEHOLDER);
    expect(skill).toContain(REPO_ROOT_PLACEHOLDER);
  });
});
