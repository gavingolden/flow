import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lint: no skill, reference, template, agent or helper names an agy model.
 *
 * WHY: `DELEGATE_MODEL_DEFAULTS` in `bin/lib/delegate-models.ts` is the one
 * table that decides every step's model. A display name copied into a skill
 * snippet or a helper comment is a second source of truth that drifts the
 * day a default flips. Docs name the step and its config key (for example
 * `delegate.models.researchGather`) and point at `flow config`, never a model.
 *
 * Scanned: skills/, references/, templates/, agents/ (every file) and
 * bin/**\/*.ts excluding *.test.ts, fixtures and bin/lib/delegate-models.ts.
 *
 * Deliberately out of scope: docs/ (docs/configuration.md's table is
 * test-bound to the code, and eval records name what they measured) and
 * evals/.
 */

const MODEL_NAME_RE =
  /(Claude (Opus|Sonnet|Haiku|Fable) [0-9.]+|GPT-OSS [0-9]+B|Gemini [0-9.]+ [A-Za-z]+) \((Low|Medium|High|Thinking)\)/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE_FILE = path.join("bin", "lib", "delegate-models.ts");

function listFiles(root: string, rel: string, binOnly: boolean): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) =>
      path.relative(root, path.join(d.parentPath ?? d.path ?? "", d.name)),
    )
    .filter((f) => {
      if (!binOnly) return true;
      const parts = f.split(path.sep);
      return (
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !parts.includes("fixtures") &&
        !parts.includes("__fixtures__") &&
        f !== TABLE_FILE
      );
    });
}

export function findModelNameLiterals(
  root: string,
): Array<{ file: string; line: number; text: string }> {
  const files = [
    ...["skills", "references", "templates", "agents"].flatMap((d) =>
      listFiles(root, d, false),
    ),
    ...listFiles(root, "bin", true),
  ].sort();
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (MODEL_NAME_RE.test(text)) {
        hits.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

describe("model-name literal lint", () => {
  it("finds no model display name outside the defaults table", () => {
    const hits = findModelNameLiterals(ROOT);
    expect(
      hits.map((h) => `${h.file}:${h.line}: ${h.text}`),
      "name the step and its delegate.models.<surface> key instead of a model; the table in bin/lib/delegate-models.ts decides the model",
    ).toEqual([]);
  });

  it("would fail on a reintroduced literal", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-lint-"));
    try {
      fs.mkdirSync(path.join(tmp, "skills", "x"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "skills", "x", "SKILL.md"),
        "ok line\nuse `Gemini 4 Carbon (Medium)` here\n",
      );
      expect(findModelNameLiterals(tmp)).toEqual([
        {
          file: path.join("skills", "x", "SKILL.md"),
          line: 2,
          text: "use `Gemini 4 Carbon (Medium)` here",
        },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
