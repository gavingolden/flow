/**
 * Shared decode/validate/project/classify core for agy-delegated review
 * lenses. The Gemini cross-model lens (`bin/flow-gemini-lens.ts`) and the
 * delegated Claude lenses (`bin/flow-agy-lenses.ts`) decode an agy artifact
 * identically — one ladder, one projection, one classification — so a fix to
 * any of them lands on both. Reuses `decodeDelegateArtifact` and the
 * `agent-finding-schema` validators; never forks them.
 */

import {
  VALID_DECORATIONS,
  VALID_LABELS,
  classifyLensNegatives,
  collectLensNegatives,
  normalizeParsedFindings,
  validateAgentFindings,
  type AgentFindings,
} from "./agent-finding-schema";
import {
  decodeDelegateArtifact,
  unwrapAgyEnvelope,
  type DecodeVia,
} from "./structured-response";

// Wire-level `--json-schema` contract for the agy call. Every property
// carries a `description` (load-bearing — a description-less schema was
// observed to produce degenerate output in probing). `reasoning` is a
// LEADING scratchpad-only field, never projected into the finalized
// `{findings}` file. `decoration` is deliberately NOT in `required` on each
// finding — `validateFinding` allows a `praise` finding to omit it. The
// `label` / `decoration` enums are built FROM the imported
// `VALID_LABELS` / `VALID_DECORATIONS` sets so the schema cannot drift from
// the validator.
export const AGENT_FINDINGS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "reasoning",
    "findings",
    "rejected_alternatives",
    "anti_patterns_found",
  ],
  properties: {
    reasoning: {
      type: "string",
      description:
        "Use this exclusively for scratchpad reasoning; every finding you want reported must go in the findings array, never here.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "line", "label", "confidence", "subject", "body"],
        properties: {
          file: { type: "string", description: "The changed file path." },
          line: { type: "number", description: "The primary line number." },
          end_line: {
            type: "number",
            description: "Optional end line for a multi-line span.",
          },
          label: {
            type: "string",
            enum: Array.from(VALID_LABELS),
            description: "The conventional-comments label for this finding.",
          },
          decoration: {
            type: "string",
            enum: Array.from(VALID_DECORATIONS),
            description:
              "The bare decoration keyword. Omit (or set null) for a praise finding; every other label requires one.",
          },
          confidence: {
            type: "number",
            description:
              "0-100. Only emit findings you are >= 80% confident are real.",
          },
          subject: {
            type: "string",
            description: "A short description of the finding.",
          },
          body: {
            type: "string",
            description:
              "Detailed explanation in conventional-comments format with a concrete fix.",
          },
        },
      },
      description: "The reviewer's findings, one entry per issue/praise/etc.",
    },
    rejected_alternatives: {
      type: "array",
      items: {
        type: "object",
        required: ["considered_approach", "why_rejected"],
        properties: {
          considered_approach: {
            type: "string",
            description:
              "An approach you considered while reviewing a hunk of the reviewed code.",
          },
          why_rejected: {
            type: "string",
            description:
              "Why the code as written is preferable to the considered approach.",
          },
        },
      },
      description:
        "Code-scoped claims about approaches you considered and rejected while reviewing. A genuine none is the empty array; do not omit this key.",
    },
    anti_patterns_found: {
      type: "array",
      items: {
        type: "object",
        required: ["location", "pattern", "recommendation"],
        properties: {
          location: {
            type: "string",
            description:
              "The file:line of the off-pattern in the reviewed code.",
          },
          pattern: {
            type: "string",
            description:
              "The off-pattern observed — not itself a findings entry.",
          },
          recommendation: {
            type: "string",
            description: "What the next person touching this code should do.",
          },
        },
      },
      description:
        "Code-scoped off-patterns you noticed but didn't surface as a findings entry. A genuine none is the empty array; do not omit this key.",
    },
  },
};

export function decodeLensArtifact(
  raw: string,
): { ok: true; value: AgentFindings; via: DecodeVia } | { ok: false } {
  // Normalization applies to EVERY rung, including structured_output —
  // this is what lets a model's off-enum label still land through the
  // ladder, not just through the prose-parse rungs.
  return decodeDelegateArtifact(raw, (candidate) =>
    validateAgentFindings(normalizeParsedFindings(candidate)),
  );
}

// MANDATORY, not cosmetic: validateAgentFindings tolerates extra top-level
// keys and returns the input unmodified, so writing the decoded value
// directly would leak a schema-supplied `reasoning` key into the artifact and
// hand the consolidator a non-{findings, rejected_alternatives,
// anti_patterns_found} object. Re-project to exactly those three keys. The
// two negative arrays route through the TOLERANT collectLensNegatives — a
// wire-schema violation on one malformed negative entry must never sink the
// whole review.
export function projectLensFindings(value: AgentFindings): {
  findings: unknown;
  rejected_alternatives?: unknown;
  anti_patterns_found?: unknown;
} {
  const negatives = collectLensNegatives(value);
  const state = classifyLensNegatives(value);
  const finalized: {
    findings: unknown;
    rejected_alternatives?: unknown;
    anti_patterns_found?: unknown;
  } = { findings: value.findings };
  // Preserve genuine absence rather than laundering it into `[]`: the wire
  // schema REQUIRES both keys from agy, but the value may still come from a
  // salvage rung that never enforced that requirement. Only write the key
  // when the source actually carried an array (populated or empty), so the
  // consolidator's `classifyLensNegatives` can still tell "lens omitted this"
  // from "lens explicitly reported none".
  if (state.rejected_alternatives !== "absent") {
    finalized.rejected_alternatives = negatives.rejected_alternatives;
  }
  if (state.anti_patterns_found !== "absent") {
    finalized.anti_patterns_found = negatives.anti_patterns_found;
  }
  return finalized;
}

// Self-diagnosing classification for a dispatched-but-unusable run: a denied
// tool call (checked FIRST) or a thinking-token-dominated empty response,
// falling back to the generic unparseable reason when neither signal is
// present.
export function classifyUnusableLensRun(
  raw: string,
  env: { deniedActions?: string[]; usage?: Record<string, number> },
): "tools-denied" | "token-exhausted" | "output-unparseable" {
  if (env.deniedActions && env.deniedActions.length > 0) {
    return "tools-denied";
  }
  const usage = env.usage;
  const { text } = unwrapAgyEnvelope(raw);
  if (
    text.trim() === "" &&
    usage &&
    typeof usage.thinking_tokens === "number" &&
    typeof usage.output_tokens === "number" &&
    usage.output_tokens > 0 &&
    usage.thinking_tokens >= usage.output_tokens * 0.9
  ) {
    return "token-exhausted";
  }
  return "output-unparseable";
}
