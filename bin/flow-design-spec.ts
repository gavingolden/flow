#!/usr/bin/env bun
/**
 * LLM-free design-fidelity helper. Three subcommands:
 *
 * - `probe-script` — emit the canonical `evaluate_script` JS that extracts the
 *   fixed computed-style property set for the declared selectors (from
 *   repeated `--selectors <sel>` flags, or derived from `--spec <spec.json>`).
 *   Never a whole-page walk: only declared selectors, only the fixed set.
 * - `diff --spec <spec.json> --captured <capture.json> [--json]` — normalize
 *   both sides (colors → canonical rgb, first-resolved font-family, px within
 *   a ±1px default tolerance overridable per assertion via `tolerancePx`) and
 *   emit `{ok, assertions: [{id, status, expected, actual}]}`. Exit 0
 *   all-pass / 1 any-fail / 2 malformed inputs (loud stderr reason, never a
 *   crash). Judged-tier assertions report `skipped-judged`, never fail.
 * - `validate <spec.json>` — shape check via `bin/lib/design-spec-schema.ts`.
 *
 * The helper never drives a browser and never spawns an LLM — the calling
 * skill evaluates the emitted probe script via the chrome-devtools MCP and
 * persists the capture itself.
 */

import {
  validateDesignCapture,
  validateDesignSpec,
  type DesignAssertion,
  type DesignCapture,
  type DesignSpec,
} from "./lib/design-spec-schema";

export const PROBE_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "text-transform",
  "color",
  "background-color",
  "border",
  "box-shadow",
  "position",
] as const;

export const DEFAULT_TOLERANCE_PX = 1;

/** Selectors a browser probe should extract for: mechanical, computed-style. */
export function probeSelectorsFromSpec(
  spec: DesignSpec,
  surface?: string,
): string[] {
  const out: string[] = [];
  for (const s of spec.surfaces) {
    if (surface !== undefined && s.name !== surface) continue;
    for (const a of s.assertions) {
      if (a.tier !== "mechanical" || a.method === "source-read") continue;
      if (!out.includes(a.selector)) out.push(a.selector);
    }
  }
  return out;
}

/**
 * The emitted script is a zero-arg arrow function suitable for the
 * chrome-devtools `evaluate_script` tool. Selectors are embedded via
 * JSON.stringify so arbitrary CSS never breaks the emitted source.
 */
export function buildProbeScript(selectors: string[]): string {
  return `() => {
  const SELECTORS = ${JSON.stringify(selectors)};
  const PROPS = ${JSON.stringify(PROBE_PROPERTIES)};
  return SELECTORS.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, found: false, properties: {} };
    const cs = getComputedStyle(el);
    const properties = {};
    for (const p of PROPS) properties[p] = cs.getPropertyValue(p);
    const r = el.getBoundingClientRect();
    properties["rect-x"] = r.x + "px";
    properties["rect-y"] = r.y + "px";
    properties["rect-width"] = r.width + "px";
    properties["rect-height"] = r.height + "px";
    return { selector, found: true, properties };
  });
}`;
}

/** Canonicalize hex / rgb()/rgba() colors to `rgb(r, g, b)` / `rgba(r, g, b, a)`. Returns null for non-colors. */
export function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    const [r, g, b] = [n(0), n(2), n(4)];
    if (h.length === 8) {
      const a = Math.round((n(6) / 255) * 1000) / 1000;
      return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
  }
  const fn =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
      v,
    );
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map((x) =>
      Math.round(parseFloat(x)),
    );
    const a = fn[4] === undefined ? 1 : parseFloat(fn[4]);
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return null;
}

/** First comma-separated family, unquoted and lowercased. */
export function firstFontFamily(value: string): string {
  const first = splitTopLevel(value, ",")[0] ?? "";
  return first
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

function splitTopLevel(value: string, sep: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PX_RE = /^-?\d*\.?\d+px$/;

function tokensMatch(exp: string, act: string, tolerancePx: number): boolean {
  const e = exp.trim().toLowerCase();
  const a = act.trim().toLowerCase();
  if (PX_RE.test(e) && PX_RE.test(a)) {
    return Math.abs(parseFloat(e) - parseFloat(a)) <= tolerancePx;
  }
  const ec = normalizeColor(e);
  const ac = normalizeColor(a);
  if (ec !== null || ac !== null) return ec !== null && ec === ac;
  const en = Number(e);
  const an = Number(a);
  if (!Number.isNaN(en) && !Number.isNaN(an) && e !== "" && a !== "") {
    return en === an;
  }
  return e === a;
}

/** Compare one expected vs actual CSS value with benign-difference normalization. */
export function compareValue(
  prop: string,
  expected: string,
  actual: string,
  tolerancePx = DEFAULT_TOLERANCE_PX,
): boolean {
  if (prop === "font-family") {
    return firstFontFamily(expected) === firstFontFamily(actual);
  }
  const expTokens = splitTopLevel(expected, " ");
  const actTokens = splitTopLevel(actual, " ");
  if (expTokens.length !== actTokens.length) return false;
  return expTokens.every((t, i) => tokensMatch(t, actTokens[i], tolerancePx));
}

export type DiffAssertion = {
  id: string;
  status: "pass" | "fail" | "skipped-judged";
  expected?: Record<string, string>;
  actual?: Record<string, string> | null;
  failing?: string[];
};

export type DiffEnvelope = { ok: boolean; assertions: DiffAssertion[] };

export function diffSpecCapture(
  spec: DesignSpec,
  capture: DesignCapture,
): DiffEnvelope {
  const surface = spec.surfaces.find((s) => s.name === capture.surface);
  if (!surface) {
    throw new Error(
      `capture surface "${capture.surface}" not declared in the spec (have: ${spec.surfaces.map((s) => s.name).join(", ")})`,
    );
  }
  const assertions = surface.assertions.map((a) => diffAssertion(a, capture));
  return { ok: assertions.every((r) => r.status !== "fail"), assertions };
}

function diffAssertion(
  a: DesignAssertion,
  capture: DesignCapture,
): DiffAssertion {
  if (a.tier === "judged") return { id: a.id, status: "skipped-judged" };
  const expected = a.properties ?? {};
  const entry = capture.captured.find((c) => c.selector === a.selector);
  if (!entry) {
    return {
      id: a.id,
      status: "fail",
      expected,
      actual: null,
      failing: Object.keys(expected),
    };
  }
  const failing = Object.entries(expected)
    .filter(([prop, exp]) => {
      const act = entry.properties[prop];
      return act === undefined || !compareValue(prop, exp, act, a.tolerancePx);
    })
    .map(([prop]) => prop);
  const actual = Object.fromEntries(
    Object.keys(expected).map((p) => [p, entry.properties[p] ?? ""]),
  );
  return failing.length === 0
    ? { id: a.id, status: "pass", expected, actual }
    : { id: a.id, status: "fail", expected, actual, failing };
}

function fail2(reason: string): never {
  process.stderr.write(`flow-design-spec: ${reason}\n`);
  process.exit(2);
}

async function readJson(path: string, what: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e) {
    fail2(
      `cannot read ${what} at ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail2(
      `${what} at ${path} is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? undefined : argv[i + 1];
}

const USAGE = `usage:
  flow-design-spec probe-script (--selectors '<css-selector>' [--selectors ...] | --spec <spec.json> [--surface <name>])
  flow-design-spec diff --spec <spec.json> --captured <capture.json> [--json]
  flow-design-spec validate <spec.json>
`;

export async function main(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (sub === "probe-script") {
    const selectors: string[] = [];
    for (let i = 1; i < argv.length - 1; i++) {
      // One flag value = one selector; commas are valid CSS, so never split.
      if (argv[i] === "--selectors") selectors.push(argv[i + 1]);
    }
    const specPath = flagValue(argv, "--spec");
    if (selectors.length > 0 && specPath !== undefined) {
      fail2("pass either --selectors or --spec, not both");
    }
    if (specPath !== undefined) {
      const spec = validateDesignSpec(await readJson(specPath, "spec"));
      if (!spec.ok) fail2(`invalid spec: ${spec.reason}`);
      selectors.push(
        ...probeSelectorsFromSpec(spec.value, flagValue(argv, "--surface")),
      );
    }
    if (selectors.length === 0) {
      fail2(`probe-script needs --selectors or --spec\n${USAGE}`);
    }
    process.stdout.write(buildProbeScript(selectors) + "\n");
    return 0;
  }

  if (sub === "diff") {
    const specPath = flagValue(argv, "--spec");
    const capturedPath = flagValue(argv, "--captured");
    if (!specPath || !capturedPath)
      fail2(`diff needs --spec and --captured\n${USAGE}`);
    const spec = validateDesignSpec(await readJson(specPath, "spec"));
    if (!spec.ok) fail2(`invalid spec: ${spec.reason}`);
    const capture = validateDesignCapture(
      await readJson(capturedPath, "capture"),
    );
    if (!capture.ok) fail2(`invalid capture: ${capture.reason}`);
    let envelope: DiffEnvelope;
    try {
      envelope = diffSpecCapture(spec.value, capture.value);
    } catch (e) {
      fail2(e instanceof Error ? e.message : String(e));
    }
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    } else {
      for (const a of envelope.assertions) {
        const detail =
          a.status === "fail" && a.failing ? ` (${a.failing.join(", ")})` : "";
        process.stdout.write(`${a.status.toUpperCase()} ${a.id}${detail}\n`);
      }
    }
    return envelope.ok ? 0 : 1;
  }

  if (sub === "validate") {
    const path = argv[1];
    if (!path) fail2(`validate needs a <spec.json> path\n${USAGE}`);
    const result = validateDesignSpec(await readJson(path, "spec"));
    if (result.ok) {
      process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      return 0;
    }
    process.stderr.write(
      JSON.stringify({ ok: false, reason: result.reason, path }) + "\n",
    );
    return 1;
  }

  fail2(`unknown subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
