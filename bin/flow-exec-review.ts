#!/usr/bin/env bun
/**
 * flow-exec-review — the epic executive's PATH helper.
 *
 *   status      --slug <s> [--epic <e>]
 *   review      --kind plan --epic <e> --slug <s>
 *   review      --kind wave --epic <e> [--repo-root <dir>]
 *   order       --epic <e> --frontier <id,id,...>
 *   outcome     --slug <s> --decision <id> --reply accept|approve|redirect|cancel
 *   charter     --add "<line>" [--decision <id>]
 *   stamp-check --slug <s> --body-file <path>
 *
 * Every non-usage path prints exactly one JSON line and exits 0; a usage error
 * exits 2. The pipeline branches on the JSON, never the exit code.
 */

import * as fs from "node:fs";
import { grantScopeForSlug } from "./lib/epic-grant";
import { appendManagerLog, readManagerLog } from "./lib/epic-manager-log";
import { addCorrection } from "./lib/exec-charter";
import { runPlanReview } from "./lib/exec-review-plan";
import { defaultExecDeps, type ExecReviewDeps } from "./lib/exec-review-shared";
import { orderFrontier, runWaveReview } from "./lib/exec-review-wave";
import { resolveRepoRoot } from "./lib/repo-root";
import { readState } from "./lib/state";

const USAGE = `usage: flow-exec-review <subcommand> [flags]
  status      --slug <s> [--epic <e>]
  review      --kind plan --epic <e> --slug <s>
  review      --kind wave --epic <e> [--repo-root <dir>]
  order       --epic <e> --frontier <id,id,...>
  outcome     --slug <s> --decision <id> --reply accept|approve|redirect|cancel
  charter     --add "<line>" [--decision <id>]
  stamp-check --slug <s> --body-file <path>`;

const REPLIES = ["accept", "approve", "redirect", "cancel"] as const;
type Reply = (typeof REPLIES)[number];

type Parsed = {
  flags: Record<string, string>;
  positionals: string[];
  bare: Set<string>;
};

/**
 * `--` ends option parsing (everything after is positional). A valued flag
 * takes the next token literally, even one starting with `--` (charter text
 * may), unless that token is a known flag of this subcommand or the `--`
 * terminator; a valued flag left without a value is a usage error unless it
 * is listed in `bareOk`.
 */
function parse(
  args: string[],
  valued: string[],
  bareOk: string[] = [],
): Parsed | { error: string } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  const bare = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!valued.includes(name)) return { error: `unknown flag: ${a}` };
    const next = args[i + 1];
    if (
      next === undefined ||
      next === "--" ||
      (next.startsWith("--") && valued.includes(next.slice(2)))
    ) {
      if (!bareOk.includes(name))
        return { error: `--${name} requires a value` };
      bare.add(name);
      continue;
    }
    flags[name] = next;
    i++;
  }
  return { flags, positionals, bare };
}

/**
 * `charter --add [--decision <id>] "<text>"`: the text is taken literally
 * wherever it sits — directly after `--add` or after `--decision <id>` —
 * even when it starts with `--`.
 */
function parseCharter(
  args: string[],
): { line: string; decision?: string } | { error: string } {
  let decision: string | undefined;
  let sawAdd = false;
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      text.push(...args.slice(i + 1));
      break;
    }
    if (a === "--decision") {
      const next = args[i + 1];
      if (next === undefined || next === "--") {
        return { error: "--decision requires a value" };
      }
      decision = next;
      i++;
    } else if (a === "--add") {
      sawAdd = true;
      const next = args[i + 1];
      if (next !== undefined && next !== "--" && next !== "--decision") {
        text.push(next);
        i++;
      }
    } else if (!a.startsWith("--") || (sawAdd && text.length === 0)) {
      text.push(a);
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }
  if (!sawAdd) return { error: "charter requires --add" };
  return { line: text.join(" "), decision };
}

export function run(
  argv: string[],
  overrides: Partial<ExecReviewDeps> = {},
): number {
  const deps: ExecReviewDeps = { ...defaultExecDeps(), ...overrides };
  const out = (o: unknown) => console.log(JSON.stringify(o));
  const usage = (msg: string) => {
    console.error(`flow-exec-review: ${msg}`);
    console.error(USAGE);
    return 2;
  };
  const [sub, ...rest] = argv;

  switch (sub) {
    case "status": {
      const p = parse(rest, ["slug", "epic"]);
      if ("error" in p) return usage(p.error);
      if (!p.flags.slug) return usage("status requires --slug");
      const scope = grantScopeForSlug(p.flags.slug, {
        stateDir: deps.stateDir,
        expectedEpic: p.flags.epic,
      });
      out(scope);
      return 0;
    }

    case "review": {
      const p = parse(rest, ["kind", "epic", "slug", "repo-root"]);
      if ("error" in p) return usage(p.error);
      const { kind, epic, slug } = p.flags;
      if (kind === "plan") {
        if (!epic || !slug)
          return usage("review --kind plan requires --epic and --slug");
        out(runPlanReview({ slug, epic }, deps));
        return 0;
      }
      if (kind === "wave") {
        if (!epic) return usage("review --kind wave requires --epic");
        const repoRoot = p.flags["repo-root"] ?? resolveRepoRoot(process.cwd());
        if (!repoRoot)
          return usage("review --kind wave must run inside a git repository");
        out(runWaveReview({ epic, repoRoot }, deps));
        return 0;
      }
      return usage("review requires --kind plan|wave");
    }

    case "order": {
      const p = parse(rest, ["epic", "frontier"]);
      if ("error" in p) return usage(p.error);
      if (!p.flags.epic || p.flags.frontier === undefined) {
        return usage("order requires --epic and --frontier");
      }
      const frontier = p.flags.frontier
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      out({ order: orderFrontier(p.flags.epic, frontier, deps.stateDir) });
      return 0;
    }

    case "outcome": {
      const p = parse(rest, ["slug", "decision", "reply"]);
      if ("error" in p) return usage(p.error);
      const { slug, decision, reply } = p.flags;
      if (!slug || !decision || !reply) {
        return usage("outcome requires --slug, --decision and --reply");
      }
      if (!(REPLIES as readonly string[]).includes(reply)) {
        return usage(`--reply must be one of ${REPLIES.join("|")}`);
      }
      const epic = readState(slug, deps.stateDir)?.epic?.slug;
      if (!epic) {
        out({ ok: false, reason: "not-epic" });
        return 0;
      }
      const prior = readManagerLog(epic, deps.stateDir).find(
        (e) => e.kind === "exec-decision" && e.exec?.decisionId === decision,
      );
      if (!prior?.exec) {
        out({ ok: false, reason: "decision-not-found" });
        return 0;
      }
      const wrongApproval =
        prior.exec.reviewKind === "plan" &&
        prior.exec.action === "approve" &&
        (reply === "redirect" || reply === "cancel");
      appendManagerLog(
        epic,
        {
          ts: deps.now().toISOString(),
          kind: "exec-owner-reply",
          slug,
          exec: {
            decisionId: decision,
            reviewKind: prior.exec.reviewKind,
            ownerReply: reply as Reply,
            accepted: reply === "accept",
            ...(wrongApproval ? { wrongApproval: true } : {}),
          },
        },
        deps.stateDir,
      );
      out({
        ok: true,
        decisionId: decision,
        accepted: reply === "accept",
        wrongApproval,
        ...(wrongApproval
          ? {
              offer: `flow-exec-review charter --add --decision ${decision} "<what the executive should have weighed>"`,
            }
          : {}),
      });
      return 0;
    }

    case "charter": {
      const p = parseCharter(rest);
      if ("error" in p) return usage(p.error);
      const result = addCorrection(p.line, {
        homeDir: deps.homeDir,
        decisionId: p.decision,
      });
      out(result);
      return 0;
    }

    case "stamp-check": {
      const p = parse(rest, ["slug", "body-file"]);
      if ("error" in p) return usage(p.error);
      if (!p.flags.slug || !p.flags["body-file"]) {
        return usage("stamp-check requires --slug and --body-file");
      }
      const epic = readState(p.flags.slug, deps.stateDir)?.epic?.slug;
      const log = epic ? readManagerLog(epic, deps.stateDir) : [];
      const latest = log
        .filter(
          (e) =>
            (e.kind === "exec-decision" || e.kind === "exec-skip") &&
            e.slug === p.flags.slug &&
            e.exec?.reviewKind === "plan",
        )
        .at(-1);
      const overruled =
        latest?.kind === "exec-decision" &&
        log.some(
          (e) =>
            e.kind === "exec-owner-reply" &&
            e.exec?.decisionId === latest.exec?.decisionId &&
            (e.exec?.ownerReply === "redirect" ||
              e.exec?.ownerReply === "cancel"),
        );
      if (
        !latest ||
        latest.kind !== "exec-decision" ||
        latest.exec?.action !== "approve" ||
        overruled
      ) {
        out({ ok: true, decisionId: null });
        return 0;
      }
      const id = latest.exec.decisionId;
      let body = "";
      try {
        body = fs.readFileSync(p.flags["body-file"], "utf8");
      } catch {
        body = "";
      }
      out({ ok: body.includes(`decision ${id}`), decisionId: id });
      return 0;
    }

    default:
      return usage(
        sub ? `unknown subcommand: ${sub}` : "a subcommand is required",
      );
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
