#!/usr/bin/env bun
/**
 * CLI over `bin/lib/module-status.ts` — the runtime gate pipeline skills and
 * helpers call by bare name to ask "is this module/skill active right now"
 * before running a module-gated block (Copilot request/wait, research
 * fan-out, an optional-module skill deferral).
 *
 * Two check surfaces, plus a doctor listing:
 *
 *   flow-module-status --check <module-id> [--json]
 *     Exit 0 when the module is active.
 *     Exit 3 when inactive: prints `noticeLine(id)` to stderr (plain mode)
 *       or `skipEnvelope(id)` to stdout (--json mode, always exit 0).
 *     Exit 2 on an unknown module id (both modes).
 *
 *   flow-module-status --check-skill <skill> [--json]
 *     Resolves the owning module via `moduleForSkill`. An unknown skill
 *     (owned by no module) is always treated as active — same exit-code
 *     shape as --check, but there is no "unknown skill" error case.
 *
 *   flow-module-status [--summary]
 *     No args, or --summary: prints the full per-module active/inactive +
 *     reason listing (`core` always shown active) to stdout. Exit 0.
 *
 * `--json` reshapes the check surfaces into machine-readable output:
 *   active   -> {"ran":true}
 *   inactive -> skipEnvelope(id), e.g. {"ran":false,"skipReason":"research-module-deselected"}
 * and always exits 0 — the caller branches on the JSON payload, mirroring
 * flow-pre-commit / flow-delegate's `skipReason` graceful-skip convention
 * (exit 3 in plain mode is the same graceful-skip signal for a shell `||`).
 */

import {
  isModuleActive,
  isSkillActive,
  moduleForSkill,
  noticeLine,
  resolveModuleActivity,
  skipEnvelope,
  type ModuleActivity,
} from "./lib/module-status";
import { isKnownModule, MANDATORY_MODULE, type ModuleId } from "./lib/modules";
import type { Manifest } from "./lib/manifest";

type Deps = {
  readSelection?: () => string[] | undefined;
  readManifest?: () => Manifest;
};

type ParsedArgs =
  | { mode: "check"; id: string; json: boolean }
  | { mode: "check-skill"; skill: string; json: boolean }
  | { mode: "summary" }
  | { error: string };

const USAGE =
  "usage: flow-module-status --check <module-id> [--json]\n" +
  "       flow-module-status --check-skill <skill> [--json]\n" +
  "       flow-module-status [--summary]";

function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let checkId: string | undefined;
  let checkSkill: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--json":
        json = true;
        continue;
      case "--summary":
        continue;
      case "--check": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
          return { error: "--check requires a value" };
        }
        checkId = value;
        i++;
        continue;
      }
      case "--check-skill": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
          return { error: "--check-skill requires a value" };
        }
        checkSkill = value;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (checkId !== undefined && checkSkill !== undefined) {
    return { error: "--check and --check-skill are mutually exclusive" };
  }
  if (checkId !== undefined) return { mode: "check", id: checkId, json };
  if (checkSkill !== undefined) {
    return { mode: "check-skill", skill: checkSkill, json };
  }
  return { mode: "summary" };
}

function renderSummary(activity: ModuleActivity[]): string {
  const lines = ["flow module status:"];
  for (const m of activity) {
    const status = m.active ? "active" : "inactive";
    const pin = m.id === MANDATORY_MODULE ? "present, mandatory" : m.reason;
    lines.push(`  ${m.id}: ${status} (${pin})`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Testable core: buffers stdout/stderr into the return value instead of
 * writing directly, so tests can assert on output without spying on
 * `process.stdout`/`process.stderr`. `main()` below is the only caller that
 * performs real I/O + `process.exit`.
 */
export function runModuleStatus(
  argv: string[],
  deps: Deps = {},
): { code: number; stdout: string; stderr: string } {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return {
      code: 2,
      stdout: "",
      stderr: `flow-module-status: ${parsed.error}\n${USAGE}\n`,
    };
  }

  if (parsed.mode === "summary") {
    return {
      code: 0,
      stdout: renderSummary(resolveModuleActivity(deps)),
      stderr: "",
    };
  }

  if (parsed.mode === "check") {
    if (!isKnownModule(parsed.id)) {
      return {
        code: 2,
        stdout: "",
        stderr: `flow-module-status: unknown module id '${parsed.id}'\n`,
      };
    }
    const id = parsed.id as ModuleId;
    const active = isModuleActive(id, deps);
    if (parsed.json) {
      const payload = active ? { ran: true } : skipEnvelope(id);
      return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }
    if (active) return { code: 0, stdout: "", stderr: "" };
    return { code: 3, stdout: "", stderr: `${noticeLine(id)}\n` };
  }

  // mode === "check-skill"
  const id = moduleForSkill(parsed.skill);
  const active = isSkillActive(parsed.skill, deps);
  if (parsed.json) {
    const payload = active ? { ran: true } : skipEnvelope(id as ModuleId);
    return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  }
  if (active) return { code: 0, stdout: "", stderr: "" };
  return { code: 3, stdout: "", stderr: `${noticeLine(id as ModuleId)}\n` };
}

function main(): void {
  const result = runModuleStatus(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

if (import.meta.main) {
  main();
}
