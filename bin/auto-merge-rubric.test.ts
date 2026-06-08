import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Exercises the auto-merge rubric's documented Bash snippet against
 * canonical PR-body shapes. Keeps the rubric's prose and the actual
 * shell behaviour in lockstep — if a future edit drifts the snippet,
 * one of the cases below will fail before any pipeline does.
 *
 * The snippet under test (kept verbatim with the rubric's "How to
 * extract the section" code block):
 *   1. heading-presence check (`grep -Eq '^## Test Steps[[:space:]]*$'`)
 *   2-4. extract → strip HTML comments → count unchecked checkboxes
 */
const SNIPPET = `
body=$(cat)

if ! printf '%s' "$body" | grep -Eq '^## Test Steps[[:space:]]*$'; then
  echo "missing"
  exit 0
fi

unchecked=$(printf '%s' "$body" \\
  | awk '/^## Test Steps[[:space:]]*$/{flag=1; next} /^## /{flag=0} flag' \\
  | perl -0pe 's/<!--.*?-->//gs' \\
  | grep -cE '^[[:space:]]*- \\[ \\]' || true)

if [ "$unchecked" = "0" ]; then
  echo "no-unchecked"
else
  echo "has-unchecked:$unchecked"
fi
`;

function classify(body: string): string {
  const result = spawnSync("bash", ["-c", SNIPPET], {
    input: body,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`snippet exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("auto-merge rubric snippet", () => {
  it("escalates when the heading is missing entirely", () => {
    expect(classify("## Why\n\nfoo\n\n## What\n\nbar")).toBe("missing");
  });

  it("auto-merges an empty section under the heading", () => {
    const body = "## Test Steps\n\n";
    expect(classify(body)).toBe("no-unchecked");
  });

  it("auto-merges when the body is only an HTML-comment placeholder", () => {
    const body = [
      "## Test Steps",
      "",
      "<!-- No human verification needed — pure-internal change. -->",
    ].join("\n");
    expect(classify(body)).toBe("no-unchecked");
  });

  it("auto-merges when every item is checked", () => {
    const body = [
      "## Test Steps",
      "",
      "- [x] `npm run verify` — pass",
      "- [x] manual smoke — done",
    ].join("\n");
    expect(classify(body)).toBe("no-unchecked");
  });

  it("auto-merges when the section contains only prose", () => {
    const body = ["## Test Steps", "", "Verified end-to-end on staging."].join(
      "\n",
    );
    expect(classify(body)).toBe("no-unchecked");
  });

  it("auto-merges when the section contains a checked item with an evidence block", () => {
    const body = [
      "## Test Steps",
      "",
      "- [x] `npm run verify` — pass",
      "  <details><!-- flow:evidence --><summary>Output</summary>",
      "",
      "  ```",
      "  PASS bin/foo.test.ts",
      "  ```",
      "",
      "  </details>",
    ].join("\n");
    expect(classify(body)).toBe("no-unchecked");
  });

  it("gates when one unchecked item remains", () => {
    const body = [
      "## Test Steps",
      "",
      "- [ ] Open /portfolio with the seeded user",
    ].join("\n");
    expect(classify(body)).toBe("has-unchecked:1");
  });

  it("gates when both checked and unchecked items are present", () => {
    const body = [
      "## Test Steps",
      "",
      "- [x] `npm run verify` — pass",
      "- [ ] Manual smoke step 1",
      "- [ ] Manual smoke step 2",
      "",
      "## Footer",
      "- [ ] this lives outside the section and should not count",
    ].join("\n");
    expect(classify(body)).toBe("has-unchecked:2");
  });
});
