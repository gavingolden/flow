/**
 * The v1 module registry: a typed, pure-data partition of every skill,
 * agent, PATH-bound helper, and validator into exactly one module. `core`
 * is mandatory and is always folded into a selection (see
 * `resolveArtifactSet`); every other module is opt-in. This is the seam
 * artifact `docs/target-architecture.md`'s `## Module map` describes — rows
 * encode the `flow-`-prefixed skill directory names (post-`p2-flow-prefix-rename`),
 * current `agents/*.md` basenames, current PATH-bound helper extensionless
 * basenames, and validator invocation names (`flow-<name>`), so a row value
 * is directly a `sources.ts` `SourceEntry.displayName`.
 *
 * Three refinements applied here diverge from the doc's map prose — do NOT
 * re-derive rows by transcribing the doc; these are code-verified against
 * the LIVE `sources.ts` discovery functions:
 *   1. `flow-release` is maintainer-only (`sources.ts`'s `MAINTAINER_ONLY`
 *      set) and is never returned by `discoverHelpers`, so it is not a row
 *      in any module here.
 *   2. `epic-manifest-schema.ts` IS in `sources.ts`'s `VALIDATOR_MODULES`
 *      allowlist (PATH-bound as `flow-epic-manifest-schema`), so it is a
 *      4th `core` validator row — omitting it would break `--all`
 *      byte-parity against live discovery.
 *   3. `p2-flow-prefix-rename` materialized the testing split: the generic
 *      `skills/universal/flow-testing` dir is a `core` skill row, and the
 *      Svelte-specific `skills/stacks/flow-testing-svelte` dir is a
 *      `stack-svelte` skill row alongside `flow-svelte`.
 *
 * Pure data + pure functions only. No imports from install-machinery types
 * (`SourceEntry` et al.) and no side effects, so a later distribution re-cut
 * can edit rows here without touching discovery/install logic.
 */

export type ModuleId =
  | "core"
  | "stack-svelte"
  | "stack-tailwind-shadcn"
  | "stack-supabase"
  | "stack-cloudflare-pages"
  | "copilot"
  | "research";

export type ModuleDefinition = {
  id: ModuleId;
  description: string;
  skills: string[];
  agents: string[];
  helpers: string[];
  validators: string[];
};

/** Always folded into a selection, whether or not it's named explicitly — see `resolveArtifactSet`. */
export const MANDATORY_MODULE: ModuleId = "core";

export const MODULES: ModuleDefinition[] = [
  {
    id: "core",
    description:
      "The pipeline supervisor, every skill it loads in-process, worktree/PR/state machinery, and the PATH-bound schema validators. Always installed.",
    skills: [
      "flow-pipeline",
      "flow-product-planning",
      "flow-new-feature",
      "flow-verify",
      "flow-pr-review",
      "flow-coder",
      "flow-epic-create",
      "flow-epic-run",
      "flow-add-worktree",
      "flow-remove-worktree",
      "flow-refactoring",
      "flow-checkpoint",
      "flow-ui-ux",
      "flow-skill-creator",
      "flow-testing",
    ],
    agents: ["flow-fix-applier.md", "flow-verify.md"],
    helpers: [
      "flow-new-worktree",
      "flow-remove-worktree",
      "flow-state-update",
      "flow-rename-window",
      "flow-open-pr",
      "flow-pre-commit",
      "flow-gate-decide",
      "flow-gate-summary",
      "flow-merge-guard",
      "flow-pipeline-summary",
      "flow-resume-decide",
      "flow-stop-guard",
      "flow-classify-step",
      "flow-step3-route",
      "flow-candidate-issues",
      "flow-plan-lint",
      "flow-create-issue",
      "flow-followups",
      "flow-foreclosed-paths",
      "flow-notify",
      "flow-checkpoint",
      "flow-ci-wait",
      "flow-fetch-pr-review",
      "flow-reply-pr-comments",
      "flow-fetch-intent-comments",
      "flow-post-findings",
      "flow-annotate-pr",
      "flow-pr-diff",
      "flow-pr-agent-lens",
      "flow-pr-static-analysis",
      "flow-inject-evidence",
      "flow-ui-validate",
      "flow-design-spec",
      "flow-md-validate",
      "flow-seed-ingested-hook",
      "flow-session-start-hook",
      "flow-epic-dag",
      "flow-epic-resume-decide",
      "flow-epic-judge-context",
      "flow-epic-membership",
      "flow-transcript-audit",
    ],
    validators: [
      "flow-pr-review-result-schema",
      "flow-agent-finding-schema",
      "flow-fix-applier-schema",
      "flow-epic-manifest-schema",
    ],
  },
  {
    id: "stack-svelte",
    description: "Svelte 5 / SvelteKit authoring + review.",
    skills: ["flow-svelte", "flow-testing-svelte"],
    agents: [],
    helpers: [],
    validators: [],
  },
  {
    id: "stack-tailwind-shadcn",
    description: "Tailwind v4 / shadcn-svelte UI.",
    skills: ["flow-tailwind-shadcn"],
    agents: [],
    helpers: [],
    validators: [],
  },
  {
    id: "stack-supabase",
    description: "Project-specific Supabase adapter.",
    skills: ["flow-supabase-project"],
    agents: [],
    helpers: [],
    validators: [],
  },
  {
    id: "stack-cloudflare-pages",
    description: "Cloudflare Pages deploy conventions.",
    skills: ["flow-cloudflare-pages"],
    agents: [],
    helpers: [],
    validators: [],
  },
  {
    id: "copilot",
    description:
      "The GitHub Copilot bot-review integration. Deselecting skips the pipeline's Copilot request/wait path with a named notice.",
    skills: [],
    agents: [],
    helpers: ["flow-request-copilot"],
    validators: [],
  },
  {
    id: "research",
    description:
      "The Google-AI-Ultra (agy) delegation engine, the research helpers built on it, and the two agy-dependent cross-model reviewers.",
    skills: ["flow-research"],
    agents: [],
    helpers: [
      "flow-delegate",
      "flow-delegate-fanout",
      "flow-research-run",
      "flow-research-note",
      "flow-research-cache",
      "flow-plan-review",
      "flow-gemini-lens",
    ],
    validators: [],
  },
];

export function moduleIds(): ModuleId[] {
  return MODULES.map((m) => m.id);
}

export function isKnownModule(id: string): id is ModuleId {
  return MODULES.some((m) => m.id === id);
}

export type ArtifactSet = {
  skills: string[];
  agents: string[];
  helpers: string[];
  validators: string[];
};

/**
 * Union of the selected modules' rows, with `MANDATORY_MODULE` always
 * folded in regardless of whether it's named in `selectedIds`. Each kind is
 * deduplicated — a correct one-artifact-one-module partition makes dedup a
 * no-op, but it's cheap insurance against a future double-assignment
 * silently duplicating a target in the caller's discovery filter.
 */
export function resolveArtifactSet(
  selectedIds: readonly string[],
): ArtifactSet {
  const ids = new Set<string>(selectedIds);
  ids.add(MANDATORY_MODULE);
  const skills = new Set<string>();
  const agents = new Set<string>();
  const helpers = new Set<string>();
  const validators = new Set<string>();
  for (const m of MODULES) {
    if (!ids.has(m.id)) continue;
    for (const s of m.skills) skills.add(s);
    for (const a of m.agents) agents.add(a);
    for (const h of m.helpers) helpers.add(h);
    for (const v of m.validators) validators.add(v);
  }
  return {
    skills: [...skills],
    agents: [...agents],
    helpers: [...helpers],
    validators: [...validators],
  };
}

/**
 * The module owning a given artifact display name, searched across all four
 * kind-arrays (skills/agents/helpers/validators) — display names are unique
 * across categories in practice, so a flat search avoids needing the
 * caller's `SourceEntry.kind` (which conflates helpers and validators under
 * `"bin"`). Returns `undefined` for the always-core residue (the `flow`
 * wrapper, shell completions) — those are never module rows. Used by
 * `setup.ts` to group the linked-artifact summary by module without
 * importing install-machinery types here.
 */
export function moduleForArtifactName(name: string): ModuleId | undefined {
  for (const m of MODULES) {
    if (
      m.skills.includes(name) ||
      m.agents.includes(name) ||
      m.helpers.includes(name) ||
      m.validators.includes(name)
    ) {
      return m.id;
    }
  }
  return undefined;
}
