import { describe, expect, it } from "vitest";
import { audit, parseArgs, type PrRow } from "./test-steps-audit";

describe("audit", () => {
  const prs: PrRow[] = [
    {
      number: 1,
      title: "with image",
      body: [
        "## Test Steps",
        "- [x] SUBJECTIVE: confirm the layout looks right",
        "![screenshot](https://github.com/user-attachments/assets/abc)",
      ].join("\n"),
    },
    {
      number: 2,
      title: "no image",
      body: [
        "## Test Steps",
        "- [ ] SUBJECTIVE: confirm the layout looks right",
      ].join("\n"),
    },
  ];

  it("counts taste items and image rate", () => {
    const result = audit("owner/repo", prs);
    expect(result.taste_items).toEqual({
      total: 2,
      with_image: 1,
      image_rate: 0.5,
    });
  });

  it("counts kinds across all PRs", () => {
    const result = audit("owner/repo", prs);
    expect(result.totals.kinds.subjective).toBe(2);
    expect(result.totals.prs).toBe(2);
  });

  it("detects hostedImage only on the PR whose body carries a user-attachments URL", () => {
    const result = audit("owner/repo", prs);
    expect(result.prs[0].hostedImage).toBe(true);
    expect(result.prs[1].hostedImage).toBe(false);
  });

  it("reports image_rate as null when there are no taste items", () => {
    const result = audit("owner/repo", [
      {
        number: 3,
        title: "none",
        body: "## Test Steps\n- [x] Run `npm run test`",
      },
    ]);
    expect(result.taste_items.image_rate).toBeNull();
  });
});

describe("parseArgs", () => {
  it("rejects --limit 0", () => {
    expect(parseArgs(["--repo", "owner/repo", "--limit", "0"])).toEqual({
      error: "--limit must be an integer from 1 to 200",
    });
  });

  it("rejects --limit 201", () => {
    expect(parseArgs(["--repo", "owner/repo", "--limit", "201"])).toEqual({
      error: "--limit must be an integer from 1 to 200",
    });
  });

  it("rejects a malformed --repo", () => {
    expect(parseArgs(["--repo", "bad"])).toEqual({
      error: "--repo <owner/name> is required",
    });
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--nope", "x"])).toEqual({
      error: "unknown flag: --nope",
    });
  });

  it("accepts a valid repo and default limit", () => {
    expect(parseArgs(["--repo", "owner/repo"])).toEqual({
      repo: "owner/repo",
      limit: 30,
    });
  });
});
