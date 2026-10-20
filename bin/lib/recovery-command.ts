import type { PipelineKind } from "./state";

/**
 * The one-command restart line for a pipeline of the given kind. Shared by
 * the `SessionStart:clear` hook's advisories, `flow ls`'s orphan footer, and
 * `flow-checkpoint`'s awaiting-human warning so no surface names
 * `flow feature resume` for an epic window. Exhaustive `switch`, no
 * `default` — a future kind fails typecheck here rather than silently
 * naming the feature command.
 */
export function recoveryCommandFor(slug: string, kind: PipelineKind): string {
  switch (kind) {
    case "epic-design":
      return `flow epic create --resume ${slug}`;
    case "epic-run":
      return `flow epic run ${slug}`;
    case "feature":
      return `flow feature resume ${slug}`;
  }
}
