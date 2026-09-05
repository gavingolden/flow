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
    let quote: string | null = null;
    let i = openIdx;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
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

export type WorkflowAgentSite = { label: string; agentType: string };

/** Splits a comma-separated argument list at top level only — commas
 * nested inside `()`/`[]`/`{}` or a string/template literal don't split. */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += argsText[++i] ?? "";
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** A plain (non-template) quoted string literal's value, or null when
 * `text` isn't one — the signal that a wrapper-call argument is a
 * concrete label rather than a runtime expression. */
function literalStringValue(text: string): string | null {
  const m = text.trim().match(/^"([^"]*)"$|^'([^']*)'$/);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

type FnDef = { params: string[]; bodyStart: number; bodyEnd: number };

function findFunctionDefs(source: string): Map<string, FnDef> {
  const defs = new Map<string, FnDef>();
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1];
    const params = m[2]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const openBrace = m.index + m[0].length - 1;
    let depth = 0;
    let i = openBrace;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    defs.set(name, { params, bodyStart: openBrace, bodyEnd: i });
  }
  return defs;
}

/** Every `name(...)` call inside `text` (word-boundary, never a
 * `function name(` definition header), each as its split top-level args. */
function findCallsOf(text: string, name: string): string[][] {
  const calls: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(before)) continue;
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let i = openIdx;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(splitTopLevelArgs(text.slice(openIdx + 1, i)));
  }
  return calls;
}

type WrapperResolution =
  | { kind: "literal"; label: string; agentType: string }
  | { kind: "passthrough"; labelParamIndex: number; agentType: string }
  | { kind: "delegates"; calleeName: string; argIndexMap: number[] }
  | { kind: "unresolved" };

/** Classifies one named wrapper function by inspecting its single inner
 * `agent(...)` call, or — absent one — its single call to another named
 * wrapper (the `writeAndValidate` → `helperAgent` shape). */
function resolveWrapper(
  def: FnDef,
  source: string,
  fnDefs: Map<string, FnDef>,
): WrapperResolution {
  const body = source.slice(def.bodyStart, def.bodyEnd + 1);
  const agentCalls = findCallsOf(body, "agent");
  if (agentCalls.length === 1) {
    const objArg = agentCalls[0][1] ?? "";
    if (objArg.includes("${")) return { kind: "unresolved" }; // templated (e.g. reviewLensAgent) — not a plain passthrough
    const agentTypeMatch = objArg.match(/agentType:\s*"([^"]*)"/);
    if (!agentTypeMatch) return { kind: "unresolved" };
    const labelKVMatch = objArg.match(/\blabel\s*:\s*([^,}]+)/);
    if (labelKVMatch) {
      const litLabel = literalStringValue(labelKVMatch[1]);
      if (litLabel !== null) {
        return { kind: "literal", label: litLabel, agentType: agentTypeMatch[1] };
      }
      const paramIdx = def.params.indexOf(labelKVMatch[1].trim());
      if (paramIdx !== -1) {
        return { kind: "passthrough", labelParamIndex: paramIdx, agentType: agentTypeMatch[1] };
      }
      return { kind: "unresolved" };
    }
    if (/\blabel\b\s*[,}]/.test(objArg)) {
      const paramIdx = def.params.indexOf("label");
      if (paramIdx !== -1) {
        return { kind: "passthrough", labelParamIndex: paramIdx, agentType: agentTypeMatch[1] };
      }
    }
    return { kind: "unresolved" };
  }
  for (const [otherName] of fnDefs) {
    const calls = findCallsOf(body, otherName);
    if (calls.length === 1) {
      const innerArgs = calls[0];
      const argIndexMap = innerArgs.map((a) => def.params.indexOf(a.trim()));
      return { kind: "delegates", calleeName: otherName, argIndexMap };
    }
  }
  return { kind: "unresolved" };
}

function resolvedSiteForCall(
  name: string,
  callArgs: string[],
  fnDefs: Map<string, FnDef>,
  source: string,
  depth = 0,
): WorkflowAgentSite | null {
  if (depth > 4) return null;
  const def = fnDefs.get(name);
  if (!def) return null;
  const res = resolveWrapper(def, source, fnDefs);
  if (res.kind === "literal") return { label: res.label, agentType: res.agentType };
  if (res.kind === "passthrough") {
    const lit = literalStringValue(callArgs[res.labelParamIndex] ?? "");
    return lit === null ? null : { label: lit, agentType: res.agentType };
  }
  if (res.kind === "delegates") {
    const mapped = res.argIndexMap.map((idx) => (idx === -1 ? "" : callArgs[idx] ?? ""));
    return resolvedSiteForCall(res.calleeName, mapped, fnDefs, source, depth + 1);
  }
  return null;
}

/**
 * Every `{label, agentType}` pair a `.workflow.js` script's `agent()`
 * surface resolves to: literal-body call sites (`verifyAgent`,
 * `intentGuessAgent`, and any direct in-flow `agent()` call) plus every
 * call site of a label-passthrough wrapper (`helperAgent`,
 * `implementAgent`, `mergeOnce`, and `writeAndValidate`'s one level of
 * indirection through `helperAgent`), resolved back to a concrete label.
 * Templated sites (`reviewLensAgent`'s `` `review:${lens}` ``) resolve to
 * `null` here by design — callers expand those via `AGENT_LENS_MAP`
 * (mirrors `reviewLensAgentTypeSuffixes`'s existing special-case).
 */
export function extractWorkflowAgentSites(source: string): WorkflowAgentSite[] {
  const fnDefs = findFunctionDefs(source);
  const out = new Map<string, WorkflowAgentSite>();

  for (const site of findAgentCallSites(source)) {
    // Deliberately no backtick alternative here: a templated label/agentType
    // (e.g. reviewLensAgent's `` `review:${lens}` ``) never matches a plain
    // "..."/'...' literal, so it's excluded by construction rather than by
    // scanning the whole call body (which also holds the unrelated prompt
    // argument, itself full of `${...}` interpolation) for "${".
    const labelMatch = site.body.match(/\blabel:\s*("[^"]*"|'[^']*')/);
    const typeMatch = site.body.match(/agentType:\s*("[^"]*"|'[^']*')/);
    if (!labelMatch || !typeMatch) continue;
    const label = literalStringValue(labelMatch[1]);
    const agentType = literalStringValue(typeMatch[1]);
    if (label === null || agentType === null) continue;
    out.set(`${label} ${agentType}`, { label, agentType });
  }

  for (const [name, def] of fnDefs) {
    const res = resolveWrapper(def, source, fnDefs);
    if (res.kind !== "passthrough" && res.kind !== "delegates") continue;
    for (const callArgs of findCallsOf(source, name)) {
      const site = resolvedSiteForCall(name, callArgs, fnDefs, source);
      if (site) out.set(`${site.label} ${site.agentType}`, site);
    }
  }

  return [...out.values()];
}

export type AgentSitesDocRow = {
  label: string;
  agentType: string;
};

/** Parses `references/workflow-agent-sites.md`'s `| Label | agentType | ...`
 * table rows (either script's table) into `{label, agentType}` pairs,
 * unwrapping the backtick-quoted `Label`/`agentType` cells. */
export function parseAgentSitesDoc(doc: string): AgentSitesDocRow[] {
  const rows: AgentSitesDocRow[] = [];
  const unbacktick = (cell: string) => cell.trim().replace(/^`|`$/g, "");
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells[0] === "Label" || /^-+$/.test(cells[0])) continue;
    rows.push({ label: unbacktick(cells[0]), agentType: unbacktick(cells[1]) });
  }
  return rows;
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
