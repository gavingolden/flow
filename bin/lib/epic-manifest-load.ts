import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { validateDag } from "../flow-epic-dag";
import {
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";

/**
 * Read + shape-validate + DAG-validate the committed manifest READ-ONLY. The
 * orchestrator never writes `.flow/epics/<slug>/manifest.json`.
 */
export function loadCommittedManifest(
  manifestPath: string,
):
  | { ok: true; manifest: EpicManifest; sha: string }
  | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, reason: "not-found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const shape = validateEpicManifest(parsed);
  if (!shape.ok)
    return { ok: false, reason: `invalid manifest — ${shape.reason}` };
  const dag = validateDag(shape.value.features);
  if (!dag.ok) {
    return {
      ok: false,
      reason: `manifest DAG is malformed:\n${dag.violations.map((v) => `  ${v.message}`).join("\n")}`,
    };
  }
  return {
    ok: true,
    manifest: shape.value,
    sha: createHash("sha256").update(raw).digest("hex"),
  };
}
