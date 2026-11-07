/** Sub-agent spawns of one supervisor session: `subagents/*.jsonl` plus each `.meta.json`. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SpawnAttribution } from "./run-attribution-types";
import { attributeTurns } from "./run-attribution-unit";
import { readTranscriptTurns } from "./transcript-turns";

const ROLE_DESCRIPTION_MAX = 80;

export function roleFromMeta(meta: Record<string, unknown>): {
  role: string;
  agentType: string | null;
} {
  const agentType =
    typeof meta.agentType === "string" && meta.agentType
      ? meta.agentType
      : null;
  const description =
    typeof meta.description === "string"
      ? meta.description.trim().slice(0, ROLE_DESCRIPTION_MAX)
      : "";
  if (!agentType) return { role: description || "unknown", agentType };
  const bare = (agentType.split(":").pop() ?? agentType).replace(/^flow-/, "");
  if (bare === "general-purpose") {
    return { role: description || bare, agentType };
  }
  return { role: bare, agentType };
}

export function collectSpawns(
  parent: string,
  dir: string,
): { spawns: SpawnAttribution[]; skipped: number } {
  const spawns: SpawnAttribution[] = [];
  let skipped = 0;
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
  } catch {
    return { spawns, skipped };
  }
  for (const name of names) {
    const turns = readTranscriptTurns(path.join(dir, name));
    if (!turns) {
      skipped++;
      continue;
    }
    const { role, agentType } = roleFromMeta(readMeta(dir, name));
    spawns.push({
      ...attributeTurns(path.basename(name, ".jsonl"), turns),
      role,
      agent_type: agentType,
      parent_session_id: parent,
    });
  }
  return { spawns, skipped };
}

function readMeta(dir: string, jsonlName: string): Record<string, unknown> {
  try {
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(dir, jsonlName.replace(/\.jsonl$/, ".meta.json")),
        "utf8",
      ),
    );
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}
