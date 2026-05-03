#!/usr/bin/env bun
/**
 * Continuation reminder for the /flow-pipeline supervisor.
 *
 * The supervisor invokes this helper as a Bash tool call after every
 * sub-skill (`/product-planning`, `/new-feature`, `/verify`,
 * `/pr-review`) returns and after every long helper script that ends
 * a phase. The reminder is the freshest signal in scrollback when the
 * model decides what to do next — much closer than the per-step
 * blockquote at the top of each step's section in SKILL.md.
 *
 * Output goes to stderr so the helper can be chained with `jq` /
 * other stdout consumers without polluting them.
 *
 * Exit code is unconditionally 0: this is advisory, not a gate. A
 * non-zero exit would itself become a fake turn-end signal — the
 * very thing the helper exists to prevent.
 *
 * Usage:
 *   flow-checkpoint --from <label> --to <label> [--note <text>]
 *
 * Example:
 *   flow-checkpoint --from step-3 --to step-5 --note "/product-planning returned"
 */

const REMINDER_LINE = "DO NOT END THIS TURN";

type Args = {
  from: string;
  to: string;
  note?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--from":
        out.from = value;
        break;
      case "--to":
        out.to = value;
        break;
      case "--note":
        out.note = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.from) return { error: "--from is required" };
  if (!out.to) return { error: "--to is required" };
  return out as Args;
}

export function buildLines(args: Args): string[] {
  const transition = `flow-checkpoint: returning from ${args.from} → continuing to ${args.to}`;
  const note = args.note?.trim();
  const lines = [transition];
  if (note && note.length > 0) {
    lines.push(`note: ${note.replace(/[\r\n]+/g, " ")}`);
  }
  lines.push(REMINDER_LINE);
  return lines;
}

export type Deps = {
  writeErr: (s: string) => void;
};

export function run(argv: string[], deps?: Partial<Deps>): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-checkpoint: ${parsed.error}`);
    console.error(
      "usage: flow-checkpoint --from <label> --to <label> [--note <text>]",
    );
    return 2;
  }
  const writeErr = deps?.writeErr ?? ((s) => process.stderr.write(s));
  for (const line of buildLines(parsed)) {
    writeErr(`${line}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
