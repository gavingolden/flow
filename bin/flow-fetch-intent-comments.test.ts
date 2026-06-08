/**
 * Tests for flow-fetch-intent-comments.ts — exercises the anti-injection
 * filter and the markdown output formatter. No real gh invocation: we
 * inject pre-fetched comments + the author login into the pure
 * `formatIntentComments` function.
 */

import { describe, expect, it } from "vitest";
import {
  formatIntentComments,
  INTEGRITY_SUFFIX,
  isIntentComment,
  NO_MATCHES_MESSAGE,
  stripIntentMarkers,
  WHY_PREFIX,
} from "./flow-fetch-intent-comments";
import type { ReviewComment } from "./flow-fetch-pr-review";

const AUTHOR = "alice";
const REVIEWER = "bob";

// --- Factory ---

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 1,
    path: "src/a.ts",
    line: 10,
    start_line: null,
    body: "default",
    diff_hunk: "@@ ... @@",
    html_url: "https://github.com/o/r/pull/1#comment-1",
    user: { login: AUTHOR },
    in_reply_to_id: null,
    ...overrides,
  };
}

const intentBody = (rationale: string) =>
  `${WHY_PREFIX}${rationale}\n\n${INTEGRITY_SUFFIX}`;

// --- isIntentComment ---

describe(isIntentComment, () => {
  it("(a) rejects comments not starting with `**why:** `", () => {
    const c = comment({
      body: `**suggestion:** consider X\n\n${INTEGRITY_SUFFIX}`,
      user: { login: AUTHOR },
    });
    expect(isIntentComment(c, AUTHOR)).toBe(false);
  });

  it("(b) rejects `**why:** `-prefixed comments from non-author users (login mismatch)", () => {
    const c = comment({
      body: intentBody("totally a why comment"),
      user: { login: REVIEWER },
    });
    expect(isIntentComment(c, AUTHOR)).toBe(false);
  });

  it("(c) rejects `**why:** `-prefixed author-comments missing the integrity suffix", () => {
    const c = comment({
      body: `${WHY_PREFIX}why text without suffix`,
      user: { login: AUTHOR },
    });
    expect(isIntentComment(c, AUTHOR)).toBe(false);
  });

  it("accepts when all three checks pass", () => {
    const c = comment({
      body: intentBody("good rationale"),
      user: { login: AUTHOR },
    });
    expect(isIntentComment(c, AUTHOR)).toBe(true);
  });

  it("rejects reply threads even when prefix + identity + suffix all match", () => {
    const c = comment({
      body: intentBody("reply text"),
      user: { login: AUTHOR },
      in_reply_to_id: 42,
    });
    expect(isIntentComment(c, AUTHOR)).toBe(false);
  });
});

// --- stripIntentMarkers ---

describe(stripIntentMarkers, () => {
  it("strips the `**why:** ` prefix and the integrity suffix", () => {
    const body = intentBody("the rationale");
    expect(stripIntentMarkers(body)).toBe("the rationale");
  });

  it("trims surrounding whitespace", () => {
    const body = `${WHY_PREFIX}padded   \n\n${INTEGRITY_SUFFIX}\n\n`;
    expect(stripIntentMarkers(body)).toBe("padded");
  });
});

// --- formatIntentComments ---

describe(formatIntentComments, () => {
  it("(d) emits the no-matches sentinel when zero comments match", () => {
    expect(formatIntentComments([], AUTHOR)).toBe(NO_MATCHES_MESSAGE);
    // Also when there are comments but none match (all reviewer-authored).
    const reviewerComments = [
      comment({ id: 1, user: { login: REVIEWER }, body: intentBody("rev1") }),
      comment({ id: 2, user: { login: REVIEWER }, body: intentBody("rev2") }),
    ];
    expect(formatIntentComments(reviewerComments, AUTHOR)).toBe(
      NO_MATCHES_MESSAGE,
    );
  });

  it("(e) formats matching comments as `- <file>:L<line> → <stripped>` in path-alphabetical order", () => {
    const comments: ReviewComment[] = [
      comment({
        id: 1,
        path: "b.ts",
        line: 20,
        body: intentBody("second-file rationale"),
      }),
      comment({
        id: 2,
        path: "a.ts",
        line: 10,
        body: intentBody("first-file rationale"),
      }),
      comment({
        id: 3,
        path: "a.ts",
        line: 5,
        body: intentBody("first-file earlier"),
      }),
    ];
    const out = formatIntentComments(comments, AUTHOR);
    const lines = out.split("\n");
    expect(lines).toEqual([
      "- a.ts:L5 → first-file earlier",
      "- a.ts:L10 → first-file rationale",
      "- b.ts:L20 → second-file rationale",
    ]);
  });

  it("filters out non-author comments mixed with valid intent annotations", () => {
    const comments: ReviewComment[] = [
      comment({
        id: 1,
        path: "a.ts",
        line: 1,
        body: intentBody("author rationale"),
      }),
      // Reviewer pretending to be an intent annotation: should be dropped.
      comment({
        id: 2,
        path: "a.ts",
        line: 2,
        body: intentBody("malicious"),
        user: { login: REVIEWER },
      }),
      // Author comment without integrity suffix: should be dropped.
      comment({
        id: 3,
        path: "a.ts",
        line: 3,
        body: `${WHY_PREFIX}no suffix here`,
      }),
    ];
    const out = formatIntentComments(comments, AUTHOR);
    expect(out).toBe("- a.ts:L1 → author rationale");
  });

  it("collapses internal newlines so each bullet stays on one line", () => {
    const body = `${WHY_PREFIX}line one\nline two\n\n${INTEGRITY_SUFFIX}`;
    const c = comment({ id: 1, path: "x.ts", line: 5, body });
    const out = formatIntentComments([c], AUTHOR);
    expect(out).toBe("- x.ts:L5 → line one line two");
    expect(out).not.toContain("\n");
  });
});
