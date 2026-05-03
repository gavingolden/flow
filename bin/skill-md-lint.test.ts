import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Step-transition lint for `skills/pipeline/flow-pipeline/SKILL.md`.
 *
 * Asserts that every `## Step ` heading in the supervisor's SKILL.md
 * opens with a leading continuation blockquote that contains a
 * `DO NOT END THE TURN` reminder. The blockquote is the load-bearing
 * defence against accidental turn-ends between sub-skills: it is the
 * first thing the supervisor reads when it lands on a step heading,
 * before any sub-skill tail message ("share with user and iterate",
 * `/verify`'s success summary, `/pr-review`'s post-push recap) can be
 * misread as a turn boundary.
 *
 * If a future edit removes the blockquote from a step (or buries it
 * below the `**Phase:**` line), this test fails with the offending
 * heading in the message — fix by lifting the reminder back to the
 * first content line under the heading.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);

type StepHeading = { headingLine: number; heading: string };

function findStepHeadings(lines: string[]): StepHeading[] {
  const out: StepHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## Step /.test(lines[i])) {
      out.push({ headingLine: i, heading: lines[i] });
    }
  }
  return out;
}

function firstNonBlank(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i].trim() === "") i++;
  return i;
}

function captureBlockquote(lines: string[], from: number): string {
  const collected: string[] = [];
  let i = from;
  while (i < lines.length && lines[i].startsWith(">")) {
    collected.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
const lines = content.split("\n");
const headings = findStepHeadings(lines);

describe("flow-pipeline SKILL.md step-transition lint", () => {
  it("finds every numbered step heading (sanity check)", () => {
    // The pipeline ships 11 step headings: 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 10.
    // If a future edit collapses or renames steps, update this expectation
    // intentionally — a silent drop here would mask a missing reminder
    // somewhere downstream.
    expect(headings.length).toBe(11);
  });

  it.each(headings)(
    "$heading opens with a blockquote as its first content line",
    ({ headingLine, heading }) => {
      const next = firstNonBlank(lines, headingLine + 1);
      const firstContent = lines[next] ?? "";
      expect(
        firstContent.startsWith(">"),
        `Expected first non-blank line under "${heading}" to be a continuation ` +
          `blockquote (starts with ">"), got: ${JSON.stringify(firstContent)}. ` +
          `Fix: lift the "DO NOT END THE TURN" reminder back to the first content ` +
          `line under the heading, before "**Phase:**".`,
      ).toBe(true);
    },
  );

  it.each(headings)(
    "$heading's leading blockquote contains a DO NOT END THE TURN reminder",
    ({ headingLine, heading }) => {
      const next = firstNonBlank(lines, headingLine + 1);
      const blockquote = captureBlockquote(lines, next);
      expect(
        /DO NOT END THE TURN/.test(blockquote),
        `Leading blockquote under "${heading}" is missing the literal ` +
          `"DO NOT END THE TURN" reminder. Got: ${JSON.stringify(blockquote)}. ` +
          `Fix: add the literal phrase to the blockquote — it is the ` +
          `lint-anchor that protects against accidental turn-ends between ` +
          `sub-skills.`,
      ).toBe(true);
    },
  );

  it.each(headings)(
    "$heading's leading blockquote opens with bold text (visual prominence)",
    ({ headingLine, heading }) => {
      const next = firstNonBlank(lines, headingLine + 1);
      const firstContent = lines[next] ?? "";
      // Strip the leading `>` and optional space, then assert the
      // remainder starts with `**` (markdown bold). The bold opener
      // makes the reminder visually stand out from prose.
      const inner = firstContent.replace(/^>\s?/, "");
      expect(
        inner.startsWith("**"),
        `Leading blockquote under "${heading}" should open with bold text ` +
          `("> **…**") for visual prominence, got: ${JSON.stringify(firstContent)}.`,
      ).toBe(true);
    },
  );
});
