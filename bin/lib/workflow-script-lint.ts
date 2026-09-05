/**
 * Structural helpers for `bin/workflow-script-lint.test.ts` — pure string/regex
 * parsing over a `.workflow.js` source, no `claude` invocation, no execution
 * of the script itself (these files use top-level `await`/`return`, which is
 * only legal once the harness wraps the body in an async function — see
 * `checkWorkflowScriptSyntax` below for the same wrap applied to `node --check`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AgentCallSite = { start: number; body: string };

/** Every top-level `agent(` call site (word-boundary — never matches inside
 * `helperAgent(`/`implementAgent(`/etc.), with its balanced-paren body. */
export function findAgentCallSites(source: string): AgentCallSite[] {
  const sites: AgentCallSite[] = [];
  const re = /\bagent\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let i = openIdx;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    sites.push({ start: m.index, body: source.slice(openIdx, i + 1) });
  }
  return sites;
}

/** True iff every `agent(` call site's body sets `effort:` and either
 * `model:` (a literal or a `...modelArg(`-style spread) or is a Bash-only
 * helper tier — `agentType: "general-purpose"` paired with the literal
 * `effort: "low"` — that deliberately never resolves a per-phase model
 * because it always inherits the session model (flow's documented
 * low-cost-helper convention; see references/model-routing.md "omit model:
 * ... so the sub-agent inherits"). Checked directly at each call site
 * rather than requiring wrapper-function indirection. */
export function everyAgentCallHasEffortAndModel(source: string): {
  ok: boolean;
  offenders: number[];
} {
  const offenders: number[] = [];
  for (const site of findAgentCallSites(source)) {
    const hasEffort = /effort:/.test(site.body);
    const hasModel = /model:|\.\.\.modelArg\(/.test(site.body);
    const isInheritedHelperTier =
      /agentType:\s*"general-purpose"/.test(site.body) &&
      /effort:\s*"low"/.test(site.body);
    if (!hasEffort || (!hasModel && !isInheritedHelperTier)) {
      offenders.push(site.start);
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/** Every `agentType: "flow-module-core:<x>"` string literal in the source. */
export function pluginAgentTypes(source: string): string[] {
  const re = /agentType:\s*"flow-module-core:([a-z0-9-]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

/** Every distinct `agentType:` string literal (plugin-qualified or bare). */
export function allAgentTypes(source: string): string[] {
  const re = /agentType:\s*"([^"]+)"/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.add(m[1]);
  return [...out];
}

/** `flow-review-<lens>` suffixes referenced via a template literal
 * (`` `flow-module-core:flow-review-${lens}` ``) plus literal ones. */
export function reviewLensAgentTypeSuffixes(source: string): string[] {
  const literal = pluginAgentTypes(source)
    .filter(
      (t) => t.startsWith("flow-review-") && t !== "flow-review-intent-guess",
    )
    .map((t) => t.replace(/^flow-review-/, ""));
  const templated = /flow-module-core:flow-review-\$\{lens\}/.test(source);
  return templated ? [] : literal; // templated form covers all lenses via prep.lenses
}

/**
 * Syntax-checks a `.workflow.js` body via `node --check`. These files use
 * `export const meta = {...}` (ESM-only) AND top-level `await`/`return`
 * (only legal inside a function) — a combination no Node module mode parses
 * literally (verified against the reference `docs/workflow-spike/*.workflow.js`
 * shape, which has the identical combination). The real Workflow-tool loader
 * extracts `meta` and wraps the remaining body in an async function before
 * evaluating it, so this check mirrors that: strip the `export ` keyword off
 * the `meta` declaration, wrap the rest in `async function __wf(args, agent,
 * phase, log, parallel) { ... }`, and check THAT for real syntax errors.
 */
export function checkWorkflowScriptSyntax(source: string): {
  ok: boolean;
  stderr: string;
} {
  const stripped = source.replace(/^export const meta/, "const meta");
  const wrapped = `async function __wf(args, agent, phase, log, parallel) {\n${stripped}\n}\n`;
  const dir = mkdtempSync(join(tmpdir(), "flow-workflow-lint-"));
  const file = join(dir, "check.cjs");
  try {
    writeFileSync(file, wrapped);
    execFileSync("node", ["--check", file], { stdio: "pipe" });
    return { ok: true, stderr: "" };
  } catch (e: any) {
    return { ok: false, stderr: String(e?.stderr ?? e?.message ?? e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
