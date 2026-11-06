/**
 * Advisory flow-plan-lint checks that the Task breakdown carries the settings
 * a Runtime design implies: queue must-set settings and a recovery path.
 * Evals showed planners read the references yet left these out of the tasks.
 */
import { findPrdSectionEnd } from "./plan-runtime-surface";

const stripHtmlComments = (t: string): string =>
  t.replace(/<!--[\s\S]*?-->/g, "");

export function extractTaskBreakdownSection(planText: string): string | null {
  const lines = planText.split("\n");
  const start = lines.findIndex((l) => /^#\s+Task breakdown\s*$/i.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return stripHtmlComments(lines.slice(start + 1, end).join("\n"));
}

export function prdLabelValue(planText: string, label: string): string | null {
  const prd = planText.match(/^# PRD\s*$/m);
  if (!prd) return null;
  const afterPrd = (prd.index ?? 0) + prd[0].length;
  const body = stripHtmlComments(
    planText.slice(afterPrd, findPrdSectionEnd(planText, afterPrd)),
  );
  const line = body.match(new RegExp(`^\\*\\*${label}:\\*\\*`, "m"));
  if (!line) return null;
  return body
    .slice((line.index ?? 0) + line[0].length)
    .split(/\n\s*\n|\n(?=\*\*|#)/)[0]
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

type QueueService = {
  name: string;
  detect: RegExp;
  settings: { label: string; re: RegExp }[];
};

const DLQ = /dead[- ]letter|\bdlq\b/i;

const QUEUE_SERVICES: QueueService[] = [
  {
    name: "SQS",
    detect: /\bsqs\b/i,
    settings: [
      { label: "visibility timeout", re: /visibility[- ]?timeout/i },
      {
        label: "dead-letter queue",
        re: /dead[- ]letter|\bdlq\b|redrive|maxReceiveCount/i,
      },
    ],
  },
  {
    name: "Cloud Tasks",
    detect: /cloud tasks/i,
    settings: [
      { label: "dispatch deadline", re: /dispatch[- ]?deadline/i },
      {
        label: "max attempts",
        re: /max(?:imum)?[- ]?attempts|\d+ attempts|attempt (?:cap|limit)/i,
      },
    ],
  },
  {
    name: "Pub/Sub",
    detect: /pub\/?sub/i,
    settings: [
      {
        label: "ack deadline",
        re: /ack(?:nowledg(?:e)?ment)?[- ]?deadline/i,
      },
      { label: "dead-letter topic", re: /dead[- ]letter/i },
    ],
  },
  {
    name: "Cloudflare Queues",
    detect: /cloudflare queues?|wrangler[^\n]*queues?|\[\[queues/i,
    settings: [
      {
        label: "dead-letter queue",
        re: new RegExp(`${DLQ.source}|dead_letter_queue`, "i"),
      },
    ],
  },
];

export function checkQueueCompanions(planText: string, misses: string[]): void {
  const tasks = extractTaskBreakdownSection(planText);
  if (tasks === null) return;
  for (const svc of QUEUE_SERVICES) {
    if (!svc.detect.test(tasks)) continue;
    for (const s of svc.settings) {
      if (s.re.test(tasks)) continue;
      misses.push(
        `Task breakdown uses ${svc.name} but no task sets its ${s.label} — set it in the task that creates the queue (see the platform reference in flow-system-design)`,
      );
    }
  }
}

const TOKEN_BUCKET = String.raw`(?<!\b(?:token|leaky|histogram)\s)\bbuckets?\b`;
const DB_STORE_RE =
  /\bmigrations?\b|\bcreate table\b|\bnew table\b|firestore|dynamodb|\bdatabase\b/i;
const BUCKET_STORE_RE = new RegExp(
  `${TOKEN_BUCKET}|cloud storage|\\bs3\\b|\\br2\\b`,
  "i",
);
const DATASTORE_RE = new RegExp(
  `${DB_STORE_RE.source}|${BUCKET_STORE_RE.source}`,
  "i",
);
const NEW_STORE_RE = new RegExp(
  `\\bcreate table\\b|\\bnew table\\b|${TOKEN_BUCKET}`,
  "i",
);
const DB_RECOVERY_RE = /backups?|point[- ]in[- ]time|\bpitr\b/i;
const BUCKET_RECOVERY_RE = /versioning|backups?/i;
const DUAL_BUCKET_RECOVERY_RE =
  /versioning|\bbuckets?\b[^\n]{0,40}\bbackups?\b|\bbackups?\b[^\n]{0,40}\bbuckets?\b/i;
const REGENERABLE_RE =
  /regenerab|derived|rebuil|cache|re-?run|recomput|already covered|existing backup/i;

export function checkRecovery(planText: string, misses: string[]): void {
  const tasks = extractTaskBreakdownSection(planText);
  if (tasks === null || !DATASTORE_RE.test(tasks)) return;
  const value = prdLabelValue(planText, "Recovery");
  if (value === null) {
    misses.push(
      "Task breakdown adds or changes a datastore but the plan has no '**Recovery:**' line under '### Runtime design' — say how the data comes back if lost (backups or point-in-time recovery plus a restore check), or 'none — <why it is regenerable or already covered>'",
    );
    return;
  }
  if (/^none\b/i.test(value)) {
    const reason = value.match(/^none\s*(?:—|–|--?|:)\s*(\S[\s\S]*)$/i);
    if (!reason) {
      misses.push(
        "'**Recovery:**' says 'none' with no reason — write 'none — <why the data is regenerable or already covered>'",
      );
    } else if (NEW_STORE_RE.test(tasks) && !REGENERABLE_RE.test(reason[1])) {
      misses.push(
        "'**Recovery:**' says 'none' but a task adds a new table or bucket — give it a recovery path, or a reason the data is regenerable",
      );
    }
    return;
  }
  const hasDb = DB_STORE_RE.test(tasks);
  const hasBucket = BUCKET_STORE_RE.test(tasks);
  const dbMiss = hasDb && !DB_RECOVERY_RE.test(tasks);
  const bucketMiss =
    hasBucket &&
    !(hasDb ? DUAL_BUCKET_RECOVERY_RE : BUCKET_RECOVERY_RE).test(tasks);
  if (dbMiss) {
    misses.push(
      "'**Recovery:**' names a recovery path but no task sets up backups or point-in-time recovery for the database — object versioning does not cover it. Make it a task such as 'verify backups/PITR are on, enable them if not' (parameterize unknown instance names, e.g. ${CLOUD_SQL_INSTANCE:?}), not an Open Question",
    );
  }
  if (bucketMiss) {
    misses.push(
      "'**Recovery:**' names a recovery path but no task enables versioning or backups for the bucket — make it a task, not an Open Question",
    );
  }
  if (!/restor/i.test(tasks)) {
    misses.push(
      "'**Recovery:**' names a recovery path but no task checks a restore — an untested backup is a hope",
    );
  }
}
