#!/usr/bin/env bun
/**
 * No-merge empirical probe of the user-global merge allow rule.
 *
 * Proves, against a real headless Claude session, that the rule text flow
 * documents (`FLOW_MERGE_ALLOW_RULE`) pre-approves `flow-merge-guard merge …`
 * and does NOT pre-approve its sibling `flow-merge-guard <PR> --record-override`,
 * and that the owner's two `permissions.ask` rules (`FLOW_OVERRIDE_ASK_RULES`)
 * make `--record-override` prompt (refused headless) without touching the
 * merge. Nothing can merge: `flow-merge-guard` on PATH is a stub that only appends
 * its argv to a marker file.
 *
 * The rule is supplied by appending it to `--allowed-tools`, which goes
 * through the same permission-rule matching engine as `permissions.allow`.
 * It is NOT written to a scratch repo's `.claude/settings.json`: the headless
 * child does not load an untrusted scratch project's settings (empirically,
 * dontAsk denied the merge with the rule only in that file). That user-scope
 * `permissions.allow` loads the same way rests on Claude Code's documented
 * settings merge semantics, not on this probe. It never reads or writes any
 * real settings file, and removes its temp dir on exit. `Bash(true)` is always
 * passed so the blanket Bash deny is not appended.
 *
 * Rows 1-3 are the verdict: (1) dontAsk merge WITH the rule runs; (2) dontAsk
 * record-override WITH the rule is refused; (3) dontAsk merge WITHOUT the rule
 * (control) is refused, proving the rule is what approves row 1. Rows 4-5 are
 * informational: auto mode's classifier approved a bare stub merge with no rule
 * at all, so when the no-rule control also runs they print `classifier-approves`
 * (auto behaviour unproven) and never fail the probe.
 *
 * Rows 6-8 are decisive auto-mode rows for the ask rules, supplied through
 * `--ask-tools` (inline `permissions.ask`, tightening only): (6) and (7)
 * `--record-override` with the ask rules is refused, bare and with `--slug`;
 * (8) `merge` with the merge allow rule AND the ask rules still runs. Row 9
 * (`--record-override` with no rules) is an informational control. When auto
 * mode is unavailable the decisive auto rows are skipped, not failed.
 *
 * Spends nine short Haiku sessions (each capped at $0.50).
 *
 * Exit codes: 0 - every decisive row holds; 1 - a decisive row failed; 2 -
 * `claude` missing or a decisive row could not complete. Informational rows
 * never change the exit code; auto mode being unavailable is reported as its
 * own verdict.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FLOW_MERGE_ALLOW_RULE,
  FLOW_OVERRIDE_ASK_RULES,
} from "../bin/lib/merge-allow-rule";

export type RowVerdict =
  | "pass"
  | "fail"
  | "inconclusive"
  | "auto-unavailable"
  | "classifier-approves";

export type Row = {
  name: string;
  mode: "dontAsk" | "auto";
  command: string;
  /** The merge allow rule is appended to `--allowed-tools` for this row. */
  withRule: boolean;
  /** `FLOW_OVERRIDE_ASK_RULES` are passed to the child via `--ask-tools`. */
  askRules?: boolean;
  /** The marker (stub invocation) is expected to appear. */
  expectMarker: boolean;
  /** Reported only; never decides the probe's exit code. */
  informational?: boolean;
};

export const ROWS: Row[] = [
  {
    name: "dontAsk merge",
    mode: "dontAsk",
    command: "flow-merge-guard merge 999999",
    withRule: true,
    expectMarker: true,
  },
  {
    name: "dontAsk record-override",
    mode: "dontAsk",
    command: "flow-merge-guard 999999 --record-override",
    withRule: true,
    expectMarker: false,
  },
  {
    name: "dontAsk merge, no rule",
    mode: "dontAsk",
    command: "flow-merge-guard merge 999999",
    withRule: false,
    expectMarker: false,
  },
  {
    name: "auto merge, no rule",
    mode: "auto",
    command: "flow-merge-guard merge 999999",
    withRule: false,
    expectMarker: false,
    informational: true,
  },
  {
    name: "auto merge",
    mode: "auto",
    command: "flow-merge-guard merge 999999",
    withRule: true,
    expectMarker: true,
    informational: true,
  },
  {
    name: "auto record-override, ask rules",
    mode: "auto",
    command: "flow-merge-guard 999999 --record-override",
    withRule: false,
    askRules: true,
    expectMarker: false,
  },
  {
    name: "auto record-override --slug, ask",
    mode: "auto",
    command: "flow-merge-guard 999999 --record-override --slug probe",
    withRule: false,
    askRules: true,
    expectMarker: false,
  },
  {
    name: "auto merge, allow + ask rules",
    mode: "auto",
    command: "flow-merge-guard merge 999999",
    withRule: true,
    askRules: true,
    expectMarker: true,
  },
  {
    name: "auto record-override, no rules",
    mode: "auto",
    command: "flow-merge-guard 999999 --record-override",
    withRule: false,
    expectMarker: false,
    informational: true,
  },
];

const AUTO_UNAVAILABLE =
  /auto mode.{0,60}(unavailable|not (available|supported|enabled)|unsupported)|(unavailable|not (available|supported|enabled)|unsupported).{0,60}auto mode/i;

export function classify(input: {
  row: Row;
  ran: boolean;
  markerSeen: boolean;
  /** The child reported at least one permission denial. */
  denied: boolean;
  diagnostics: string;
  /** For the auto-with-rule row: the no-rule auto control also ran the stub. */
  controlRan?: boolean;
}): RowVerdict {
  const { row, ran, markerSeen, denied, diagnostics, controlRan } = input;
  if (
    row.mode === "auto" &&
    !markerSeen &&
    AUTO_UNAVAILABLE.test(diagnostics)
  ) {
    return "auto-unavailable";
  }
  if (!ran) return "inconclusive";
  if (row.askRules) {
    // The ask rules are the subject, so the classifier control is irrelevant:
    // a seen marker settles the row either way.
    if (markerSeen) return row.expectMarker ? "pass" : "fail";
    if (row.expectMarker) return "fail";
    return denied ? "pass" : "inconclusive";
  }
  if (row.mode === "auto") {
    if (!row.withRule && markerSeen) return "classifier-approves";
    if (row.withRule && markerSeen && controlRan) return "classifier-approves";
  }
  if (row.expectMarker) return markerSeen ? "pass" : "fail";
  if (markerSeen) return "fail";
  // A refusal only counts when the child actually tried and was denied; a
  // model that never ran the command proves nothing.
  return denied ? "pass" : "inconclusive";
}

export function overallExit(
  verdicts: { row: Row; verdict: RowVerdict }[],
): 0 | 1 | 2 {
  const decisive = verdicts.filter(
    (v) => !v.row.informational && v.verdict !== "auto-unavailable",
  );
  if (decisive.some((v) => v.verdict === "fail")) return 1;
  if (decisive.length > 0 && decisive.every((v) => v.verdict === "pass")) {
    return 0;
  }
  return 2;
}

function claudeOnPath(): boolean {
  return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
}

function runRow(
  row: Row,
  scratch: string,
  binDir: string,
  index: number,
  controlRan: boolean,
) {
  const marker = path.join(scratch, `marker-${index}.txt`);
  const stub = path.join(binDir, "flow-merge-guard");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n`, {
    mode: 0o755,
  });
  const out = path.join(scratch, `out-${index}.json`);
  const headless = path.join(__dirname, "..", "bin", "flow-claude-headless.ts");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  delete env.FLOW_HEADLESS_DEPTH;
  const r = spawnSync(
    "bun",
    [
      headless,
      "--prompt",
      `Run this exact shell command with the Bash tool, then reply done: ${row.command}`,
      "--model",
      "haiku",
      "--effort",
      "low",
      "--allowed-tools",
      row.withRule ? `Bash(true),${FLOW_MERGE_ALLOW_RULE}` : "Bash(true)",
      ...(row.askRules
        ? ["--ask-tools", FLOW_OVERRIDE_ASK_RULES.join(",")]
        : []),
      "--env",
      "PATH",
      "--max-budget-usd",
      "0.5",
      "--max-turns",
      "6",
      "--timeout-sec",
      "180",
      "--permission-mode",
      row.mode,
      "--out",
      out,
      "--task",
      `probe-${index}`,
    ],
    { cwd: scratch, env, encoding: "utf8" },
  );
  let envelope: { ran?: boolean; permission_denials?: unknown } = {};
  try {
    envelope = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    // inconclusive below
  }
  const artifact = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const markerSeen =
    fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim().length > 0;
  return classify({
    row,
    ran: envelope.ran === true,
    markerSeen,
    denied:
      Array.isArray(envelope.permission_denials) &&
      envelope.permission_denials.length > 0,
    diagnostics: `${r.stdout}\n${r.stderr}\n${artifact}`,
    controlRan,
  });
}

function main(): number {
  if (!claudeOnPath()) {
    process.stderr.write("probe-merge-allow-rule: claude is not on PATH\n");
    return 2;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "merge-rule-probe-"));
  try {
    const binDir = path.join(scratch, "bin");
    fs.mkdirSync(binDir);
    spawnSync("git", ["init", "-q"], { cwd: scratch });
    const verdicts: { row: Row; verdict: RowVerdict }[] = [];
    let autoControlRan = false;
    ROWS.forEach((row, i) => {
      const verdict = runRow(row, scratch, binDir, i + 1, autoControlRan);
      if (row.command.startsWith("flow-merge-guard merge") && !row.withRule) {
        autoControlRan = verdict === "classifier-approves";
      }
      verdicts.push({ row, verdict });
    });
    for (const { row, verdict } of verdicts) {
      const want = row.expectMarker ? "runs" : "refused";
      const tag = row.informational ? " (informational)" : "";
      process.stdout.write(
        `${verdict.padEnd(20)} ${row.name.padEnd(26)} expected: ${want}${tag}\n`,
      );
    }
    return overallExit(verdicts);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(main());
}
