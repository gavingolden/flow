import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIssueBody } from "./issue-body-rubric";

const CONFORMING_FULL = `
- **UX:** any user who leaves a tab idle gets logged out [anchor: bin/lib/session.ts:88]
- **Problem:** the session timer clears on tab-blur [anchor: bin/lib/session.ts:88]
- **Stability/efficiency:** none
- **Value rank:** 4 [anchor: bin/lib/session.ts:88]
- **Complexity:** Small — one file, one function
- **Risk:** Low — a contained, reviewable fix
- **If never done:** users keep hitting an unexplained forced logout
- **Verdict:** clears bar — a reproducible forced logout outweighs a small fix
`;

const CONFORMING_SHORT_FORM =
  "**Short form:** the README link to docs/eval is dead [V:2|C:Trivial|R:Low] [anchor: README.md:41]";

describe("checkIssueBody: conforming bodies pass clean", () => {
  it("a conforming full block passes with zero misses and zero warnings", () => {
    const { misses, warnings } = checkIssueBody(CONFORMING_FULL);
    expect(misses).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a conforming short form passes with zero misses and zero warnings", () => {
    const { misses, warnings } = checkIssueBody(CONFORMING_SHORT_FORM);
    expect(misses).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("checkIssueBody: hard misses", () => {
  it("rejects an empty body", () => {
    expect(checkIssueBody("").misses).toContain("empty-body");
    expect(checkIssueBody("   \n  ").misses).toContain("empty-body");
  });

  it("rejects a body missing a required label", () => {
    const body = CONFORMING_FULL.replace(
      "- **Complexity:** Small — one file, one function\n",
      "",
    );
    expect(checkIssueBody(body).misses).toContain("missing-label:Complexity");
  });

  it("rejects a body with neither a short form nor a full block", () => {
    expect(checkIssueBody("just some prose").misses).toContain(
      "missing-value-block",
    );
  });

  it("rejects a Value rank outside 1-5", () => {
    const body = CONFORMING_FULL.replace(
      "- **Value rank:** 4 [anchor: bin/lib/session.ts:88]",
      "- **Value rank:** 9 [anchor: bin/lib/session.ts:88]",
    );
    expect(checkIssueBody(body).misses).toContain("invalid-value-rank");
  });

  it("rejects a Value rank with no anchor", () => {
    const body = CONFORMING_FULL.replace(
      "- **Value rank:** 4 [anchor: bin/lib/session.ts:88]",
      "- **Value rank:** 4",
    );
    expect(checkIssueBody(body).misses).toContain("invalid-value-rank");
  });

  it("rejects a Complexity value off the closed scale", () => {
    const body = CONFORMING_FULL.replace(
      "- **Complexity:** Small — one file, one function",
      "- **Complexity:** Huge — one file, one function",
    );
    expect(checkIssueBody(body).misses).toContain("invalid-complexity");
  });

  it("rejects a Risk value off the closed scale", () => {
    const body = CONFORMING_FULL.replace(
      "- **Risk:** Low — a contained, reviewable fix",
      "- **Risk:** Severe — a contained, reviewable fix",
    );
    expect(checkIssueBody(body).misses).toContain("invalid-risk");
  });

  it("rejects a Verdict that is neither 'clears bar' nor 'below bar'", () => {
    const body = CONFORMING_FULL.replace(
      "- **Verdict:** clears bar — a reproducible forced logout outweighs a small fix",
      "- **Verdict:** unclear — needs more discussion",
    );
    expect(checkIssueBody(body).misses).toContain("invalid-verdict");
  });

  it("rejects a body whose UX/Problem/Stability are all none-or-unanchored", () => {
    const body = `
- **UX:** none
- **Problem:** none
- **Stability/efficiency:** none
- **Value rank:** 2 [anchor: bin/lib/session.ts:88]
- **Complexity:** Trivial
- **Risk:** Low
- **If never done:** nothing
- **Verdict:** below bar — nothing observable changes
`;
    expect(checkIssueBody(body).misses).toContain("unsubstantiated");
  });

  it("rejects a short form lacking its [V:n|C:x|R:y] tuple", () => {
    const body =
      "**Short form:** the README link is dead [anchor: README.md:41]";
    expect(checkIssueBody(body).misses).toContain("short-form-missing-tuple");
  });

  it("rejects a short form lacking an anchor", () => {
    const body = "**Short form:** this would be nicer";
    expect(checkIssueBody(body).misses).toContain("short-form-unanchored");
  });
});

describe("checkIssueBody: advisory warnings never reject", () => {
  it("flags banned phrasing as a warning, not a miss", () => {
    const body = CONFORMING_FULL.replace(
      "- **Problem:** the session timer clears on tab-blur [anchor: bin/lib/session.ts:88]",
      "- **Problem:** it might be nicer if the timer survived tab-blur [anchor: bin/lib/session.ts:88]",
    );
    const { misses, warnings } = checkIssueBody(body);
    expect(misses).toEqual([]);
    expect(warnings.some((w) => w.includes("nicer"))).toBe(true);
    expect(warnings.some((w) => w.includes("might"))).toBe(true);
  });

  it("flags a dangling anchor path as a warning, not a miss, when repoRoot is supplied", () => {
    const { misses, warnings } = checkIssueBody(CONFORMING_FULL, {
      repoRoot: process.cwd(),
    });
    expect(misses).toEqual([]);
    expect(warnings.some((w) => w.includes("bin/lib/session.ts"))).toBe(true);
  });

  it("a body with a banned word and a dangling anchor path passes with warnings but zero misses", () => {
    const body = CONFORMING_FULL.replace(
      "- **Problem:** the session timer clears on tab-blur [anchor: bin/lib/session.ts:88]",
      "- **Problem:** it might be nicer if the timer survived tab-blur [anchor: bin/lib/session.ts:88]",
    );
    const { misses, warnings } = checkIssueBody(body, {
      repoRoot: process.cwd(),
    });
    expect(misses).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("does not warn on an anchor path that resolves under repoRoot", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "issue-body-rubric-test-"),
    );
    try {
      fs.writeFileSync(path.join(tmpDir, "real.ts"), "// exists\n");
      const body = CONFORMING_FULL.replace(
        /bin\/lib\/session\.ts:88/g,
        "real.ts:1",
      );
      const { warnings } = checkIssueBody(body, { repoRoot: tmpDir });
      expect(warnings.some((w) => w.includes("real.ts"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips the anchor-existence check entirely when repoRoot is omitted", () => {
    const { warnings } = checkIssueBody(CONFORMING_FULL);
    expect(warnings).toEqual([]);
  });
});
