/**
 * Seeds `~/.flow/product.md` from `templates/product.md.template` the first
 * time `flow install` runs with no user-level brief present. COPY, never
 * SYMLINK: the brief is human-maintained and user-edited going forward, and
 * a symlink into the flow checkout would make the user's own edits land in
 * flow's own tree instead of the user's home. Seed-when-absent only: an
 * existing brief (repo or user) is never overwritten, and a deliberately
 * deleted brief is re-seeded on the next install — see docs/configuration.md
 * "Product brief" for the `review.product: false` kill switch.
 *
 * One exception: an existing brief that lacks the `## Deciding on my behalf`
 * charter section gets that section appended ONCE (`section-added`); nothing
 * else in the file is touched. The marker `~/.flow/state/charter-seeded`
 * records that the section was offered, so an owner who later deletes it to
 * opt out never gets it back.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SeedProductBriefOptions = {
  /** Home directory the brief is seeded under. Defaults to os.homedir(). */
  homeDir?: string;
  /** The `--source <worktree>` tree, used as the template fallback location. */
  flowSource: string;
  /** The canonical install root; preferred template location when present. */
  installRoot?: string;
};

export const CHARTER_HEADING = "## Deciding on my behalf";

export type SeedProductBriefResult = {
  status: "created" | "exists" | "section-added" | "no-template" | "failed";
  path: string;
  error?: string;
};

const TEMPLATE_RELATIVE_PATH = path.join("templates", "product.md.template");

/** The charter section of a template: its heading to the next `## ` heading or EOF. */
function templateCharterSection(template: string): string | null {
  const start = template.indexOf(`\n${CHARTER_HEADING}\n`);
  const from =
    start === -1
      ? template.startsWith(`${CHARTER_HEADING}\n`)
        ? 0
        : -1
      : start + 1;
  if (from === -1) return null;
  const next = template.indexOf("\n## ", from + CHARTER_HEADING.length);
  return template.slice(from, next === -1 ? undefined : next + 1).trimEnd();
}

function findTemplate(opts: SeedProductBriefOptions): string | undefined {
  const candidates = [
    opts.installRoot
      ? path.join(opts.installRoot, TEMPLATE_RELATIVE_PATH)
      : undefined,
    path.join(opts.flowSource, TEMPLATE_RELATIVE_PATH),
  ].filter((p): p is string => typeof p === "string");
  return candidates.find((p) => fs.existsSync(p));
}

function readTemplateCharter(opts: SeedProductBriefOptions): string | null {
  try {
    const tpl = findTemplate(opts);
    return tpl ? templateCharterSection(fs.readFileSync(tpl, "utf8")) : null;
  } catch {
    return null;
  }
}

export function seedUserProductBrief(
  opts: SeedProductBriefOptions,
): SeedProductBriefResult {
  const home = opts.homeDir ?? os.homedir();
  const destination = path.join(home, ".flow", "product.md");

  const marker = path.join(home, ".flow", "state", "charter-seeded");
  const writeMarker = () => {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {
      // best effort: a missing marker only means a later install may re-offer
    }
  };

  try {
    const existing = fs.readFileSync(destination, "utf8");
    if (existing.trim() !== "") {
      if (fs.existsSync(marker)) return { status: "exists", path: destination };
      if (
        existing.includes(`\n${CHARTER_HEADING}\n`) ||
        existing.startsWith(`${CHARTER_HEADING}\n`)
      ) {
        writeMarker();
        return { status: "exists", path: destination };
      }
      const section = readTemplateCharter(opts);
      if (!section) return { status: "exists", path: destination };
      try {
        fs.writeFileSync(
          destination,
          `${existing.replace(/\s*$/, "")}\n\n${section}\n`,
        );
        writeMarker();
        return { status: "section-added", path: destination };
      } catch (err) {
        return {
          status: "failed",
          path: destination,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } catch {
    // Absent (or unreadable) — fall through to seeding.
  }

  const templatePath = findTemplate(opts);
  if (!templatePath) {
    return { status: "no-template", path: destination };
  }

  try {
    const contents = fs.readFileSync(templatePath, "utf8");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    if (templateCharterSection(contents)) writeMarker();
    return { status: "created", path: destination };
  } catch (err) {
    return {
      status: "failed",
      path: destination,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
