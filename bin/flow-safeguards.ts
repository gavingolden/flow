#!/usr/bin/env bun
/**
 * `flow-safeguards` — helpers for the bounded safeguards-stop retry.
 *
 * Usage:
 *   flow-safeguards compact (--out-dir <dir> | --in-place) [--force] [--no-marker] <paths...>
 *     (--no-marker: --in-place without prettier-ignore lines, for diffs)
 *   flow-safeguards parse --text-file <p>
 *   flow-safeguards record --log <p> --json '<RetryRecord>'
 *   flow-safeguards retry-set --edit-set <p> --partial-result <p> --out <p>
 *   flow-safeguards retry-set --merge --first <p> --second <p> --out <p>
 *   flow-safeguards lens-retry-plan --lens <l> --out-dir <dir> [--agy-available] <inputs...>
 *   flow-safeguards map-paths --copies <json-file> <files...>
 *   flow-safeguards note --log <p>
 *   flow-safeguards decision-items --body-file <p> [--skips <files...>]
 *
 * Exit codes: 0 ok, 2 bad arguments.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { compactFiles, readJsonOrNull } from "./lib/safeguards-cli";
import {
  buildRetryEditSet,
  mapCopyPaths,
  mergeCoderResults,
  planLensRetry,
  upsertDecisionItems,
  type CoderResultLike,
  type EditEntry,
} from "./lib/safeguards-retry";
import {
  parseRetryLog,
  parseSafeguardsStop,
  renderSafeguardsNote,
  validateRetryRecord,
} from "./lib/safeguards-stop";

const USAGE = `usage: flow-safeguards <compact|parse|record|retry-set|lens-retry-plan|map-paths|note|decision-items> [options]
  compact (--out-dir <dir> | --in-place) [--force] [--no-marker] <paths...>`;

class UsageError extends Error {}

const OPTIONS = {
  "out-dir": { type: "string" },
  "in-place": { type: "boolean" },
  force: { type: "boolean" },
  "no-marker": { type: "boolean" },
  "text-file": { type: "string" },
  log: { type: "string" },
  json: { type: "string" },
  "edit-set": { type: "string" },
  "partial-result": { type: "string" },
  out: { type: "string" },
  merge: { type: "boolean" },
  first: { type: "string" },
  second: { type: "string" },
  lens: { type: "string" },
  "agy-available": { type: "boolean" },
  copies: { type: "string" },
  "body-file": { type: "string" },
  skips: { type: "string", multiple: true },
} as const;

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "")
    throw new UsageError(`--${flag} is required`);
  return v;
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function writeOut(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

function run(cmd: string | undefined, argv: string[]): void {
  const { values: v, positionals: pos } = parse(argv);
  switch (cmd) {
    case "compact": {
      if ((v["out-dir"] === undefined) === (v["in-place"] !== true)) {
        throw new UsageError("exactly one of --out-dir / --in-place");
      }
      if (pos.length === 0)
        throw new UsageError("at least one path is required");
      const res = compactFiles(pos, {
        outDir: v["out-dir"],
        inPlace: v["in-place"],
        force: v.force,
        noMarker: v["no-marker"],
      });
      console.log(JSON.stringify(res));
      return;
    }
    case "parse": {
      const text = readText(need(v["text-file"], "text-file"));
      console.log(JSON.stringify(parseSafeguardsStop(text)));
      return;
    }
    case "record": {
      const log = need(v.log, "log");
      let raw: unknown;
      try {
        raw = JSON.parse(need(v.json, "json"));
      } catch {
        throw new UsageError("--json is not valid JSON");
      }
      const res = validateRetryRecord(raw);
      if (!res.ok) throw new UsageError(res.error);
      fs.mkdirSync(path.dirname(path.resolve(log)), { recursive: true });
      fs.appendFileSync(log, JSON.stringify(res.record) + "\n");
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    case "retry-set": {
      const out = need(v.out, "out");
      if (v.merge) {
        const second = readJsonOrNull(need(v.second, "second"));
        if (typeof second !== "object" || second === null) {
          throw new UsageError("--second is missing or not JSON");
        }
        const first = readJsonOrNull(need(v.first, "first"));
        const firstObj =
          typeof first === "object" && first !== null
            ? (first as CoderResultLike)
            : null;
        writeOut(out, mergeCoderResults(firstObj, second as CoderResultLike));
        return;
      }
      const editSet = readJsonOrNull(need(v["edit-set"], "edit-set"));
      if (!Array.isArray(editSet))
        throw new UsageError("--edit-set must be a JSON array");
      const partial = readJsonOrNull(
        need(v["partial-result"], "partial-result"),
      );
      const partialObj =
        typeof partial === "object" && partial !== null
          ? (partial as CoderResultLike)
          : null;
      const { remaining, droppedGuidance } = buildRetryEditSet(
        editSet as EditEntry[],
        partialObj,
      );
      writeOut(out, remaining);
      console.log(
        JSON.stringify({ remaining: remaining.length, droppedGuidance }),
      );
      return;
    }
    case "lens-retry-plan": {
      need(v.lens, "lens");
      if (pos.length === 0)
        throw new UsageError("at least one input is required");
      const { files, anyCompacted } = compactFiles(pos, {
        outDir: need(v["out-dir"], "out-dir"),
        force: true,
      });
      const route = planLensRetry({
        inputsChanged: anyCompacted,
        agyAvailable: v["agy-available"] === true,
      });
      const copies = Object.fromEntries(
        files.filter((f) => f.compacted).map((f) => [f.path, f.copy]),
      );
      console.log(JSON.stringify({ route, copies }));
      return;
    }
    case "map-paths": {
      const raw = readJsonOrNull(need(v.copies, "copies")) as Record<
        string,
        unknown
      > | null;
      if (typeof raw !== "object" || raw === null)
        throw new UsageError("--copies is not JSON");
      const copies = (raw.copies ?? raw) as Record<string, string>;
      let rewritten = 0;
      for (const f of pos) {
        const text = readText(f);
        const next = mapCopyPaths(text, copies);
        if (next !== text) {
          fs.writeFileSync(f, next);
          rewritten++;
        }
      }
      console.log(JSON.stringify({ rewritten }));
      return;
    }
    case "note": {
      const note = renderSafeguardsNote(
        parseRetryLog(readText(need(v.log, "log"))),
      );
      if (note !== "") console.log(note);
      return;
    }
    case "decision-items": {
      const body = readText(need(v["body-file"], "body-file"));
      const skipped = [...(v.skips ?? []), ...pos].flatMap((f) => {
        const j = readJsonOrNull(f) as {
          lens?: string;
          request_ids?: string[];
        } | null;
        return j && typeof j.lens === "string"
          ? [{ lens: j.lens, requestIds: j.request_ids ?? [] }]
          : [];
      });
      process.stdout.write(upsertDecisionItems(body, skipped));
      return;
    }
    default:
      throw new UsageError(`unknown subcommand: ${cmd ?? "(none)"}`);
  }
}

if (import.meta.main) {
  try {
    run(process.argv[2], process.argv.slice(3));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
}
