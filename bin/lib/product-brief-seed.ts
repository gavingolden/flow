/**
 * Seeds `~/.flow/product.md` from `templates/product.md.template` the first
 * time `flow install` runs with no user-level brief present. COPY, never
 * SYMLINK: the brief is human-maintained and user-edited going forward, and
 * a symlink into the flow checkout would make the user's own edits land in
 * flow's own tree instead of the user's home. Seed-when-absent only: an
 * existing brief (repo or user) is never overwritten, and a deliberately
 * deleted brief is re-seeded on the next install — see docs/configuration.md
 * "Product brief" for the `review.product: false` kill switch.
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

export type SeedProductBriefResult = {
  status: "created" | "exists" | "no-template" | "failed";
  path: string;
  error?: string;
};

const TEMPLATE_RELATIVE_PATH = path.join("templates", "product.md.template");

export function seedUserProductBrief(
  opts: SeedProductBriefOptions,
): SeedProductBriefResult {
  const home = opts.homeDir ?? os.homedir();
  const destination = path.join(home, ".flow", "product.md");

  try {
    const existing = fs.readFileSync(destination, "utf8");
    if (existing.trim() !== "") {
      return { status: "exists", path: destination };
    }
  } catch {
    // Absent (or unreadable) — fall through to seeding.
  }

  const candidates = [
    opts.installRoot
      ? path.join(opts.installRoot, TEMPLATE_RELATIVE_PATH)
      : undefined,
    path.join(opts.flowSource, TEMPLATE_RELATIVE_PATH),
  ].filter((p): p is string => typeof p === "string");

  const templatePath = candidates.find((p) => fs.existsSync(p));
  if (!templatePath) {
    return { status: "no-template", path: destination };
  }

  try {
    const contents = fs.readFileSync(templatePath, "utf8");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    return { status: "created", path: destination };
  } catch (err) {
    return {
      status: "failed",
      path: destination,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
