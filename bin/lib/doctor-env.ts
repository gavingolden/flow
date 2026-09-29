/**
 * `flow doctor` shell checks: a leaked pipeline identity and the install
 * bin directory on PATH. Read-only.
 */

import type { DoctorCheck, DoctorDeps } from "./doctor";
import { pathContains } from "./path-probe";
import { resolveSlugFromEnv } from "./session-identity";
import { isValidSlug } from "./slug";
import { readState, WORKTREE_REMOVED_PHASE_SET } from "./state";

const UNSET_FIX = "unset FLOW_SLUG FLOW_PIPELINE";

export function checkFlowSlug(deps: DoctorDeps): DoctorCheck[] {
  const base = {
    id: "shell-flow-slug",
    section: "shell" as const,
    title: "Shell pipeline identity",
  };
  const raw = deps.env.FLOW_SLUG;
  if (raw === undefined || raw === "") {
    return [
      {
        ...base,
        status: "pass",
        summary: "FLOW_SLUG is not set",
        details: [],
      },
    ];
  }
  const stale = (summary: string): DoctorCheck[] => [
    {
      ...base,
      status: "fail",
      summary,
      details: [
        "a nested session in this shell could overwrite another pipeline's state",
      ],
      fix: UNSET_FIX,
    },
  ];
  const slug = isValidSlug(raw) ? resolveSlugFromEnv(deps.env) : null;
  if (slug === null) return stale("FLOW_SLUG is set to a malformed value");
  const state = readState(slug, deps.stateDir);
  if (state === null) {
    return stale(`FLOW_SLUG names ${slug}, which has no readable state file`);
  }
  if (WORKTREE_REMOVED_PHASE_SET.has(state.phase)) {
    return stale(`FLOW_SLUG names ${slug}, a pipeline already ${state.phase}`);
  }
  return [
    {
      ...base,
      status: "warn",
      summary: `this shell belongs to pipeline ${slug}`,
      details: [
        "expected inside that pipeline's own window; anywhere else, a nested session could overwrite its state",
      ],
      fix: UNSET_FIX,
    },
  ];
}

export function checkBinDirOnPath(deps: DoctorDeps): DoctorCheck[] {
  const base = {
    id: "shell-path",
    section: "shell" as const,
    title: "PATH",
  };
  const binDir = deps.targets.binDir;
  if (pathContains(binDir, deps.env.PATH ?? "")) {
    return [
      {
        ...base,
        status: "pass",
        summary: `${binDir} is on PATH`,
        details: [],
      },
    ];
  }
  return [
    {
      ...base,
      status: "fail",
      summary: `${binDir} is not on PATH, so flow and its helpers are not found`,
      details: [
        `when flow itself is not found, run: bun <flow checkout>/bin/flow doctor (your checkout is at ${deps.installRoot})`,
      ],
      fix: 'export PATH="$HOME/.local/bin:$PATH" (add it to your shell rc)',
    },
  ];
}
