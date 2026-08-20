import { describe, expect, it } from "vitest";
import { headingRegex, upsertPrBodySection } from "./pr-body-upsert";

const FOLLOWUPS = "## Local Follow-ups";
const FORECLOSED = "## Foreclosed Paths";

describe("headingRegex", () => {
  it("matches the heading on its own line, tolerating trailing whitespace", () => {
    expect(headingRegex(FOLLOWUPS).test("## Local Follow-ups")).toBe(true);
    expect(headingRegex(FOLLOWUPS).test("## Local Follow-ups  ")).toBe(true);
    expect(headingRegex(FOLLOWUPS).test("prefix ## Local Follow-ups")).toBe(
      false,
    );
  });

  it("escapes regex metacharacters in the heading", () => {
    // A heading with metacharacters must be matched literally, not as a regex.
    const re = headingRegex("## A.B+C");
    expect(re.test("## A.B+C")).toBe(true);
    expect(re.test("## AXBC")).toBe(false);
  });
});

describe("upsertPrBodySection — Local Follow-ups (behavior parity)", () => {
  it("appends to a body without the heading", () => {
    const out = upsertPrBodySection(
      "## Why\nbecause\n",
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] x  # r",
    );
    expect(out).toBe(
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] x  # r\n",
    );
  });

  it("renders into an empty body", () => {
    const out = upsertPrBodySection(
      "",
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] x  # r",
    );
    expect(out).toBe("## Local Follow-ups\n\n- [ ] x  # r\n");
  });

  it("replaces an existing section in place when followed by another heading", () => {
    const before =
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] old  # old\n\n## Test Steps\n\n- [ ] verify\n";
    const out = upsertPrBodySection(
      before,
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] new  # new",
    );
    expect(out).toBe(
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] new  # new\n\n## Test Steps\n\n- [ ] verify\n",
    );
  });

  it("replaces an existing section at end of body", () => {
    const before =
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] old  # old\n";
    const out = upsertPrBodySection(
      before,
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] new  # new",
    );
    expect(out).toBe(
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] new  # new\n",
    );
  });

  it("is idempotent — second run with same input returns same output", () => {
    const section = "## Local Follow-ups\n\n- [ ] x  # r";
    const once = upsertPrBodySection("## Why\nbecause\n", FOLLOWUPS, section);
    const twice = upsertPrBodySection(once, FOLLOWUPS, section);
    expect(twice).toBe(once);
  });

  it("is a no-op when the input already contains the identical section", () => {
    const body = "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] x  # r\n";
    const out = upsertPrBodySection(
      body,
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] x  # r",
    );
    expect(out).toBe(body);
  });
});

describe("upsertPrBodySection — <details> normalization", () => {
  it("normalizes a malformed <details> section on upsert", () => {
    const out = upsertPrBodySection(
      "## Why\nbecause\n",
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] x  # r\n<details><summary>evidence</summary>\ncontent\n</details>\nnext line",
    );
    expect(out).toContain("<summary>evidence</summary>\n\ncontent");
    expect(out).toContain("</details>\n\nnext line");
  });

  it("leaves a well-formed <details> section byte-identical", () => {
    const before =
      "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] x  # r\n\n<details><summary>evidence</summary>\n\ncontent\n\n</details>\n";
    const out = upsertPrBodySection(
      before,
      FOLLOWUPS,
      "## Local Follow-ups\n\n- [ ] x  # r\n\n<details><summary>evidence</summary>\n\ncontent\n\n</details>",
    );
    expect(out).toBe(before);
  });

  it("stays idempotent round-tripping an embedded-heading payload carrying <details> markup (mirrors foreclosed-paths-format.test.ts's round-trip coverage)", () => {
    const section =
      "## Local Follow-ups\n\n- [ ] x  # r\n<details><summary>a</summary>\nb\n</details>\ntail";
    const once = upsertPrBodySection("", FOLLOWUPS, section);
    const twice = upsertPrBodySection(once, FOLLOWUPS, section);
    expect(twice).toBe(once);
  });
});

describe("upsertPrBodySection — independent headings coexist", () => {
  it("splices Foreclosed Paths without clobbering an existing Local Follow-ups section", () => {
    const before = "## Why\nbecause\n\n## Local Follow-ups\n\n- [ ] x  # r\n";
    const out = upsertPrBodySection(
      before,
      FORECLOSED,
      "## Foreclosed Paths\n\n- considered A, rejected: B",
    );
    expect(out).toContain("## Local Follow-ups\n\n- [ ] x  # r");
    expect(out).toContain("## Foreclosed Paths\n\n- considered A, rejected: B");
    // The two sections coexist: both headings present, neither dropped.
    expect(out.match(/^## /gm)).toEqual(["## ", "## ", "## "]);
  });

  it("updating one heading leaves the other heading's body untouched", () => {
    const before =
      "## Foreclosed Paths\n\n- old foreclosed\n\n## Local Follow-ups\n\n- [ ] x  # r\n";
    const out = upsertPrBodySection(
      before,
      FORECLOSED,
      "## Foreclosed Paths\n\n- new foreclosed",
    );
    expect(out).toContain("## Foreclosed Paths\n\n- new foreclosed");
    expect(out).not.toContain("old foreclosed");
    expect(out).toContain("## Local Follow-ups\n\n- [ ] x  # r");
  });
});
