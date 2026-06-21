import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isEpicManifest, validateEpicManifest } from "./epic-manifest-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "epic-manifest-schema.ts");

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "epic-manifest-schema-test-"));
  const filePath = path.join(dir, "manifest.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the epic-designer layer's manifest at
 * `.flow/epics/<slug>/manifest.json`. This module owns the `EpicManifest`
 * shape; the tests pin the strict-on-shape / permissive-on-content policy
 * (non-empty required strings, type-only optional checks, forward-compat on
 * unknown flowNewHints keys) plus the `--validate <path>` CLI contract.
 */

const VALID_FULL: unknown = {
  epicId: "epic-checkout-redesign",
  prompt: "Redesign the checkout flow end to end",
  createdAt: "2026-06-21T00:00:00Z",
  features: [
    {
      id: "F1",
      title: "Cart summary panel",
      description: "Render the cart summary with line-item totals",
      dependsOn: [],
      rationale: "Users need to confirm contents before paying",
      acceptanceCriteria: ["totals match server", "empty cart shows CTA"],
      flowNewHints: {
        autoMerge: true,
        copilotReview: "always",
        effort: "high",
      },
      mvp: true,
    },
    {
      id: "F2",
      title: "Payment step",
      description: "Collect and validate payment details",
      dependsOn: ["F1"],
    },
  ],
};

const VALID_MINIMAL: unknown = {
  epicId: "epic-minimal",
  prompt: "Minimal epic",
  createdAt: "2026-06-21",
  features: [],
};

describe("validateEpicManifest / isEpicManifest — happy paths", () => {
  it("accepts a fully-populated valid manifest", () => {
    expect(validateEpicManifest(VALID_FULL).ok).toBe(true);
    expect(isEpicManifest(VALID_FULL)).toBe(true);
  });

  it("accepts a minimal valid manifest (required-only, empty features)", () => {
    expect(validateEpicManifest(VALID_MINIMAL).ok).toBe(true);
    expect(isEpicManifest(VALID_MINIMAL)).toBe(true);
  });

  it("accepts an empty dependsOn on a feature", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.features as Array<Record<string, unknown>>)[1].dependsOn = [];
    expect(validateEpicManifest(fixture).ok).toBe(true);
  });
});

describe("validateEpicManifest — required-key omissions", () => {
  it.each(["epicId", "prompt", "createdAt", "features"])(
    "rejects a manifest missing the '%s' top-level key",
    (key) => {
      const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
      delete fixture[key];
      const result = validateEpicManifest(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(key);
      }
    },
  );

  it.each(["id", "title", "description", "dependsOn"])(
    "rejects a feature missing the '%s' key",
    (key) => {
      const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
      delete (fixture.features as Array<Record<string, unknown>>)[0][key];
      const result = validateEpicManifest(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(key);
      }
    },
  );
});

describe("validateEpicManifest — wrong-type rejections", () => {
  it("rejects non-object input", () => {
    expect(validateEpicManifest(null).ok).toBe(false);
    expect(validateEpicManifest([]).ok).toBe(false);
    expect(validateEpicManifest("string").ok).toBe(false);
    expect(validateEpicManifest(42).ok).toBe(false);
  });

  it("rejects features when it is not an array", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.features = "not an array";
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("features");
  });

  it("rejects a features[] entry that is not an object", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.features as unknown[])[0] = "not an object";
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("features[0]");
  });

  it("rejects a dependsOn entry that is not a string", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.features as Array<Record<string, unknown>>)[1].dependsOn = [42];
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("dependsOn[0]");
      expect(result.reason).toContain("must be a string");
    }
  });

  it("rejects flowNewHints.copilotReview off-enum", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (
      (fixture.features as Array<Record<string, unknown>>)[0]
        .flowNewHints as Record<string, unknown>
    ).copilotReview = "sometimes";
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("copilotReview");
  });

  it("rejects flowNewHints.effort with an invalid level", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (
      (fixture.features as Array<Record<string, unknown>>)[0]
        .flowNewHints as Record<string, unknown>
    ).effort = "turbo";
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("effort");
  });

  it("rejects a non-boolean mvp when present", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (fixture.features as Array<Record<string, unknown>>)[0].mvp = "yes";
    const result = validateEpicManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mvp");
  });
});

describe("validateEpicManifest — optional-field acceptance", () => {
  it("accepts a feature with rationale/acceptanceCriteria/flowNewHints/mvp all omitted", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    const f = (fixture.features as Array<Record<string, unknown>>)[0];
    delete f.rationale;
    delete f.acceptanceCriteria;
    delete f.flowNewHints;
    delete f.mvp;
    expect(validateEpicManifest(fixture).ok).toBe(true);
  });

  it("accepts flowNewHints with an unknown extra key (forward-compat)", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    (
      (fixture.features as Array<Record<string, unknown>>)[0]
        .flowNewHints as Record<string, unknown>
    ).futureKnob = "experimental";
    expect(validateEpicManifest(fixture).ok).toBe(true);
  });

  it("accepts an empty features array", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    fixture.features = [];
    expect(validateEpicManifest(fixture).ok).toBe(true);
  });
});

describe("epic-manifest-schema CLI — `--validate <path>`", () => {
  it("exits 2 with usage on stderr when --validate flag is missing", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("exits 1 with read failure on stderr when the target path does not exist", () => {
    const missingPath = path.join(
      tmpdir(),
      "epic-manifest-missing-" + Date.now() + ".json",
    );
    const result = runCli(["--validate", missingPath]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("read failed");
    expect(parsed.path).toBe(missingPath);
  });

  it("exits 1 with JSON parse failure on stderr when the file contains malformed JSON", () => {
    withTmpFile("{ not valid json", (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("JSON parse failed");
      expect(parsed.path).toBe(filePath);
    });
  });

  it("exits 0 with {ok: true} on stdout for a well-formed manifest file", () => {
    withTmpFile(JSON.stringify(VALID_FULL), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });

  it("exits 1 with {ok: false} + path on stderr for a malformed manifest file", () => {
    const fixture = structuredClone(VALID_FULL) as Record<string, unknown>;
    delete fixture.epicId;
    withTmpFile(JSON.stringify(fixture), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.path).toBe(filePath);
    });
  });
});
