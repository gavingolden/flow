import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODULES } from "./lib/modules";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments: string[]) =>
  fs.readFileSync(path.resolve(HERE, "..", ...segments), "utf8");
const exists = (...segments: string[]) =>
  fs.existsSync(path.resolve(HERE, "..", ...segments));
const skillRoot = ["skills", "universal", "flow-system-design"];

describe("flow-system-design wiring", () => {
  it("SKILL.md links every reference file and every link resolves", () => {
    const skill = read(...skillRoot, "SKILL.md");
    expect(skill).toMatch(/^name: flow-system-design$/m);
    const onDisk = fs
      .readdirSync(path.resolve(HERE, "..", ...skillRoot, "references"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    const linked = [...skill.matchAll(/\]\(references\/([\w-]+\.md)\)/g)]
      .map((m) => m[1])
      .filter((f, i, all) => all.indexOf(f) === i)
      .sort();
    expect(linked).toEqual(onDisk);
    for (const ref of [
      "gcp.md",
      "cloudflare.md",
      "aws.md",
      "data.md",
      "workflows.md",
    ]) {
      expect(onDisk).toContain(ref);
    }
  });

  it("discovery-runtime-design.md carries the five runtime defaults", () => {
    const ref = read(
      "skills",
      "pipeline",
      "flow-product-planning",
      "references",
      "discovery-runtime-design.md",
    );
    expect(ref).toMatch(/^## Runtime defaults$/m);
    for (const rule of [
      "is queue-driven, not run in the request",
      "A scheduler tick only enqueues one task per unit",
      "Every outbound call has an explicit timeout",
      "keyed on business identity",
      "one cap or ledger at a single choke point",
    ]) {
      expect(ref).toContain(rule);
    }
  });

  it("SKILL.md pins the interactive budget to 10 s, not the platform timeout", () => {
    const skill = read(...skillRoot, "SKILL.md");
    expect(skill).toMatch(
      /interactive budget is 10 s\. It is never the platform's request timeout/,
    );
  });

  it("SKILL.md carries a proportionality rule and an Execution model decision table", () => {
    const skill = read(...skillRoot, "SKILL.md");
    expect(skill).toMatch(/Proportionality/);
    expect(skill).toMatch(/\|\s*Situation\s*\|\s*Execution model\s*\|/);
  });

  it("the core module registers flow-system-design", () => {
    expect(MODULES.find((m) => m.id === "core")?.skills).toContain(
      "flow-system-design",
    );
  });

  it("the PRD template carries ### Runtime design", () => {
    expect(
      read(
        "skills",
        "pipeline",
        "flow-product-planning",
        "templates",
        "prd-template.md",
      ),
    ).toMatch(/^### Runtime design$/m);
  });

  it("discovery-instructions.md points at discovery-runtime-design.md", () => {
    expect(
      read(
        "skills",
        "pipeline",
        "flow-product-planning",
        "references",
        "discovery-instructions.md",
      ),
    ).toContain("discovery-runtime-design.md");
  });

  it("flow-new-feature threads the system-design paths behind the non-none Runtime design gate", () => {
    const skill = read("skills", "pipeline", "flow-new-feature", "SKILL.md");
    expect(skill).toMatch(
      /`### Runtime design`[^]*?not `none`[^]*?flow-module-status --skill-path flow-system-design/,
    );
  });

  it("bug-detection.md carries ## Durable Async Work in place of the retry-wrappers section", () => {
    const checklist = read(
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "checklists",
      "bug-detection.md",
    );
    expect(checklist).toMatch(/^## Durable Async Work$/m);
    expect(checklist).not.toContain(
      "## Retry Wrappers Around Non-Idempotent Operations",
    );
  });

  it("pattern-consistency.md flags a runtime surface against ### Runtime design", () => {
    expect(
      read(
        "skills",
        "pipeline",
        "flow-pr-review",
        "references",
        "checklists",
        "pattern-consistency.md",
      ),
    ).toContain("### Runtime design");
  });
});
