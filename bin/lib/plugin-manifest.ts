/**
 * Pure, side-effect-free `.claude-plugin/plugin.json` emitter for a flow
 * module. No `fs`, no `process`, no imports beyond `./modules` — the caller
 * (`plugin-root.ts`'s materialization, the maintainer-only probe/lint
 * harnesses) owns every write.
 */

import { MODULES, isKnownModule, type ModuleId } from "./modules";

/**
 * `flow-module-<id>`, not `flow-<id>`: a plugin literally named
 * `flow-research` would collide with the REAL `flow-research` skill
 * directory living in the same skills-home namespace
 * (`skills/universal/flow-research`) — the concrete collision the
 * `plugin-manifest.test.ts` regression guard below checks for.
 */
export const PLUGIN_ROOT_PREFIX = "flow-module-";

export const PLUGIN_SCHEMA_URL =
  "https://anthropic.com/claude-code/plugin.schema.json";

export type PluginManifest = {
  $schema: string;
  name: string;
  version: string;
  description: string;
  author: { name: string };
  skills?: string[];
};

export function pluginRootName(id: ModuleId): string {
  return `${PLUGIN_ROOT_PREFIX}${id}`;
}

/** Inverse of `pluginRootName`. `undefined` when the prefix is absent or the
 * suffix isn't a known `moduleIds()` value. */
export function moduleIdFromPluginRootName(name: string): ModuleId | undefined {
  if (!name.startsWith(PLUGIN_ROOT_PREFIX)) return undefined;
  const candidate = name.slice(PLUGIN_ROOT_PREFIX.length);
  return isKnownModule(candidate) ? candidate : undefined;
}

export function pluginManifestFor(
  id: ModuleId,
  opts: { version: string; includeSkills: boolean },
): PluginManifest {
  // MODULES covers every ModuleId by construction (moduleIds() derives from
  // it), so a matching row always exists for a well-typed `id`.
  const row = MODULES.find((m) => m.id === id)!;
  const manifest: PluginManifest = {
    $schema: PLUGIN_SCHEMA_URL,
    name: pluginRootName(id),
    version: opts.version,
    description: row.description,
    // CONTRACT CORRECTION vs plan Task 2, verified live on Claude Code
    // 2.1.223: the plan mandated a scaffolder-byte-identical field set (no
    // `author`) AND a `claude plugin validate --strict` gate — those are
    // incompatible. The scaffolder's own output fails --strict with
    // `author: No author information provided` (--strict treats warnings
    // as errors). Adding the RECOGNIZED `author` field passes --strict
    // cleanly and, unlike an unrecognized field, does not weaken the Task
    // 6 drift lint.
    author: { name: "flow" },
  };
  // `skills` is omitted entirely (not `skills: undefined`) when
  // includeSkills is false — only assigning the key when true keeps it out
  // of both the object and its JSON.stringify output.
  if (opts.includeSkills) manifest.skills = ["./skills"];
  return manifest;
}
