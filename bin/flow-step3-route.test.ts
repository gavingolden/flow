import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_INTENTS,
  decideStep3Route,
  extractRecommendedPath,
  extractSurveyVerdict,
  parseArgs,
  run,
  SURVEY_VERDICTS,
  type Intent,
} from "./flow-step3-route";

const NON_FEATURE_INTENTS: Intent[] = [
  "bug",
  "refactor",
  "docs",
  "infra",
  "chore",
];

const PLAN_WITHOUT_SECTION = `# PRD

## Problem Statement

The user wants something.

## Scope Boundary

In scope: foo.

# Task breakdown

### Task 1: Foo
`;

const PLAN_METHODS_REACH = `# PRD

## Problem Statement

Some problem.

## Prompt interpretation

- **Reading of prescribed methods:** starting points
- **Plausibility estimate:** Yes — the methods directly close the gap.
- **Recommended path:** methods plausibly reach target

## Scope Boundary

In scope: ...
`;

const PLAN_EXTEND_SCOPE = `## Prompt interpretation

- **Reading of prescribed methods:** starting points
- **Plausibility estimate:** Mostly — one named gap.
- **Recommended path:** extend scope with named additional safe steps
`;

const PLAN_RELAX_TARGET = `## Prompt interpretation

- **Recommended path:** relax target
`;

const PLAN_SPLIT_PIPELINES = `## Prompt interpretation

- **Recommended path:** split into multiple pipelines
`;

describe(decideStep3Route, () => {
  describe("feature intent (Cell D — always routes to step 4)", () => {
    it("routes to step 4 with empty planMd", () => {
      expect(decideStep3Route("feature", "")).toBe("route-to-step-4");
    });

    it("routes to step 4 when planMd has no Prompt-Interpretation section", () => {
      expect(decideStep3Route("feature", PLAN_WITHOUT_SECTION)).toBe(
        "route-to-step-4",
      );
    });

    it("routes to step 4 even when planMd's Recommended path is `methods plausibly reach target`", () => {
      // Existing feature-intent contract in /flow-pipeline Step 3:
      // feature always goes through the approval checkpoint regardless
      // of plan.md content. The helper mirrors that.
      expect(decideStep3Route("feature", PLAN_METHODS_REACH)).toBe(
        "route-to-step-4",
      );
    });

    it("routes to step 4 when planMd flags tension", () => {
      expect(decideStep3Route("feature", PLAN_EXTEND_SCOPE)).toBe(
        "route-to-step-4",
      );
    });
  });

  describe.each(NON_FEATURE_INTENTS)("non-feature intent '%s'", (intent) => {
    it("advances to step 5 when no Prompt-Interpretation section (Cell A)", () => {
      expect(decideStep3Route(intent, PLAN_WITHOUT_SECTION)).toBe(
        "advance-to-step-5",
      );
    });

    it("advances to step 5 when section is present with `methods plausibly reach target` (Cell B)", () => {
      expect(decideStep3Route(intent, PLAN_METHODS_REACH)).toBe(
        "advance-to-step-5",
      );
    });

    it("routes to step 4 when section flags `extend scope with named additional safe steps` (Cell C)", () => {
      expect(decideStep3Route(intent, PLAN_EXTEND_SCOPE)).toBe(
        "route-to-step-4",
      );
    });

    it("routes to step 4 when section flags `relax target` (Cell C)", () => {
      expect(decideStep3Route(intent, PLAN_RELAX_TARGET)).toBe(
        "route-to-step-4",
      );
    });

    it("routes to step 4 when section flags `split into multiple pipelines` (Cell C)", () => {
      expect(decideStep3Route(intent, PLAN_SPLIT_PIPELINES)).toBe(
        "route-to-step-4",
      );
    });
  });
});

const PLAN_VERDICT_CONVERGE_AGAINST = `## Method selection\n\n- **Survey verdict:** converge-against\n`;
const PLAN_VERDICT_SPLIT = `## Method selection\n\n- **Survey verdict:** split\n`;
const PLAN_VERDICT_CONVERGE_WITH = `## Method selection\n\n- **Survey verdict:** converge-with\n`;
const PLAN_VERDICT_PARAPHRASE = `## Method selection\n\n- **Survey verdict:** converge-against (single judge)\n`;

describe("decideStep3Route — Method-selection verdict × intent × --method-resolved", () => {
  it("converge-against + feature, no flag ⇒ pause-for-method", () => {
    expect(decideStep3Route("feature", PLAN_VERDICT_CONVERGE_AGAINST)).toBe(
      "pause-for-method",
    );
  });

  it("converge-against + feature + --method-resolved ⇒ route-to-step-4", () => {
    expect(
      decideStep3Route("feature", PLAN_VERDICT_CONVERGE_AGAINST, {
        methodResolved: true,
      }),
    ).toBe("route-to-step-4");
  });

  it("converge-against + docs + resolved + no tension ⇒ advance-to-step-5 (resolved converge-against behaves as converge-with)", () => {
    expect(
      decideStep3Route("docs", PLAN_VERDICT_CONVERGE_AGAINST, {
        methodResolved: true,
      }),
    ).toBe("advance-to-step-5");
  });

  it("split + bug ⇒ route-to-step-4", () => {
    expect(decideStep3Route("bug", PLAN_VERDICT_SPLIT)).toBe("route-to-step-4");
  });

  it("split + feature ⇒ route-to-step-4", () => {
    expect(decideStep3Route("feature", PLAN_VERDICT_SPLIT)).toBe(
      "route-to-step-4",
    );
  });

  it("converge-with + bug ⇒ advance-to-step-5", () => {
    expect(decideStep3Route("bug", PLAN_VERDICT_CONVERGE_WITH)).toBe(
      "advance-to-step-5",
    );
  });

  it("converge-against + bug, no flag ⇒ pause-for-method (pause beats the non-feature path)", () => {
    expect(decideStep3Route("bug", PLAN_VERDICT_CONVERGE_AGAINST)).toBe(
      "pause-for-method",
    );
  });

  it("a paraphrased verdict is extracted verbatim but is not an exact SURVEY_VERDICTS match, so it never pauses", () => {
    // extractSurveyVerdict is a thin wrapper over extractLabeledValue (same
    // contract as extractRecommendedPath) — it returns the decoration-
    // stripped string as-is; the exact-match-against-the-enum check lives
    // in decideStep3Route, not in the extractor. "converge-against (single
    // judge)" is therefore a non-null, non-enum string here.
    expect(extractSurveyVerdict(PLAN_VERDICT_PARAPHRASE)).toBe(
      "converge-against (single judge)",
    );
    expect(
      (SURVEY_VERDICTS as readonly string[]).includes(
        extractSurveyVerdict(PLAN_VERDICT_PARAPHRASE) as string,
      ),
    ).toBe(false);
    expect(decideStep3Route("feature", PLAN_VERDICT_PARAPHRASE)).toBe(
      "route-to-step-4",
    );
    expect(decideStep3Route("bug", PLAN_VERDICT_PARAPHRASE)).toBe(
      "advance-to-step-5",
    );
  });

  it("no `## Method selection` section leaves the existing 4-cell matrix unchanged", () => {
    expect(decideStep3Route("bug", PLAN_WITHOUT_SECTION)).toBe(
      "advance-to-step-5",
    );
    expect(decideStep3Route("feature", PLAN_WITHOUT_SECTION)).toBe(
      "route-to-step-4",
    );
  });
});

// Every fixture above carries only ONE of the two sections
// (`## Prompt interpretation` OR `## Method selection`), so rule 1
// (pause-for-method) beating rule 2's tension arm, and rule 2's tension
// arm beating rule 2's split arm, are never jointly observed. These
// fixtures concatenate the existing per-section builders so both
// sections are present on the same plan.md, pinning the documented
// precedence (docstring above decideStep3Route): pause-for-method >
// route-to-step-4 (feature | tension | non-feature split) > advance.
describe("decideStep3Route — combined Prompt-interpretation tension + Method-selection verdict precedence", () => {
  it("tension (relax target) + converge-against + bug, unresolved ⇒ pause-for-method (pause beats tension)", () => {
    expect(
      decideStep3Route(
        "bug",
        PLAN_RELAX_TARGET + PLAN_VERDICT_CONVERGE_AGAINST,
      ),
    ).toBe("pause-for-method");
  });

  it("tension (relax target) + converge-against + bug, --method-resolved ⇒ route-to-step-4 (tension still routes once the pause is resolved)", () => {
    expect(
      decideStep3Route(
        "bug",
        PLAN_RELAX_TARGET + PLAN_VERDICT_CONVERGE_AGAINST,
        { methodResolved: true },
      ),
    ).toBe("route-to-step-4");
  });

  it("tension (relax target) + split + bug ⇒ route-to-step-4", () => {
    expect(
      decideStep3Route("bug", PLAN_RELAX_TARGET + PLAN_VERDICT_SPLIT),
    ).toBe("route-to-step-4");
  });

  it("no tension + split + bug, --method-resolved ⇒ still route-to-step-4 (resolved never downgrades split)", () => {
    expect(
      decideStep3Route("bug", PLAN_METHODS_REACH + PLAN_VERDICT_SPLIT, {
        methodResolved: true,
      }),
    ).toBe("route-to-step-4");
  });

  it("tension (relax target) + converge-with + docs ⇒ route-to-step-4", () => {
    expect(
      decideStep3Route("docs", PLAN_RELAX_TARGET + PLAN_VERDICT_CONVERGE_WITH),
    ).toBe("route-to-step-4");
  });
});

describe(extractSurveyVerdict, () => {
  it("returns null when the `## Method selection` heading is absent", () => {
    expect(extractSurveyVerdict(PLAN_WITHOUT_SECTION)).toBeNull();
    expect(extractSurveyVerdict("")).toBeNull();
  });

  it("extracts the colon-form value", () => {
    expect(extractSurveyVerdict(PLAN_VERDICT_SPLIT)).toBe("split");
  });

  it("strips bold decoration and a trailing period", () => {
    const plan = `## Method selection\n\n- **Survey verdict:** **\`converge-with\`**.\n`;
    expect(extractSurveyVerdict(plan)).toBe("converge-with");
  });

  it.each(SURVEY_VERDICTS)(
    "extracts '%s' from a drifted `- **Survey verdict.**` label with the value on the next line",
    (verdict) => {
      const plan = `## Method selection\n\n- **Survey verdict.**\n${verdict}\n`;
      expect(extractSurveyVerdict(plan)).toBe(verdict);
    },
  );

  it("does not bleed into the next ## section", () => {
    const plan = `## Method selection\n\n- **Survey verdict:** converge-with\n\n## Scope Boundary\n\n- **Survey verdict:** SHOULD-NOT-BE-PICKED-UP\n`;
    expect(extractSurveyVerdict(plan)).toBe("converge-with");
  });

  it("returns null when the label lives only in a neighbouring section", () => {
    const plan = `## Prompt interpretation\n\n- **Survey verdict:** converge-against\n\n## Method selection\n\nprose only\n\n## Scope Boundary\n\n- **Survey verdict:** split\n`;
    expect(extractSurveyVerdict(plan)).toBeNull();
    expect(decideStep3Route("bug", plan)).toBe("advance-to-step-5");
  });
});

describe(extractRecommendedPath, () => {
  it("returns null when section heading is absent", () => {
    expect(extractRecommendedPath(PLAN_WITHOUT_SECTION)).toBeNull();
    expect(extractRecommendedPath("")).toBeNull();
  });

  it("extracts the bare enum value", () => {
    expect(extractRecommendedPath(PLAN_METHODS_REACH)).toBe(
      "methods plausibly reach target",
    );
    expect(extractRecommendedPath(PLAN_RELAX_TARGET)).toBe("relax target");
  });

  it("strips surrounding bolding (**...**)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** **methods plausibly reach target**\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips surrounding backticks (`...`)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`methods plausibly reach target\`\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("trims whitespace around the value", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:**     methods plausibly reach target    \n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("preserves case verbatim (no normalisation)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** Methods Plausibly Reach Target\n`;
    expect(extractRecommendedPath(plan)).toBe("Methods Plausibly Reach Target");
  });

  it("strips backticks and a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`methods plausibly reach target\`.\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips a trailing period off a bare value", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target.\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it.each([",", ";", ":"])(
    "strips a trailing '%s' off a bare value (non-period terminators)",
    (terminator) => {
      const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target${terminator}\n`;
      expect(extractRecommendedPath(plan)).toBe(
        "methods plausibly reach target",
      );
    },
  );

  it("strips a multi-char trailing punctuation run", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target.,;:\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips backticks and a multi-char trailing punctuation run", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`methods plausibly reach target\`,;\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips interleaved bold + backticks + a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** **\`methods plausibly reach target\`**.\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips backticks-outside-bold nested decoration (`**value**`)", () => {
    // The motivating regression named by the intent annotation at
    // flow-step3-route.ts L194: backticks OUTSIDE bold. The loop's
    // per-pass branch checks `**` before backtick, so this ordering
    // routes through a different code path than `**`...`**`.
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`**methods plausibly reach target**\`\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("strips backticks-outside-bold nested decoration plus a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`**methods plausibly reach target**\`.\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("does NOT strip a trailing word (trailing word is a paraphrase, not decoration)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target eventually\n`;
    expect(extractRecommendedPath(plan)).toBe(
      "methods plausibly reach target eventually",
    );
  });

  it("ignores a level-3 (###) Prompt-Interpretation heading", () => {
    // discovery-instructions.md specifies a top-level ## heading;
    // level-3 is intentionally not recognised.
    const plan = `### Prompt interpretation\n\n- **Recommended path:** extend scope with named additional safe steps\n`;
    expect(extractRecommendedPath(plan)).toBeNull();
  });

  it("uses the first ## Prompt interpretation section when multiple appear", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target\n\n# Something else\n\n## Prompt interpretation\n\n- **Recommended path:** relax target\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  it("does not bleed into the next ## section when extracting the value", () => {
    const plan = `## Prompt interpretation\n\n- **Reading of prescribed methods:** exhaustive\n- **Plausibility estimate:** Yes.\n- **Recommended path:** methods plausibly reach target\n\n## User-Facing Changes\n\n- **Recommended path:** SHOULD-NOT-BE-PICKED-UP\n`;
    expect(extractRecommendedPath(plan)).toBe("methods plausibly reach target");
  });

  describe("drifted bold-period/next-line label shape", () => {
    it.each([
      "methods plausibly reach target",
      "extend scope with named additional safe steps",
      "relax target",
      "split into multiple pipelines",
    ])(
      "extracts '%s' from a `- **Recommended path.**` label with the value on the next line",
      (enumValue) => {
        const plan = `## Prompt interpretation\n\n- **Recommended path.**\n${enumValue}\n`;
        expect(extractRecommendedPath(plan)).toBe(enumValue);
      },
    );

    it("skips a blank line between the drifted label and the value", () => {
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\n\n   relax target\n`;
      expect(extractRecommendedPath(plan)).toBe("relax target");
    });

    it("flows the drifted value through the decoration-stripping loop", () => {
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\n\`methods plausibly reach target\`.\n`;
      expect(extractRecommendedPath(plan)).toBe(
        "methods plausibly reach target",
      );
    });

    it("does NOT bleed past the section boundary when the drifted label has no in-section value", () => {
      // Drifted label is the last line of the section; the only following
      // non-blank line lives in the NEXT ## section and must NOT be read.
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\n\n## User-Facing Changes\n\nSHOULD-NOT-BE-PICKED-UP\n`;
      expect(extractRecommendedPath(plan)).toBeNull();
    });

    it("colon-form takes precedence over sibling bullets when both forms are present", () => {
      // Sibling bullets precede the (colon-form) Recommended-path bullet and
      // carry their value on-line; the drifted next-line reader must not
      // pick a sibling bullet up. Colon-form takes precedence here, so the
      // drift branch never runs.
      const plan = `## Prompt interpretation\n\n- **Reading of prescribed methods:** exhaustive\n- **Plausibility estimate:** Yes.\n- **Recommended path:** relax target\n`;
      expect(extractRecommendedPath(plan)).toBe("relax target");
    });

    it("does NOT mis-read a sibling bullet as the drifted value (pure period-form, no colon-form present)", () => {
      // Bare period-form label with NO colon-form line anywhere, so the drift
      // branch DOES run: the next non-blank line is a sibling bullet, which
      // the next-line reader picks up verbatim (it is the genuine next line).
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\n- relax target\n`;
      expect(extractRecommendedPath(plan)).toBe("- relax target");
    });
  });
});

describe("Tension matrix — case-sensitivity and substring guards", () => {
  it("treats case variants as tension (case-sensitive exact match against the canonical enum)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** Methods plausibly reach target\n`;
    // "Methods" (capital M) != "methods" — silent-passthrough guard.
    expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
  });

  it("treats substring variants as tension ('eventually' suffix should NOT silent-passthrough)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target eventually\n`;
    expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
  });

  it("treats prefix variants as tension ('roughly methods plausibly reach target')", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** roughly methods plausibly reach target\n`;
    expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
  });

  it("advances to step 5 when the value carries surrounding backticks + a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** \`methods plausibly reach target\`.\n`;
    expect(decideStep3Route("bug", plan)).toBe("advance-to-step-5");
  });

  it("advances to step 5 when the bare value carries only a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target.\n`;
    expect(decideStep3Route("bug", plan)).toBe("advance-to-step-5");
  });

  it("advances to step 5 when the value carries bold + backticks + a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** **\`methods plausibly reach target\`**.\n`;
    expect(decideStep3Route("bug", plan)).toBe("advance-to-step-5");
  });

  it("routes to step 4 for a trailing word ('eventually' is a paraphrase, not punctuation)", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** methods plausibly reach target eventually\n`;
    expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
  });

  it("routes to step 4 for a case variant even with a trailing period", () => {
    const plan = `## Prompt interpretation\n\n- **Recommended path:** Methods plausibly reach target.\n`;
    expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
  });

  describe("drifted bold-period/next-line label shape (the live bug)", () => {
    it("routes a non-feature intent to step 4 for a drifted 'relax target' (fails safe)", () => {
      // The exact live failure: a drifted bold-period label routed runs
      // the wrong way (advance-to-step-5) before the parser learned the
      // second shape. With the fix it fails safe to the approval checkpoint.
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\nrelax target\n`;
      expect(decideStep3Route("bug", plan)).toBe("route-to-step-4");
    });

    it("advances a non-feature intent to step 5 for a drifted 'methods plausibly reach target' (no over-trigger)", () => {
      const plan = `## Prompt interpretation\n\n- **Recommended path.**\nmethods plausibly reach target\n`;
      expect(decideStep3Route("bug", plan)).toBe("advance-to-step-5");
    });
  });
});

describe(parseArgs, () => {
  it("rejects missing --intent", () => {
    const r = parseArgs(["--plan-md-file", "/tmp/x"]);
    expect("error" in r && r.error).toContain(
      "missing required flag: --intent",
    );
  });

  it("rejects missing --plan-md-file", () => {
    const r = parseArgs(["--intent", "bug"]);
    expect("error" in r && r.error).toContain(
      "missing required flag: --plan-md-file",
    );
  });

  it("rejects unknown intent value, listing allowed intents", () => {
    const r = parseArgs(["--intent", "wat", "--plan-md-file", "/tmp/x"]);
    expect("error" in r && r.error).toContain("unknown --intent 'wat'");
    expect("error" in r && r.error).toContain("allowed:");
    expect("error" in r && r.error).toContain("feature");
  });

  it("rejects --intent without a value", () => {
    const r = parseArgs(["--intent"]);
    expect("error" in r && r.error).toBe("--intent requires a value");
  });

  it("rejects --plan-md-file without a value", () => {
    const r = parseArgs(["--intent", "bug", "--plan-md-file"]);
    expect("error" in r && r.error).toBe("--plan-md-file requires a value");
  });

  it("rejects --intent when followed by another flag (next-arg-is-flag)", () => {
    const r = parseArgs(["--intent", "--plan-md-file", "/tmp/x"]);
    expect("error" in r && r.error).toBe("--intent requires a value");
  });

  it("rejects unknown flags", () => {
    const r = parseArgs([
      "--intent",
      "bug",
      "--plan-md-file",
      "/tmp/x",
      "--bogus",
    ]);
    expect("error" in r && r.error).toBe("unknown flag: --bogus");
  });

  it.each(ALLOWED_INTENTS.map((i) => [i] as const))(
    "accepts canonical intent '%s'",
    (intent) => {
      const r = parseArgs(["--intent", intent, "--plan-md-file", "/tmp/x"]);
      expect("error" in r).toBe(false);
    },
  );

  it("accepts the valueless --method-resolved flag and threads it through", () => {
    const r = parseArgs([
      "--intent",
      "bug",
      "--plan-md-file",
      "/tmp/x",
      "--method-resolved",
    ]);
    expect(r).toMatchObject({ methodResolved: true });
  });

  it("defaults methodResolved to false when the flag is absent", () => {
    const r = parseArgs(["--intent", "bug", "--plan-md-file", "/tmp/x"]);
    expect(r).toMatchObject({ methodResolved: false });
  });

  it("still rejects unknown flags with --method-resolved present", () => {
    const r = parseArgs([
      "--intent",
      "bug",
      "--plan-md-file",
      "/tmp/x",
      "--method-resolved",
      "--bogus",
    ]);
    expect("error" in r && r.error).toBe("unknown flag: --bogus");
  });
});

describe(run, () => {
  it("writes 'advance-to-step-5' for non-feature intent + no section", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "flow-step3-route-"));
    const planFile = path.join(tmpDir, "plan.md");
    writeFileSync(planFile, PLAN_WITHOUT_SECTION);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      const rc = run(["--intent", "refactor", "--plan-md-file", planFile]);
      expect(rc).toBe(0);
      expect(stdout.join("")).toBe("advance-to-step-5\n");
      expect(stderr.join("")).toBe("");
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });

  it("writes 'route-to-step-4' for non-feature intent + tension section", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "flow-step3-route-"));
    const planFile = path.join(tmpDir, "plan.md");
    writeFileSync(planFile, PLAN_EXTEND_SCOPE);

    const stdout: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;

    try {
      const rc = run(["--intent", "bug", "--plan-md-file", planFile]);
      expect(rc).toBe(0);
      expect(stdout.join("")).toBe("route-to-step-4\n");
    } finally {
      process.stdout.write = origStdoutWrite;
    }
  });

  it("writes 'pause-for-method' for a converge-against verdict with no --method-resolved", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "flow-step3-route-"));
    const planFile = path.join(tmpDir, "plan.md");
    writeFileSync(planFile, PLAN_VERDICT_CONVERGE_AGAINST);

    const stdout: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;

    try {
      const rc = run(["--intent", "bug", "--plan-md-file", planFile]);
      expect(rc).toBe(0);
      expect(stdout.join("")).toBe("pause-for-method\n");
    } finally {
      process.stdout.write = origStdoutWrite;
    }
  });

  it("--method-resolved threads through to resolve the converge-against pause", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "flow-step3-route-"));
    const planFile = path.join(tmpDir, "plan.md");
    writeFileSync(planFile, PLAN_VERDICT_CONVERGE_AGAINST);

    const stdout: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;

    try {
      const rc = run([
        "--intent",
        "bug",
        "--plan-md-file",
        planFile,
        "--method-resolved",
      ]);
      expect(rc).toBe(0);
      expect(stdout.join("")).toBe("advance-to-step-5\n");
    } finally {
      process.stdout.write = origStdoutWrite;
    }
  });

  it("exits 2 with usage on missing flag", () => {
    const stderr: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      const rc = run(["--intent", "bug"]);
      expect(rc).toBe(2);
      expect(stderr.join("")).toContain(
        "missing required flag: --plan-md-file",
      );
      expect(stderr.join("")).toContain("usage:");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("exits 2 when plan file cannot be read", () => {
    const stderr: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;

    try {
      const rc = run([
        "--intent",
        "bug",
        "--plan-md-file",
        "/nonexistent/path/plan.md",
      ]);
      expect(rc).toBe(2);
      expect(stderr.join("")).toContain("failed to read --plan-md-file");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });
});
