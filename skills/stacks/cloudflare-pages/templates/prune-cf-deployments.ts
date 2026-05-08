#!/usr/bin/env bun
/**
 * Bulk-prune Cloudflare Pages deployments via the CF REST API.
 *
 * Copy this file to your project's `scripts/` directory; this is a template,
 * not a flow-internal helper. See skills/stacks/cloudflare-pages/SKILL.md
 * for usage.
 *
 * Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
 *
 * Defaults to --dry-run; pass --apply to actually delete. Skips production
 * deployment + aliased deployments by default. Caps deletes per run at --max=50.
 */

export type Args = {
  project: string;
  olderThan: Date;
  branchGlobs: string[];
  keepAliased: boolean;
  keepProductionLatest: boolean;
  max: number;
  apply: boolean;
};

export type Deployment = {
  id: string;
  created_on: string;
  deployment_trigger?: { metadata?: { branch?: string } };
  aliases?: string[] | null;
  environment?: "preview" | "production";
};

export const USAGE = `Usage: prune-cf-deployments [flags]

Required:
  --project <name>          Cloudflare Pages project name.
  --older-than <value>      Cutoff: <N>d (e.g. 30d), ISO date (2026-01-01),
                            or ISO datetime (2026-01-01T00:00:00Z).

Optional:
  --branch <glob>           Repeatable. Positive globs (e.g. 'feat/*') or
                            negative ('!main'). No flag = match all.
  --keep-aliased            Skip deployments with active aliases (default).
  --no-keep-aliased         Allow deleting aliased deployments.
  --keep-production-latest  Skip canonical production deployment (default).
  --no-keep-production-latest
                            Allow deleting the canonical production deployment.
  --max <N>                 Cap deletions per run. Default 50.
  --dry-run                 Print the would-delete list and exit (default).
  --apply                   Actually delete.

Required env:
  CLOUDFLARE_API_TOKEN      Token with Account.Cloudflare Pages:Edit scope.
  CLOUDFLARE_ACCOUNT_ID     Cloudflare account ID (not project ID).
`;

export function parseOlderThan(
  input: string,
  now: Date = new Date(),
): Date | { error: string } {
  if (!input || typeof input !== "string") {
    return { error: `invalid --older-than value: ${input}` };
  }
  const dayMatch = input.match(/^(\d+)d$/);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (!Number.isFinite(days) || days < 0) {
      return { error: `invalid --older-than value: ${input}` };
    }
    const ms = now.getTime() - days * 24 * 60 * 60 * 1000;
    return new Date(ms);
  }
  // ISO date or datetime
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `invalid --older-than value: ${input}` };
  }
  return parsed;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = {
    project: "",
    olderThan: new Date(0),
    branchGlobs: [],
    keepAliased: true,
    keepProductionLatest: true,
    max: 50,
    apply: false,
  };
  let olderThanRaw = "";
  let dryRunSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--keep-aliased":
        out.keepAliased = true;
        continue;
      case "--no-keep-aliased":
        out.keepAliased = false;
        continue;
      case "--keep-production-latest":
        out.keepProductionLatest = true;
        continue;
      case "--no-keep-production-latest":
        out.keepProductionLatest = false;
        continue;
      case "--dry-run":
        if (out.apply) {
          return { error: "--dry-run and --apply are mutually exclusive" };
        }
        dryRunSeen = true;
        out.apply = false;
        continue;
      case "--apply":
        if (dryRunSeen) {
          return { error: "--dry-run and --apply are mutually exclusive" };
        }
        out.apply = true;
        continue;
      case "--project":
      case "--older-than":
      case "--branch":
      case "--max": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: `${flag} requires a value` };
        }
        if (flag === "--project") out.project = value;
        if (flag === "--older-than") olderThanRaw = value;
        if (flag === "--branch") out.branchGlobs.push(value);
        if (flag === "--max") {
          const n = Number(value);
          if (!Number.isInteger(n) || n <= 0) {
            return { error: `--max requires a positive integer; got '${value}'` };
          }
          out.max = n;
        }
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (!out.project) return { error: "--project is required" };
  if (!olderThanRaw) return { error: "--older-than is required" };

  const cutoff = parseOlderThan(olderThanRaw);
  if (cutoff instanceof Date) {
    out.olderThan = cutoff;
  } else {
    return cutoff;
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesBranchFilter(
  branch: string,
  globs: string[],
): boolean {
  if (globs.length === 0) return true;
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const g of globs) {
    if (g.startsWith("!")) negatives.push(g.slice(1));
    else positives.push(g);
  }
  const hitsNegative = negatives.some((n) =>
    globToRegExp(n).test(branch),
  );
  if (hitsNegative) return false;
  if (positives.length === 0) return true;
  return positives.some((p) => globToRegExp(p).test(branch));
}

export function shouldDelete(
  deployment: Deployment,
  args: Args,
  productionDeploymentId: string | null,
  _now: Date,
): { delete: boolean; reason: string } {
  if (
    args.keepProductionLatest &&
    productionDeploymentId !== null &&
    deployment.id === productionDeploymentId
  ) {
    return { delete: false, reason: "production-latest" };
  }
  if (
    args.keepAliased &&
    deployment.aliases &&
    deployment.aliases.length > 0
  ) {
    return { delete: false, reason: "aliased" };
  }
  const created = new Date(deployment.created_on);
  if (created.getTime() >= args.olderThan.getTime()) {
    return { delete: false, reason: "too-recent" };
  }
  if (args.branchGlobs.length > 0) {
    const branch = deployment.deployment_trigger?.metadata?.branch;
    if (!branch) {
      return { delete: false, reason: "branch-unknown" };
    }
    if (!matchesBranchFilter(branch, args.branchGlobs)) {
      return { delete: false, reason: "branch-excluded" };
    }
  }
  return { delete: true, reason: "eligible" };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const json = JSON.parse(text) as { errors?: Array<{ message?: string }> };
      const messages = json.errors
        ?.map((e) => e.message)
        .filter((m): m is string => typeof m === "string" && m.length > 0);
      if (messages && messages.length > 0) return messages.join("; ");
    } catch {
      // not JSON; fall through to raw text
    }
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  } catch {
    return "";
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n`);
    process.stderr.write(USAGE);
    return 2;
  }
  const args = parsed;

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) {
    process.stderr.write("error: CLOUDFLARE_API_TOKEN env var is not set\n");
    return 2;
  }
  if (!accountId) {
    process.stderr.write("error: CLOUDFLARE_ACCOUNT_ID env var is not set\n");
    return 2;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${args.project}`;

  const projectRes = await fetch(base, { headers });
  if (!projectRes.ok) {
    const detail = await readErrorBody(projectRes);
    process.stderr.write(
      `error: GET project failed: ${projectRes.status} ${projectRes.statusText}${detail ? ` — ${detail}` : ""}\n`,
    );
    return 1;
  }
  const projectJson = (await projectRes.json()) as {
    result?: { canonical_deployment?: { id?: string } };
  };
  const productionDeploymentId =
    projectJson?.result?.canonical_deployment?.id ?? null;

  const eligible: Deployment[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${base}/deployments?page=${page}&per_page=25`,
      { headers },
    );
    if (!res.ok) {
      const detail = await readErrorBody(res);
      process.stderr.write(
        `error: GET deployments page ${page} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}\n`,
      );
      return 1;
    }
    const body = (await res.json()) as { result?: Deployment[] };
    const deployments: Deployment[] = body?.result ?? [];
    if (deployments.length === 0) break;
    for (const d of deployments) {
      const verdict = shouldDelete(
        d,
        args,
        productionDeploymentId,
        new Date(),
      );
      if (verdict.delete) eligible.push(d);
      if (eligible.length >= args.max) break;
    }
    if (eligible.length >= args.max) break;
    page++;
  }

  process.stdout.write(
    `Found ${eligible.length} deployments to delete (max ${args.max}, mode=${args.apply ? "APPLY" : "DRY-RUN"})\n`,
  );
  for (const d of eligible) {
    const branch = d.deployment_trigger?.metadata?.branch ?? "?";
    process.stdout.write(
      `  ${d.id}  ${d.created_on}  branch=${branch}\n`,
    );
  }

  if (!args.apply) {
    process.stdout.write(
      "Dry run — no deletes performed. Re-run with --apply to delete.\n",
    );
    return 0;
  }

  let deleted = 0;
  let failed = 0;
  for (const d of eligible) {
    const res = await fetch(`${base}/deployments/${d.id}?force=true`, {
      method: "DELETE",
      headers,
    });
    if (res.ok) {
      deleted++;
      process.stdout.write(`  deleted ${d.id}\n`);
    } else {
      failed++;
      const detail = await readErrorBody(res);
      process.stderr.write(
        `  FAILED ${d.id}: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}\n`,
      );
    }
  }
  process.stdout.write(`Deleted ${deleted}/${eligible.length} deployments.\n`);
  // Non-zero exit when any DELETE failed so cron / CI surfaces the partial
  // failure instead of silently passing.
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`unexpected error: ${err}\n`);
      process.exit(1);
    });
}
