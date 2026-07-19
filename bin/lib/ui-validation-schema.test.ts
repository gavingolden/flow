import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateUiValidationManifest } from "./ui-validation-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "ui-validation-schema.ts");

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
  const dir = mkdtempSync(path.join(tmpdir(), "ui-validation-schema-test-"));
  const filePath = path.join(dir, "ui-validation.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for the `.flow/ui-validation.json` manifest schema. The
 * manifest is the consumer-declared "how to launch + authenticate + which
 * routes" convention the browser-validation capability reads. These tests
 * pin the OBJECT shape (distinct from `.flow/pre-commit.json`'s array
 * shape), strict-on-shape / permissive-on-content semantics, and the
 * unknown-key tolerance the committed example stub relies on.
 */

const FULL_MANIFEST: unknown = {
  _comment: "copy to .flow/ui-validation.json and fill in",
  launch: "npm run dev",
  baseUrl: "http://localhost:5173",
  loginUrl: "/login",
  credentialEnvVars: { user: "TEST_USER_EMAIL", pass: "TEST_USER_PASSWORD" },
  env: {
    PORT: "5273",
    VITE_API_URL: "http://localhost:8090",
    CORS_ALLOWED_ORIGINS: "http://localhost:5273",
  },
  routes: [
    { path: "/", expectSelectors: ["main"] },
    { path: "/dashboard", expectSelectors: ['[data-testid="dashboard"]'] },
  ],
  disableAnimations: true,
};

const MINIMAL_MANIFEST: unknown = {
  launch: "npm run dev",
  baseUrl: "http://localhost:5173",
  routes: [{ path: "/" }],
};

describe("validateUiValidationManifest — happy paths", () => {
  it("accepts a fully-populated manifest", () => {
    expect(validateUiValidationManifest(FULL_MANIFEST).ok).toBe(true);
  });

  it("accepts a minimal required-only manifest (no loginUrl/creds/disableAnimations)", () => {
    expect(validateUiValidationManifest(MINIMAL_MANIFEST).ok).toBe(true);
  });

  it("tolerates an unknown _comment key (strict-on-shape, not no-extra-keys)", () => {
    const fixture = { ...(MINIMAL_MANIFEST as object), _comment: "doc" };
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("accepts a route with no expectSelectors", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.routes = [{ path: "/about" }];
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("accepts a string→string env map (FULL_MANIFEST carries one)", () => {
    expect(validateUiValidationManifest(FULL_MANIFEST).ok).toBe(true);
  });

  it("accepts an empty-string env value (values are config, not NAMES)", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.env = { OPTIONAL_FLAG: "" };
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("accepts ignoreConsolePatterns + ignoreRequestPatterns as string arrays", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.ignoreConsolePatterns = ["Failed to load resource"];
    fixture.ignoreRequestPatterns = ["/favicon.ico"];
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("accepts a manifest with no viewports (backward-compatible)", () => {
    // MINIMAL_MANIFEST has no viewports — the default is applied downstream.
    expect(validateUiValidationManifest(MINIMAL_MANIFEST).ok).toBe(true);
  });

  it("accepts a well-formed viewports array (name + width, optional height)", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.viewports = [
      { name: "xs", width: 320 },
      { name: "desktop", width: 1280, height: 1600 },
    ];
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("rejects an explicit empty viewports array (omit the key for the default set)", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.viewports = [];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("non-empty");
  });
});

describe("validateUiValidationManifest — {{PORT}} bidirectional invariant", () => {
  it("accepts {{PORT}} in both launch and baseUrl", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.launch = "PORT={{PORT}} npm run dev";
    fixture.baseUrl = "http://localhost:{{PORT}}";
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("accepts an env-only {{PORT}} (literal launch) paired with a {{PORT}} baseUrl", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.launch = "npm run dev";
    fixture.baseUrl = "http://localhost:{{PORT}}";
    fixture.env = { PORT: "{{PORT}}" };
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });

  it("rejects {{PORT}} in baseUrl when launch and env are all-literal", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.launch = "npm run dev";
    fixture.baseUrl = "http://localhost:{{PORT}}";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("{{PORT}}");
  });

  it("rejects {{PORT}} in launch when baseUrl is a literal port", () => {
    const fixture = structuredClone(MINIMAL_MANIFEST) as Record<
      string,
      unknown
    >;
    fixture.launch = "PORT={{PORT}} npm run dev";
    fixture.baseUrl = "http://localhost:5173";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("{{PORT}}");
  });

  it("accepts an all-literal manifest (pokemon 5190 shape, no {{PORT}} anywhere)", () => {
    const fixture = {
      launch: "npm run dev",
      baseUrl: "http://localhost:5190",
      routes: [{ path: "/" }],
    };
    expect(validateUiValidationManifest(fixture).ok).toBe(true);
  });
});

describe("validateUiValidationManifest — wrong-shape rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateUiValidationManifest(null).ok).toBe(false);
    expect(validateUiValidationManifest([]).ok).toBe(false);
    expect(validateUiValidationManifest("string").ok).toBe(false);
    expect(validateUiValidationManifest(42).ok).toBe(false);
  });

  it("rejects a manifest missing launch", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    delete fixture.launch;
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("launch");
  });

  it("rejects a manifest missing baseUrl", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    delete fixture.baseUrl;
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("baseUrl");
  });

  it("rejects a manifest where routes is not an array", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.routes = "not an array";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("routes");
  });

  it("rejects a route missing path", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.routes = [{ expectSelectors: ["main"] }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("path");
  });

  it("rejects a route whose expectSelectors is not a string[]", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.routes = [{ path: "/", expectSelectors: [1, 2, 3] }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("expectSelectors");
  });

  it("rejects loginUrl when present but not a non-empty string", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.loginUrl = 42;
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("loginUrl");
  });

  it("rejects credentialEnvVars when present but not an object", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.credentialEnvVars = "TEST_USER_EMAIL";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("credentialEnvVars");
  });

  it("rejects credentialEnvVars missing user", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.credentialEnvVars = { pass: "TEST_USER_PASSWORD" };
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("user");
  });

  it("rejects credentialEnvVars missing pass", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.credentialEnvVars = { user: "TEST_USER_EMAIL" };
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("pass");
  });

  it("rejects env when present but not an object", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.env = "PORT=5273";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("env");
  });

  it("rejects env with a non-string value", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.env = { PORT: 3000 };
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("env");
  });

  it("rejects disableAnimations when not a boolean", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.disableAnimations = "yes";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("disableAnimations");
  });

  it("rejects ignoreConsolePatterns when not an array", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.ignoreConsolePatterns = "Failed to load resource";
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ignoreConsolePatterns");
  });

  it("rejects ignoreRequestPatterns when an array of non-strings", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.ignoreRequestPatterns = [1, 2, 3];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ignoreRequestPatterns");
  });

  it("rejects viewports when not an array", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = { name: "xs", width: 320 };
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("viewports");
  });

  it("rejects a viewport entry that is not an object", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = ["xs"];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("viewports[0]");
  });

  it("rejects a viewport with an empty/missing name", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = [{ width: 320 }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("name");
  });

  it("rejects a viewport with a missing width", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = [{ name: "xs" }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("width");
  });

  it("rejects a viewport with a non-numeric width", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = [{ name: "xs", width: "320" }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("width");
  });

  it("rejects a viewport with a non-positive width", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = [{ name: "xs", width: 0 }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("width");
  });

  it("rejects a viewport with a non-positive height", () => {
    const fixture = structuredClone(FULL_MANIFEST) as Record<string, unknown>;
    fixture.viewports = [{ name: "xs", width: 320, height: -1 }];
    const result = validateUiValidationManifest(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("height");
  });
});

describe("ui-validation-schema CLI — `--validate <path>`", () => {
  it("exits 2 with usage on stderr when --validate is missing", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });

  it("exits 2 with usage when --validate has no path argument", () => {
    const result = runCli(["--validate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("exits 1 with read failure when the path does not exist", () => {
    const missingPath = path.join(
      tmpdir(),
      "no-such-ui-manifest-" + Date.now() + ".json",
    );
    const result = runCli(["--validate", missingPath]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("read failed");
  });

  it("exits 1 with JSON parse failure on malformed JSON", () => {
    withTmpFile("{ not valid json", (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("JSON parse failed");
    });
  });

  it("exits 1 with a schema reason on shape-invalid JSON", () => {
    withTmpFile(JSON.stringify({ baseUrl: "x", routes: [] }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("launch");
    });
  });

  it("exits 0 with {ok: true} for a well-formed manifest", () => {
    withTmpFile(JSON.stringify(FULL_MANIFEST), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(result.stderr).toBe("");
    });
  });
});
