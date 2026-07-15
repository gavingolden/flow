/**
 * Tolerant boundary reader + read-modify-write writer for
 * `~/.flow/config.json`'s `modules` array — the persisted module selection
 * `flow install` records so `--upgrade` never re-asks — plus the
 * install-time selection resolver (`resolveModuleSelection`) that composes
 * the reader with the CLI flag and the interactive Q&A seam.
 *
 * The reader discipline mirrors `models-config.ts`: an injectable
 * `ReadConfigFile` seam, absent ≡ `undefined`, and a `catch` collapsing any
 * unreadable/malformed file to `undefined` so a boundary read never throws.
 * Unlike `models-config.ts` / `copilot-config.ts` / `epic-config.ts` — which
 * are pure readers — `modules` also needs a WRITER (no existing
 * `config.json` writer exists in `bin/lib`), so this module additionally
 * implements a read-modify-write that preserves every sibling top-level key
 * (`models`, `research`, `bots`, `source`, `update`, …) untouched. The write
 * shape (`JSON.stringify(obj, null, 2) + "\n"`) matches `update-check.ts`'s
 * `writeCache` / `manifest.ts`'s `writeManifest` convention.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { flowConfigPath } from "./paths";
import {
  MANDATORY_MODULE,
  MODULES,
  isKnownModule,
  moduleForArtifactName,
  type ModuleId,
} from "./modules";
import type { Manifest } from "./manifest";

/**
 * Reads and JSON-parses the config file at `configPath`. Returns `undefined`
 * on any failure (absent file, unreadable, non-JSON) — never throws.
 */
export function readConfigFileAt(configPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the
 * file is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never read.
 */
export type ReadConfigFile = () => unknown;

export const defaultReadConfigFile: ReadConfigFile = () =>
  readConfigFileAt(flowConfigPath());

function extractModules(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>).modules;
}

function stringArray(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.filter((e): e is string => typeof e === "string");
  return out.length === x.length ? out : undefined;
}

/**
 * The persisted module selection when `modules` is a well-formed string
 * array, filtered to known ids only (unknown ids are dropped tolerantly —
 * see `collectModuleConfigWarnings` for the paired warning). `undefined`
 * means "unset" (absent, unreadable, or the wrong type) — the caller's
 * resolution precedence then falls through to the next source. A
 * present-and-valid-but-empty array (every optional module declined) is a
 * real recorded selection, not "unset". Never throws.
 */
export function readModuleSelection(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] | undefined {
  const arr = stringArray(extractModules(read()));
  if (arr === undefined) return undefined;
  return arr.filter((id) => isKnownModule(id));
}

/**
 * Best-effort, non-fatal warnings for a malformed `modules` config value:
 * wrong type (not a string array) or a stored id that isn't in the current
 * `MODULES` table (a renamed/removed module, or a typo). Callers print these
 * to stderr and fall back to the flag/prompt resolution path. Never throws;
 * an unreadable/absent config yields an empty list.
 */
export function collectModuleConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  const raw = extractModules(read());
  if (raw === undefined) return [];
  const arr = stringArray(raw);
  if (arr === undefined) {
    return [
      `modules: expected an array of module-id strings, got ${JSON.stringify(raw)}; ignoring.`,
    ];
  }
  return arr
    .filter((id) => !isKnownModule(id))
    .map((id) => `modules: '${id}' is not a known module id; dropping.`);
}

/**
 * Read-modify-write: sets `modules` to `ids` while preserving every sibling
 * top-level key byte-for-byte. Reads the SAME file it writes back to (via
 * `configPath`, or an injected `read` override for simulating unreadable
 * content without touching disk) — a mismatch between the two would silently
 * clobber sibling keys from a different file than the one being written.
 * Creates the parent directory if absent.
 */
export function writeModuleSelection(
  ids: readonly string[],
  options: { configPath?: string; read?: ReadConfigFile } = {},
): void {
  const configPath = options.configPath ?? flowConfigPath();
  const raw = options.read ? options.read() : readConfigFileAt(configPath);
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const next = { ...obj, modules: [...ids] };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
}

export type ModuleSelectionSource =
  | "flag"
  | "config"
  | "manifest"
  | "prompt"
  | "default";

/**
 * The module selection implied by a previously-installed set: the union of
 * the modules owning each recorded symlink, with `MANDATORY_MODULE` folded
 * in. Maps `path.basename(record.target)` — a skill dir name, an
 * `agents/*.md` basename, an extensionless helper name, or a validator
 * invocation name — through `moduleForArtifactName`. Records that map to no
 * module (the `flow` wrapper, shell completions, or a registry-unknown
 * artifact) contribute nothing. Used by `resolveEntriesForRun` to preserve an
 * existing install's breadth when nothing is recorded (gh#435): a
 * non-interactive `--upgrade` with a populated manifest must not collapse to
 * core-only.
 */
export function deriveSelectionFromManifest(manifest: Manifest): ModuleId[] {
  const ids = new Set<ModuleId>([MANDATORY_MODULE]);
  for (const record of manifest.symlinks) {
    const mod = moduleForArtifactName(path.basename(record.target));
    if (mod !== undefined) ids.add(mod);
  }
  return [...ids];
}

export type ModuleSelectionResult = {
  ids: string[];
  source: ModuleSelectionSource;
  /**
   * Whether the caller should persist this selection to config.json. True
   * for an explicit flag or a completed interactive Q&A (both record real
   * user intent); false for a replayed recorded selection (already
   * persisted) or the non-TTY default (no intent was expressed).
   */
  shouldPersist: boolean;
};

function withCore(ids: readonly string[]): string[] {
  return Array.from(new Set<string>([MANDATORY_MODULE, ...ids]));
}

/**
 * The install-time module-selection resolver. Precedence, exactly:
 *   1. `flagIds` (an explicit `--modules`/`--core-only` selection) — wins.
 *   2. A recorded `~/.flow/config.json` `modules` selection — `--upgrade`
 *      (or any re-install) honors this with zero `confirm` calls.
 *   3. `manifestIds` (the breadth derived from a populated install manifest
 *      when nothing is recorded) — preserves an existing install's breadth
 *      instead of collapsing to core (gh#435). Does NOT persist: it re-derives
 *      each run, mirroring the "persist only expressed intent" rule.
 *   4. Interactive TTY: prompt once per OPTIONAL module (every row in
 *      `MODULES` except `MANDATORY_MODULE`) via the injected `confirm` seam.
 *   5. Non-interactive, nothing recorded and no manifest: default to
 *      `[MANDATORY_MODULE]` and do NOT persist — no user intent was expressed.
 *
 * `--all` is deliberately NOT resolved here — the `--all` path bypasses
 * this resolver entirely and calls `discoverAll` directly (see `setup.ts`),
 * so `--all`'s byte-parity with the pre-module-registry unconditional
 * install holds by construction, independent of this resolver's logic.
 */
export function resolveModuleSelection(options: {
  flagIds?: string[];
  manifestIds?: string[];
  isTTY: boolean;
  confirm: (prompt: string) => boolean;
  read?: ReadConfigFile;
}): ModuleSelectionResult {
  if (options.flagIds !== undefined) {
    return {
      ids: withCore(options.flagIds),
      source: "flag",
      shouldPersist: true,
    };
  }

  const recorded = readModuleSelection(options.read);
  if (recorded !== undefined) {
    return { ids: withCore(recorded), source: "config", shouldPersist: false };
  }

  // Preserve an existing install's breadth (gh#435): nothing recorded but the
  // manifest shows a broader-than-core install. Non-persisting — expressed
  // intent (a flag or a completed Q&A) is the only thing we record.
  if (options.manifestIds !== undefined && options.manifestIds.length > 0) {
    return {
      ids: withCore(options.manifestIds),
      source: "manifest",
      shouldPersist: false,
    };
  }

  if (options.isTTY) {
    const ids: ModuleId[] = [MANDATORY_MODULE];
    for (const m of MODULES) {
      if (m.id === MANDATORY_MODULE) continue;
      if (options.confirm(`Install ${m.id} — ${m.description}`)) {
        ids.push(m.id);
      }
    }
    return { ids, source: "prompt", shouldPersist: true };
  }

  return { ids: [MANDATORY_MODULE], source: "default", shouldPersist: false };
}
