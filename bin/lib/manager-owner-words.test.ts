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
  const bind = (slug: string, phase: string, n = 3) =>
    fs.writeFileSync(
      path.join(home, "handles.json"),
      JSON.stringify({
        version: 1,
        next: n + 1,
        items: { [`${slug}:${phase}`]: n },
      }),
    );
  const ok = (
    text: string,
    t: { slug: string; phase: string } = target,
    reply: "approve" | "redirect" | "answer" = "approve",
  ) => ownerShowsIntent(reply, text, t, home);

  it("refuses the owner's two over-accepted example lines", () => {
    const f3 = { slug: "f3-global-manager", phase: "plan-pending-review" };
    bind(f3.slug, f3.phase);
    expect(ok("should I approve f3-global-manager?", f3)).toBe(false);
    const f6 = { slug: "f6", phase: "plan-pending-review" };
    bind(f6.slug, f6.phase);
    expect(ok("approve f6 after f3 merges", f6)).toBe(false);
  });

  it("accepts exactly `yes #N` bound to this slug and phase", () => {
    bind(target.slug, target.phase);
    expect(ok("yes #3")).toBe(true);
    expect(ok("  YES   #3  ")).toBe(true);
    expect(ok("yes #3", target, "answer")).toBe(true);
  });

  it("refuses a handle bound elsewhere or absent", () => {
    bind("other", target.phase);
    expect(ok("yes #3")).toBe(false);
    bind(target.slug, "plan-pending-interview");
    expect(ok("yes #3")).toBe(false);
    bind(target.slug, target.phase);
    expect(ok("yes #4")).toBe(false);
    fs.rmSync(path.join(home, "handles.json"));
    expect(ok("yes #3")).toBe(false);
  });

  it("refuses every other wording for approve and answer", () => {
    bind(target.slug, target.phase);
    for (const text of [
      "yes #3?",
      "yes #3 please",
      "lgtm #3",
      "approve #3",
      "yes",
      "do not approve #3",
    ]) {
      expect(ok(text)).toBe(false);
      expect(ok(text, target, "answer")).toBe(false);
    }
  });

  it("keeps redirect wording, refusing questions and negations", () => {
    expect(ok("redirect fix-login: use x", target, "redirect")).toBe(true);
    expect(ok("should I redirect fix-login?", target, "redirect")).toBe(false);
    expect(ok("don't redirect fix-login", target, "redirect")).toBe(false);
  });
});
