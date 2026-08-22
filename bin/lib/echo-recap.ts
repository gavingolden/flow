/**
 * Pure renderer for the gate-stage "echo-this" recap block.
 *
 * Both `flow-pipeline-summary` (post-review gates) and `flow-gate-summary`
 * (AWAITING APPROVAL only) feed it ALREADY-DERIVED scalars — it never reads
 * files. The supervisor copies the returned block verbatim into its assistant
 * prose so the two click targets (PR URL, absolute plan-file path) survive
 * Claude Code's truncation of Bash tool results.
 *
 * The block is bounded by an HTML-comment marker pair so the supervisor can
 * grep/sed it out reliably; the markers are invisible in rendered markdown and
 * sit at the TOP of stdout, far from the byte-exact final-line sentinel.
 *
 * Discipline mirrored from `pipeline-summary-sources.ts`: an absent scalar
 * renders the literal `none` (never a fabricated value). The PR-URL and
 * plan-file bullets carry NO trailing punctuation — terminals greedily extend
 * URL auto-detection through adjacent punctuation and break the click target.
 * The field-bearing bullets (branch, phase, verdicts, counts) are not click
 * targets and may carry normal punctuation.
 */

export const ECHO_RECAP_START = "<!-- flow-echo-recap:start -->";
export const ECHO_RECAP_END = "<!-- flow-echo-recap:end -->";

const NONE = "none";

export type EchoRecapInputs = {
  prUrl?: string;
  planFile?: string;
  branch?: string;
  prNumber?: string;
  prTitle?: string;
  phase?: string;
  ciVerdict?: string;
  reviewVerdict?: string;
  findingCount?: number;
  followupCount?: number;
  /**
   * When true, a row whose entire value is `none` is omitted rather than
   * printed — used ONLY at `awaiting-approval` under the `pm` lens, where
   * eight always-`none` rows carried no decision value (calibration
   * sample 1). Never applied to the gated/merged echo-recap or to
   * `pipeline-summary-sources`' NONE rows — those keep the
   * never-fabricate-always-print-`none` honesty discipline.
   */
  suppressNone?: boolean;
};

function orNone(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : NONE;
}

function countOrNone(value: number | undefined): string {
  return value === undefined ? NONE : String(value);
}

export function renderEchoRecap(inputs: EchoRecapInputs): string {
  // PR URL + plan-file: click targets, so NO trailing punctuation.
  const branchIsNone =
    (!inputs.branch || !inputs.branch.trim()) &&
    (!inputs.prNumber || !inputs.prNumber.trim());
  const branchBullet =
    inputs.prNumber !== undefined && inputs.prNumber.trim()
      ? `branch: ${orNone(inputs.branch)} (PR #${inputs.prNumber.trim()})`
      : `branch: ${orNone(inputs.branch)} (PR #${NONE})`;
  const reviewIsNone =
    (!inputs.reviewVerdict || !inputs.reviewVerdict.trim()) &&
    inputs.findingCount === undefined;

  const rows: { text: string; isNone: boolean }[] = [
    {
      text: `- PR URL: ${orNone(inputs.prUrl)}`,
      isNone: !inputs.prUrl?.trim(),
    },
    {
      text: `- Plan file: ${orNone(inputs.planFile)}`,
      isNone: !inputs.planFile?.trim(),
    },
    { text: `- ${branchBullet}`, isNone: branchIsNone },
    {
      text: `- PR title: ${orNone(inputs.prTitle)}`,
      isNone: !inputs.prTitle?.trim(),
    },
    { text: `- Phase: ${orNone(inputs.phase)}`, isNone: !inputs.phase?.trim() },
    {
      text: `- CI: ${orNone(inputs.ciVerdict)}`,
      isNone: !inputs.ciVerdict?.trim(),
    },
    {
      text: `- Review: ${orNone(inputs.reviewVerdict)} (${countOrNone(inputs.findingCount)} findings)`,
      isNone: reviewIsNone,
    },
    {
      text: `- Follow-ups: ${countOrNone(inputs.followupCount)}`,
      isNone: inputs.followupCount === undefined,
    },
  ];

  const body = inputs.suppressNone ? rows.filter((r) => !r.isNone) : rows;
  const lines = [ECHO_RECAP_START, ...body.map((r) => r.text), ECHO_RECAP_END];
  return lines.join("\n");
}
