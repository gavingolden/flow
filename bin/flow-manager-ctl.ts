#!/usr/bin/env bun
/**
 * One PATH helper for the global manager session: every manager read and
 * write is a bare call to this. Scope bounds every read — an out-of-scope slug
 * prints `{"ok":false,"reason":"out-of-scope"}` and exits 3 without reading
 * anything else.
 *
 *   brief --slug <s> [--transcript-tail <n>]
 *   digest [--mark-seen]
 *   log --kind manager-decision --slug <s> --reason <text>
 *   proposal add --kind <k> --text <t> [--slug <s>] [--epic <e>] [--repo <r>] [--recommendation <t>]
 *   proposal list | proposal answer <id> --answer <text>
 *   scope set|add|remove [--scope <s>]… [--focus <text>]… [--drop-focus <id>]… [--resolved]
 *   scope show | scope candidates
 *   ack                        the manager has handled the last wake
 *
 * Exit 0 ok, 2 bad arguments, 3 out of scope.
 */

import { randomBytes } from "node:crypto";
import { defaultExec, type ExecFn } from "./lib/epic-manage-observe";
import { buildBrief } from "./lib/manager-brief";
import { digestSince, markSeen, readDigestSeen } from "./lib/manager-digest";
import { appendManagerLog } from "./lib/manager-log";
import {
  addProposal,
  answerProposal,
  readProposals,
  type Proposal,
  type ProposalKind,
} from "./lib/manager-proposals";
import { repoNameForPath, readScope, stateInScope } from "./lib/manager-scope";
import {
  scopeCandidateLines,
  scopeShow,
  scopeWrite,
  type ScopeFlags,
} from "./lib/manager-ctl-scope";
import { ackWake } from "./lib/manager-waiter";
import { readState, listStates } from "./lib/state";

const MULTI = new Set(["scope", "focus", "drop-focus"]);
const BOOL = new Set(["mark-seen", "resolved"]);
const KINDS = ["epic-change", "stale-cancel", "interview-draft"];

export type CtlDeps = {
  home?: string;
  stateDir?: string;
  now?: () => Date;
  exec?: ExecFn;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

type Parsed = { pos: string[]; flags: Map<string, string[]> };

function parse(args: string[]): Parsed | { error: string } {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOL.has(name)) {
      flags.set(name, ["true"]);
      continue;
    }
    const v = args[++i];
    if (v === undefined) return { error: `${a} needs a value` };
    flags.set(name, MULTI.has(name) ? [...(flags.get(name) ?? []), v] : [v]);
  }
  return { pos, flags };
}

export async function run(argv: string[], deps: CtlDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const now = deps.now ?? (() => new Date());
  const { home, stateDir } = deps;
  const p = parse(argv);
  const bad = (msg: string): number => {
    err(`flow-manager-ctl: ${msg}`);
    return 2;
  };
  if ("error" in p) return bad(p.error);
  const flag = (n: string): string | undefined => p.flags.get(n)?.[0];
  const many = (n: string): string[] => p.flags.get(n) ?? [];
  const [verb, sub] = p.pos;
  const scope = (): ReturnType<typeof readScope> => readScope(home);
  const slugInScope = (slug: string): boolean => {
    const s = readState(slug, stateDir);
    return s !== null && stateInScope(s, scope());
  };
  const refuse = (): number => {
    out(JSON.stringify({ ok: false, reason: "out-of-scope" }));
    return 3;
  };

  switch (verb) {
    case "brief": {
      const slug = flag("slug");
      if (!slug) return bad("brief needs --slug <s>");
      if (!slugInScope(slug)) return refuse();
      const tail = Number(flag("transcript-tail") ?? 0);
      const brief = await buildBrief(slug, {
        stateDir,
        exec: deps.exec ?? defaultExec,
        now,
        transcriptTail: Number.isInteger(tail) && tail > 0 ? tail : 0,
      });
      out(JSON.stringify(brief ?? { ok: false, reason: "no-such-pipeline" }));
      return brief ? 0 : 3;
    }
    case "digest": {
      const since = readDigestSeen(home);
      const r = digestSince(since, { home, inScopeSlug: slugInScope });
      out(
        `${r.count} decisions made for you since you last looked${since ? ` (${since})` : ""}${r.count ? `: ${JSON.stringify(r.byKind)}` : ""}`,
      );
      if (flag("mark-seen")) markSeen(now(), home);
      return 0;
    }
    case "log": {
      const slug = flag("slug");
      const reason = flag("reason");
      if (flag("kind") !== "manager-decision" || !slug || !reason) {
        return bad(
          "log needs --kind manager-decision --slug <s> --reason <text>",
        );
      }
      if (!slugInScope(slug)) return refuse();
      const s = readState(slug, stateDir);
      appendManagerLog(
        {
          ts: now().toISOString(),
          kind: "manager-decision",
          repo: s ? repoNameForPath(s.repo) : "unknown",
          ...(s?.epic ? { epic: s.epic.slug } : {}),
          slug,
          reason,
        },
        { home },
      );
      out(JSON.stringify({ ok: true }));
      return 0;
    }
    case "proposal":
      return proposal(sub, p, {
        home,
        stateDir,
        now: now(),
        out,
        bad,
        refuse,
        slugInScope,
      });
    case "scope": {
      const d = { home, stateDir, now: now() };
      if (sub === "show") {
        out(scopeShow(d));
        return 0;
      }
      if (sub === "candidates") {
        out(scopeCandidateLines(d));
        return 0;
      }
      if (sub === "set" || sub === "add" || sub === "remove") {
        const flags: ScopeFlags = {
          scope: many("scope"),
          focus: many("focus"),
          dropFocus: many("drop-focus"),
          resolved: flag("resolved") === "true",
        };
        const r = scopeWrite(sub, flags, d);
        (r.code === 0 ? out : err)(r.out);
        return r.code;
      }
      return bad("scope needs set|add|remove|show|candidates");
    }
    case "ack":
      ackWake(home);
      out(JSON.stringify({ ok: true }));
      return 0;
    default:
      return bad(
        "usage: flow-manager-ctl brief|digest|log|proposal|scope|ack …",
      );
  }
}

type ProposalCtx = {
  home?: string;
  stateDir?: string;
  now: Date;
  out: (s: string) => void;
  bad: (m: string) => number;
  refuse: () => number;
  slugInScope: (slug: string) => boolean;
};

function proposalInScope(pr: Proposal, c: ProposalCtx): boolean {
  const file = readScope(c.home);
  if (!file) return false;
  if (pr.slug) return c.slugInScope(pr.slug);
  const states = listStates(c.stateDir).filter((s) => stateInScope(s, file));
  if (pr.epic) {
    return (
      file.scopes.includes(`epic:${pr.epic}`) ||
      states.some((s) => s.epic?.slug === pr.epic)
    );
  }
  return (
    file.scopes.includes(`repo:${pr.repo}`) ||
    states.some((s) => repoNameForPath(s.repo) === pr.repo)
  );
}

function proposal(sub: string | undefined, p: Parsed, c: ProposalCtx): number {
  const flag = (n: string): string | undefined => p.flags.get(n)?.[0];
  if (sub === "list") {
    c.out(
      JSON.stringify(
        readProposals(c.home).filter((x) => proposalInScope(x, c)),
      ),
    );
    return 0;
  }
  if (sub === "add") {
    const kind = flag("kind");
    const text = flag("text");
    if (!kind || !KINDS.includes(kind) || !text) {
      return c.bad(`proposal add needs --kind (${KINDS.join("|")}) and --text`);
    }
    const slug = flag("slug");
    const state = slug ? readState(slug, c.stateDir) : null;
    const entry: Proposal = {
      id: flag("id") ?? `p-${randomBytes(3).toString("hex")}`,
      kind: kind as ProposalKind,
      repo: flag("repo") ?? (state ? repoNameForPath(state.repo) : "all"),
      ...(slug ? { slug } : {}),
      ...((flag("epic") ?? state?.epic?.slug)
        ? { epic: (flag("epic") ?? state?.epic?.slug) as string }
        : {}),
      text,
      ...(flag("recommendation")
        ? { recommendation: flag("recommendation") as string }
        : {}),
      createdAt: c.now.toISOString(),
    };
    if (!proposalInScope(entry, c)) return c.refuse();
    addProposal(entry, c.home);
    appendManagerLog(
      {
        ts: c.now.toISOString(),
        kind: "proposal-added",
        repo: entry.repo,
        ...(entry.epic ? { epic: entry.epic } : {}),
        ...(entry.slug ? { slug: entry.slug } : {}),
        key: `proposal-added:${entry.id}`,
        reason: entry.text,
      },
      { home: c.home },
    );
    c.out(JSON.stringify({ ok: true, id: entry.id }));
    return 0;
  }
  if (sub === "answer") {
    const id = p.pos[2];
    const answer = flag("answer");
    if (!id || !answer) return c.bad("proposal answer <id> --answer <text>");
    const target = readProposals(c.home).find((x) => x.id === id);
    if (target && !proposalInScope(target, c)) return c.refuse();
    const ok = answerProposal(id, answer, c.now, c.home);
    c.out(JSON.stringify({ ok }));
    return ok ? 0 : 3;
  }
  return c.bad("proposal needs add|list|answer");
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
