/**
 * The `scope` verbs of `flow-manager-ctl`: change entries and focus notes in
 * one locked write, show them, and list unfinished pipelines by name only.
 * Output is one JSON object so the manager never parses prose.
 */

import { randomBytes } from "node:crypto";
import { resolveGrant } from "./manager-grants";
import { scopeCandidates } from "./manager-brief";
import { readManagerRecord, writeManagerRecord } from "./manager-record";
import {
  ALLOWED_SCOPE_KINDS,
  formatScope,
  identityForState,
  originsFor,
  parseScope,
  readScope,
  scopeOrigin,
  stateInScope,
  updateScope,
  type FocusNote,
  type ScopeFile,
} from "./manager-scope";
import { FINISHED_PHASE_SET, listStates } from "./state";

export type ScopeFlags = {
  scope: string[];
  focus: string[];
  dropFocus: string[];
  resolved: boolean;
};

export type ScopeDeps = { home?: string; stateDir?: string; now: Date };

function describe(
  file: ScopeFile | null,
  deps: ScopeDeps,
  showPending: boolean,
) {
  const states = listStates(deps.stateDir);
  const inScope = states.filter((s) => stateInScope(s, file));
  return {
    scopes: (file?.scopes ?? []).map((scope) => ({
      scope,
      origin: scopeOrigin(file, scope),
    })),
    focus: file?.focus ?? [],
    pendingResolve: file?.pendingResolve === true,
    ...(showPending && file?.pendingResolve
      ? {
          pendingLaunchWords: (file.focus ?? [])
            .filter((f) => f.from === "launch")
            .map((f) => f.text),
        }
      : {}),
    pipelines: inScope.map((s) => ({
      slug: s.slug,
      phase: s.phase,
      granted:
        !FINISHED_PHASE_SET.has(s.phase) &&
        resolveGrant(identityForState(s), deps.now, deps.home) !== null,
    })),
  };
}

export function scopeWrite(
  op: "set" | "add" | "remove",
  flags: ScopeFlags,
  deps: ScopeDeps,
): { code: number; out: string } {
  for (const raw of flags.scope) {
    if (parseScope(raw) === null) {
      return {
        code: 2,
        out: `invalid scope '${raw}': use ${ALLOWED_SCOPE_KINDS}`,
      };
    }
  }
  const wanted = flags.scope.map((raw) => formatScope(parseScope(raw)!));
  const next = updateScope((cur) => {
    const have = cur?.scopes ?? [];
    const scopes =
      op === "set"
        ? wanted
        : op === "add"
          ? [...new Set([...have, ...wanted])]
          : have.filter((x) => !wanted.includes(x));
    const drop = new Set(flags.dropFocus);
    const added: FocusNote[] = flags.focus.map((text) => ({
      id: `f-${randomBytes(3).toString("hex")}`,
      text,
      at: deps.now.toISOString(),
      from: "owner-words",
    }));
    const focus = [
      ...(cur?.focus ?? []).filter((f) => !drop.has(f.id)),
      ...added,
    ];
    const file: ScopeFile = {
      version: 1,
      scopes,
      updatedAt: deps.now.toISOString(),
      source: "owner-words",
      ...(scopes.length > 0
        ? {
            origins: originsFor(
              cur,
              scopes,
              op === "remove" ? [] : wanted,
              "words",
            ),
          }
        : {}),
      ...(focus.length > 0 ? { focus } : {}),
    };
    if (cur?.pendingResolve && !flags.resolved) file.pendingResolve = true;
    return file;
  }, deps.home);
  return { code: 0, out: JSON.stringify(describe(next, deps, false)) };
}

/** Read-only, except that it stamps `lastSeenAt` on the manager record: the launch's "the skill started" signal. */
export function scopeShow(deps: ScopeDeps): string {
  const rec = readManagerRecord(deps.home);
  if (rec) {
    writeManagerRecord(
      { ...rec, lastSeenAt: deps.now.toISOString() },
      deps.home,
    );
  }
  return JSON.stringify(describe(readScope(deps.home), deps, true));
}

export function scopeCandidateLines(deps: Pick<ScopeDeps, "stateDir">): string {
  return scopeCandidates(listStates(deps.stateDir))
    .map((c) => [c.slug, c.repo, c.epic ?? "-"].join("\t"))
    .join("\n");
}
