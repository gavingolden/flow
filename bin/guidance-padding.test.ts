import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findPaddingRuns, PADDING_THRESHOLD } from "./lib/guidance-padding";

const ROOT = path.join(__dirname, "..");
const SHIPPED = ["skills", "references", "agents", "templates", "docs"];

function shippedMarkdown(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", ...SHIPPED, "AGENTS.md", "README.md"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter((f) => f.endsWith(".md") && fs.existsSync(path.join(ROOT, f)));
}

describe("shipped guidance padding", () => {
  it("has no run of padding at or above the threshold", () => {
    const findings = shippedMarkdown().flatMap((f) =>
      findPaddingRuns(fs.readFileSync(path.join(ROOT, f), "utf8")).map(
        (r) => `${f}:${r.line} (${r.length})`,
      ),
    );
    expect(findings).toEqual([]);
  });

  it("flags a generated 1,200-dash run, proving the check can fail", () => {
    const runs = findPaddingRuns(`| a |\n| ${"-".repeat(1200)} |`);
    expect(runs).toEqual([{ line: 2, length: 1200, char: "-" }]);
    expect(1200).toBeGreaterThanOrEqual(PADDING_THRESHOLD);
  });
});
