import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { LoopLog } from "./ui-critique";
import { emptyLoopLog } from "./ui-critique";
import { UI_REVIEW_NOT_RUN_MARKER } from "./ui-critique-render";
import { notRunAccepted, type UiReviewGate } from "./ui-review-gate";
import { addMissingNotRunBox, ensureNotRunBox } from "./ui-review-not-run-box";

const UNSAT: UiReviewGate = {
  required: true,
  satisfied: false,
  reason: "UI review did not run: x",
};
const BODY = "## TLDR\n\nx\n\n## Test Steps\n\n- [x] `npm test` — pass\n";
const log = (over: Partial<LoopLog> = {}): LoopLog => ({
  ...emptyLoopLog(),
  ...over,
});
const unchecked = (b: string): string[] =>
  b
    .split("\n")
    .filter(
      (l) =>
        l.includes(UI_REVIEW_NOT_RUN_MARKER) && l.startsWith("- [ ] DECISION:"),
    );

describe("ensureNotRunBox shapes", () => {
  const cases: [string, string, LoopLog | null][] = [
    ["no log", BODY, null],
    [
      "skip set with required false",
      BODY,
      log({ skip: "headless-error", required: false }),
    ],
    ["log with no outcome and no skip", BODY, log()],
    [
      "skipped with persistent defects",
      `${BODY}- [ ] DECISION: accept this UI with 1 unresolved defect(s) listed under UI review (top: a), or redirect to fix them <!-- flow:ui-review-decision -->\n`,
      log({ skip: "headless-error", required: true, persistent: ["a"] }),
    ],
    [
      "review off at verify (Off stub)",
      `## TLDR\n\nx\n\n<!-- flow:ui-review -->\n## UI review\n\nOff: turned off in flow config.\n\n<!-- /flow:ui-review -->\n\n## Test Steps\n\n- [x] ok\n`,
      log({ skip: "disabled-by-config" }),
    ],
    [
      "Test Steps ending in </details>",
      "## Test Steps\n\n- [x] ok\n\n<details>\n<summary>ev</summary>\n\n- out\n</details>",
      null,
    ],
    [
      "trapped legacy look-alike",
      `## Test Steps\n\n- [x] ok\n<details>\n- [ ] DECISION: the UI review did not run (x) ${UI_REVIEW_NOT_RUN_MARKER}\n`,
      null,
    ],
  ];

  it.each(cases)("%s", (_n, body, l) => {
    const out = ensureNotRunBox(body, UNSAT, l)!;
    expect(out).not.toBeNull();
    expect(notRunAccepted(out)).toBe(true);
    // The trapped look-alike stays as text; only the fresh line is live.
    expect(unchecked(out)).toHaveLength(_n.startsWith("trapped") ? 2 : 1);
    expect(out.match(/<!-- flow:ui-review -->/g)).toHaveLength(1);
  });

  it("leaves an existing defects line byte-for-byte", () => {
    const [, body, l] = cases[3];
    const defects = body.split("\n").find((x) => x.includes("accept this UI"))!;
    expect(ensureNotRunBox(body, UNSAT, l)!.split("\n")).toContain(defects);
  });

  it("separates a trailing </details> with a blank line", () => {
    const out = ensureNotRunBox(cases[5][1], UNSAT, null)!;
    expect(out).toMatch(/<\/details>\n\n- \[ \] DECISION:/);
  });

  it("returns null when stale, satisfied, not required, no Test Steps, or already accepted", () => {
    expect(ensureNotRunBox(BODY, { ...UNSAT, stale: true }, null)).toBeNull();
    expect(
      ensureNotRunBox(BODY, { ...UNSAT, satisfied: true }, null),
    ).toBeNull();
    expect(
      ensureNotRunBox(BODY, { ...UNSAT, required: false }, null),
    ).toBeNull();
    expect(ensureNotRunBox("## TLDR\n\nx", UNSAT, null)).toBeNull();
    const accepted = `${BODY}- [x] DECISION: x ${UI_REVIEW_NOT_RUN_MARKER}\n`;
    expect(ensureNotRunBox(accepted, UNSAT, null)).toBeNull();
  });
});

describe("addMissingNotRunBox", () => {
  const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

  it("is unchanged when the box is already there", () => {
    const body = `${BODY}- [ ] DECISION: x ${UI_REVIEW_NOT_RUN_MARKER}\n`;
    const gh = vi.fn(() => ok(body));
    expect(addMissingNotRunBox({ pr: 3, ui: UNSAT, log: null, gh })).toEqual({
      kind: "unchanged",
    });
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("writes the new body through --body-file and removes the temp file", () => {
    let file = "";
    let written = "";
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] !== "edit") return ok(BODY + "\n");
      file = argv[argv.indexOf("--body-file") + 1];
      written = fs.readFileSync(file, "utf8");
      return ok();
    });
    const r = addMissingNotRunBox({ pr: 3, ui: UNSAT, log: null, gh });
    expect(r).toMatchObject({ kind: "written", body: written });
    expect(unchecked(written)).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("returns the first stderr line when the edit fails", () => {
    let file = "";
    const gh = vi.fn((argv: string[]) => {
      if (argv[1] !== "edit") return ok(BODY);
      file = argv[argv.indexOf("--body-file") + 1];
      return { stdout: "", stderr: "HTTP 502\nbody", exitCode: 1 };
    });
    expect(addMissingNotRunBox({ pr: 3, ui: UNSAT, log: null, gh })).toEqual({
      kind: "error",
      message: "HTTP 502",
    });
    expect(fs.existsSync(file)).toBe(false);
  });
});
