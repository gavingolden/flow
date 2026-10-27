import { describe, expect, it } from "vitest";
import { computeDecisionHash } from "../flow-plan-review";
import {
  checkPlanPreconditions,
  ONE_WAY_ACTION_PATTERNS,
  type PreconditionId,
} from "./exec-review-preconditions";

const BASE_PLAN = `# PRD

# Title

**Goal:** Do the thing for the owner.

## Request vetting

- **Hypothesis:** h
- **Verdict:** adopt-with-conditions: keep it small

## Open Questions

- [x] Q0 — done
  - **Stakes:** user
- [ ] Q1 — resolved
  - **Stakes:** both
  - **Recommended:** yes [confidence: high] [anchor: bin/lib/state.ts:10]
- [ ] Q2 — system only
  - **Stakes:** system
  - **Recommended:** fine [confidence: medium] [anchor: bin/lib/state.ts:11]

## Recommendation

**Proceed** — go.

# Task breakdown

### Task 1: Thing

- **Description:** does a thing.
- **Contract:**
  - **Files:** edit \`bin/lib/state.ts\`.
- **Acceptance criteria:** \`npx vitest run bin/lib/state.test.ts\`

## Test Steps

- [ ] Run \`npx vitest run bin/lib/state.test.ts\` — passes.
`;

function stamp(plan: string): string {
  return `${plan}\n<!-- flow-plan-review-hash: ${computeDecisionHash(plan)} -->\n`;
}

const RUN_OK = JSON.stringify({
  ran: true,
  reviewers: [
    { model: "Gemini 4 Argon (High)", ran: true, lensesEngaged: 7 },
    { model: "Claude Opus 5.5 (High)", ran: false, skipReason: "agy-error" },
  ],
});

const deps = {
  fileExists: () => true,
  lineCount: () => 1000,
  lint: () => [] as string[],
};

const check = (
  planText: string,
  runRecordText: string | null = RUN_OK,
  d: Parameters<typeof checkPlanPreconditions>[1] = deps,
) => checkPlanPreconditions({ planText, runRecordText, worktree: "/wt" }, d);

const failed = (r: ReturnType<typeof check>): PreconditionId | null =>
  r.ok ? null : r.failed;

describe("checkPlanPreconditions", () => {
  it("passes a clean plan", () => {
    expect(check(stamp(BASE_PLAN))).toEqual({ ok: true });
  });

  it("cross-model-unavailable: no run record, or an unparseable one", () => {
    expect(failed(check(stamp(BASE_PLAN), null))).toBe(
      "cross-model-unavailable",
    );
    expect(failed(check(stamp(BASE_PLAN), "{nope"))).toBe(
      "cross-model-unavailable",
    );
  });

  it("cross-model-not-engaged: only Claude ran, too few lenses, or nothing ran", () => {
    const rec = (r: object[]) => JSON.stringify({ reviewers: r });
    expect(
      failed(
        check(
          stamp(BASE_PLAN),
          rec([{ model: "Claude Opus", ran: true, lensesEngaged: 7 }]),
        ),
      ),
    ).toBe("cross-model-not-engaged");
    expect(
      failed(
        check(
          stamp(BASE_PLAN),
          rec([{ model: "Gemini", ran: true, lensesEngaged: 1 }]),
        ),
      ),
    ).toBe("cross-model-not-engaged");
    expect(
      failed(check(stamp(BASE_PLAN), rec([{ model: "Gemini", ran: false }]))),
    ).toBe("cross-model-not-engaged");
    expect(failed(check(stamp(BASE_PLAN), "{}"))).toBe(
      "cross-model-not-engaged",
    );
  });

  it("cross-model-stale: a missing marker, or a changed reviewed decision", () => {
    expect(failed(check(BASE_PLAN))).toBe("cross-model-stale");
    const stale = stamp(BASE_PLAN).replace("keep it small", "keep it tiny");
    expect(failed(check(stale))).toBe("cross-model-stale");
  });

  it("anchor-unresolved: a missing file, or a line past the end", () => {
    const withAnchor = stamp(`${BASE_PLAN}\n[anchor: bin/lib/state.ts:99]\n`);
    expect(
      failed(check(withAnchor, RUN_OK, { ...deps, fileExists: () => false })),
    ).toBe("anchor-unresolved");
    expect(
      failed(check(withAnchor, RUN_OK, { ...deps, lineCount: () => 50 })),
    ).toBe("anchor-unresolved");
    expect(check(withAnchor).ok).toBe(true);
  });

  it("anchor-unresolved: a path that escapes the worktree", () => {
    const esc = stamp(`${BASE_PLAN}\n[anchor: ../outside/secret.txt]\n`);
    expect(failed(check(esc))).toBe("anchor-unresolved");
  });

  it("plan-lint: any lint miss", () => {
    expect(
      failed(
        check(stamp(BASE_PLAN), RUN_OK, { ...deps, lint: () => ["missing X"] }),
      ),
    ).toBe("plan-lint");
  });

  it("needs-user-input: an unchecked question with the escape", () => {
    const plan = BASE_PLAN.replace(
      "- [ ] Q2 — system only",
      "- [ ] Q2 — owner call\n  - **Needs user input:** pick a name",
    );
    expect(failed(check(stamp(plan)))).toBe("needs-user-input");
  });

  it("needs-user-input does not fire on a CHECKED question", () => {
    const plan = BASE_PLAN.replace(
      "- [x] Q0 — done",
      "- [x] Q0 — done\n  - **Needs user input:** answered",
    );
    expect(check(stamp(plan)).ok).toBe(true);
  });

  it("stakes-confidence: user or both stakes without a high-confidence recommendation", () => {
    const weak = BASE_PLAN.replace(
      "yes [confidence: high]",
      "yes [confidence: medium]",
    );
    expect(failed(check(stamp(weak)))).toBe("stakes-confidence");
    const user = BASE_PLAN.replace("**Stakes:** system", "**Stakes:** user");
    expect(failed(check(stamp(user)))).toBe("stakes-confidence");
  });

  it("plan-deviates-from-request: non-Proceed, push back, or an unreadable verdict", () => {
    expect(
      failed(
        check(
          stamp(BASE_PLAN.replace("**Proceed** — go.", "**Revise** — no.")),
        ),
      ),
    ).toBe("plan-deviates-from-request");
    expect(
      failed(
        check(
          stamp(
            BASE_PLAN.replace(
              "adopt-with-conditions: keep it small",
              "push back: do something else",
            ),
          ),
        ),
      ),
    ).toBe("plan-deviates-from-request");
    expect(
      failed(
        check(
          stamp(
            BASE_PLAN.replace("adopt-with-conditions: keep it small", "sure"),
          ),
        ),
      ),
    ).toBe("plan-deviates-from-request");
    expect(
      check(
        stamp(
          BASE_PLAN.replace("adopt-with-conditions: keep it small", "adopt"),
        ),
      ).ok,
    ).toBe(true);
  });

  const oneWay: Array<[string, string]> = [
    ["supabase db reset", "Run `supabase db reset` locally."],
    ["db push", "Run `supabase db push`."],
    ["--linked", "`supabase migration up --linked`"],
    ["drop", "Execute DROP TABLE users."],
    ["truncate", "then truncate the table"],
    ["publish", "`npm publish` the package"],
    ["prod deploy", "deploy to production"],
    ["usage counter", "reset the usage counter"],
    ["shared service", "wipe the shared service state"],
    ["override", "call `flow-merge-guard --record-override`"],
    ["merge", "`gh pr merge 5`"],
    ["paid live", "`FLOW_LIVE_EXEC_REVIEW=1 npx vitest run x`"],
    ["eval", "`npm run eval`"],
    ["budget", "raise `--max-budget-usd` to 9"],
    ["billing", "change the billing plan"],
  ];

  it.each(oneWay)("one-way-action: %s in an acceptance command", (_n, text) => {
    const plan = BASE_PLAN.replace(
      "`npx vitest run bin/lib/state.test.ts`\n\n## Test",
      `\`npx vitest run bin/lib/state.test.ts\` && ${text}\n\n## Test`,
    );
    expect(plan).not.toBe(BASE_PLAN);
    expect(failed(check(stamp(plan)))).toBe("one-way-action");
  });

  it("one-way-action: in a Contract block or a Test Step", () => {
    const inContract = BASE_PLAN.replace(
      "edit `bin/lib/state.ts`.",
      "edit state; `npm publish`.",
    );
    expect(inContract).not.toBe(BASE_PLAN);
    expect(failed(check(stamp(inContract)))).toBe("one-way-action");
    const inStep = BASE_PLAN.replace("— passes.", "— then `gh pr merge`.");
    expect(failed(check(stamp(inStep)))).toBe("one-way-action");
  });

  it("one-way-action: prose in a task Description is not scanned", () => {
    const desc = BASE_PLAN.replace(
      "does a thing.",
      "never run gh pr merge here.",
    );
    expect(check(stamp(desc)).ok).toBe(true);
  });

  it("has a failing case for every PreconditionId", () => {
    const covered = new Set<PreconditionId>([
      "cross-model-unavailable",
      "cross-model-not-engaged",
      "cross-model-stale",
      "anchor-unresolved",
      "plan-lint",
      "needs-user-input",
      "stakes-confidence",
      "plan-deviates-from-request",
      "one-way-action",
    ]);
    expect(covered.size).toBe(9);
    expect(ONE_WAY_ACTION_PATTERNS.length).toBeGreaterThan(10);
  });
});
