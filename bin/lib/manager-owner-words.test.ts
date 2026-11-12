import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerShowsIntent, wordsNameTarget } from "./manager-owner-words";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mow-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const target = { slug: "fix-login", phase: "plan-pending-review" };

describe("wordsNameTarget", () => {
  it("is not satisfied by a planted proposal with an empty or arbitrary id", () => {
    const now = "2026-11-01T00:00:00.000Z";
    for (const id of ["", "ok", "a"]) {
      fs.writeFileSync(
        path.join(home, "proposals.json"),
        JSON.stringify({
          version: 1,
          proposals: [
            {
              id,
              kind: "epic-change",
              repo: "flow",
              slug: target.slug,
              text: "x",
              createdAt: now,
            },
          ],
        }),
      );
      for (const text of ["ok, sounds good.", "what is next?", "ok"]) {
        expect(wordsNameTarget(text, target, home)).toBe(false);
      }
    }
  });

  it("still matches a generated proposal id on word boundaries only", () => {
    fs.writeFileSync(
      path.join(home, "proposals.json"),
      JSON.stringify({
        version: 1,
        proposals: [
          {
            id: "p-0a1b2c",
            kind: "epic-change",
            repo: "flow",
            slug: target.slug,
            text: "x",
            createdAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(wordsNameTarget("yes p-0a1b2c", target, home)).toBe(true);
    expect(wordsNameTarget("yes p-0a1b2cd", target, home)).toBe(false);
  });
});

describe("ownerShowsIntent", () => {
  it("accepts un-negated approval words and refuses negated ones", () => {
    expect(ownerShowsIntent("approve", "lgtm #3")).toBe(true);
    expect(ownerShowsIntent("approve", "go ahead with fix-login")).toBe(true);
    expect(ownerShowsIntent("approve", "do not approve #3")).toBe(false);
    expect(ownerShowsIntent("approve", "no yes")).toBe(false);
    expect(ownerShowsIntent("approve", "what is #3?")).toBe(false);
  });
});
