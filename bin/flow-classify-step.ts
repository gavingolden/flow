#!/usr/bin/env bun
/**
 * Renders the /pr-review Step 12 "Automation-precedence audit" line.
 *
 * Why: skills/pipeline/pr-review/SKILL.md Step 12 currently asks the LLM
 * to construct the audit line inline from prose. That works until the
 * format spec drifts (or the slug → human-prose mapping does), at which
 * point the line becomes a silent contract violation noticed only by
 * humans skimming reports. This helper pins the format on the wrapper
 * side; bin/flow-classify-step.test.ts pins the format on the helper
 * side; the two together make drift detectable.
 *
 * Usage:
 *   flow-classify-step --ran <n> --total <m> --prose-promoted <x>
 *                      [--reason <slug>]...
 *
 * Each --reason flag appends one rubric category (insertion order
 * preserved); allowed slugs match the five categories in
 * skills/pipeline/pr-review/references/manual-test-rubric.md.
 *
 * Exit codes:
 *   0 — line rendered to stdout
 *   2 — bad CLI args (parse error written to stderr with usage)
 */

export type Reasons = readonly string[];

export type RenderInputs = {
  ran: number;
  total: number;
  prosePromoted: number;
  reasons: Reasons;
};

export const SLUG_TO_HUMAN: Record<string, string> = {
  "subjective-UX": "subjective UX",
  "production-only": "production-only",
  "cross-browser": "cross-browser",
  "performance-under-realistic-load": "performance under realistic load",
  "cost-prohibitive-infra": "cost-prohibitive infra",
};

const ALLOWED_SLUGS = Object.keys(SLUG_TO_HUMAN);

export function render(inputs: RenderInputs): string {
  const { ran, total, prosePromoted, reasons } = inputs;

  if (total === 0) {
    return "Automation-precedence audit: ran 0/0 items (no Test Steps to verify)";
  }

  const left = total - ran;
  if (left === 0) {
    return `Automation-precedence audit: ran ${ran}/${total} items (${prosePromoted} prose-promoted, 0 left manual)`;
  }

  const humanReasons =
    reasons.length === 0
      ? "unspecified"
      : reasons.map((slug) => SLUG_TO_HUMAN[slug]).join(", ");
  return `Automation-precedence audit: ran ${ran}/${total} items (${prosePromoted} prose-promoted, ${left} left manual: ${humanReasons})`;
}

function parseCount(flag: string, raw: string | undefined): number | { error: string } {
  if (raw === undefined) return { error: `${flag} requires a value` };
  if (!/^-?\d+$/.test(raw) || Number(raw) < 0) {
    return { error: `${flag} must be a non-negative integer, got '${raw}'` };
  }
  return Number(raw);
}

export function parseArgs(argv: string[]): RenderInputs | { error: string } {
  let ran: number | undefined;
  let total: number | undefined;
  let prosePromoted: number | undefined;
  const reasons: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--ran":
      case "--total":
      case "--prose-promoted": {
        const parsed = parseCount(flag, argv[i + 1]);
        if (typeof parsed !== "number") return parsed;
        if (flag === "--ran") ran = parsed;
        else if (flag === "--total") total = parsed;
        else prosePromoted = parsed;
        i++;
        continue;
      }
      case "--reason": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: "--reason requires a value" };
        }
        if (!(value in SLUG_TO_HUMAN)) {
          return {
            error: `unknown --reason '${value}'; allowed: ${ALLOWED_SLUGS.join(", ")}`,
          };
        }
        reasons.push(value);
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (ran === undefined) return { error: "missing required flag: --ran" };
  if (total === undefined) return { error: "missing required flag: --total" };
  if (prosePromoted === undefined) return { error: "missing required flag: --prose-promoted" };

  if (ran > total) {
    return { error: `--ran (${ran}) cannot exceed --total (${total})` };
  }
  if (prosePromoted > ran) {
    return { error: `--prose-promoted (${prosePromoted}) cannot exceed --ran (${ran})` };
  }

  return { ran, total, prosePromoted, reasons };
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-classify-step: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-classify-step --ran <n> --total <m> --prose-promoted <x> [--reason <slug>]...\n",
    );
    return 2;
  }
  process.stdout.write(render(parsed) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
