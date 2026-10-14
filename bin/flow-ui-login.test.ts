import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main, isLocalBaseUrl } from "./flow-ui-login";

const SENTINEL_USER = "sentinel-user@x";
const SENTINEL_PASS = "sentinel-pass-9f3";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-login-test-"));
}

function writeSentinelEnv(dir: string): void {
  fs.writeFileSync(
    path.join(dir, ".env"),
    `TEST_USER_EMAIL=${SENTINEL_USER}\nTEST_USER_PASSWORD=${SENTINEL_PASS}\n`,
  );
}

function writeManifest(
  dir: string,
  overrides: Record<string, unknown> = {},
): string {
  const manifestPath = path.join(dir, "ui-validation.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      loginUrl: "/login",
      credentialEnvVars: {
        user: "TEST_USER_EMAIL",
        pass: "TEST_USER_PASSWORD",
      },
      routes: [{ path: "/" }],
      ...overrides,
    }),
  );
  return manifestPath;
}

async function captureStdio(
  fn: () => Promise<number>,
): Promise<{ rc: number; stdout: string; stderr: string }> {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const rc = await fn();
    return { rc, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("flow-ui-login check", () => {
  it("exits 0 and reports presence + source with no sentinel on stdout/stderr", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    fs.writeFileSync(
      path.join(dir, ".env"),
      `TEST_USER_EMAIL=${SENTINEL_USER}\nTEST_USER_PASSWORD=${SENTINEL_PASS}\n`,
    );
    const { rc, stdout, stderr } = await captureStdio(() =>
      main(["check", "--manifest", manifestPath, "--worktree", dir]),
    );
    expect(rc).toBe(0);
    expect(stdout).not.toContain(SENTINEL_USER);
    expect(stdout).not.toContain(SENTINEL_PASS);
    expect(stderr).not.toContain(SENTINEL_USER);
    expect(stderr).not.toContain(SENTINEL_PASS);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.user).toEqual({
      name: "TEST_USER_EMAIL",
      present: true,
      source: ".env",
    });
  });

  it("exits 3 with present:false when credentials are absent", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    const { rc, stdout } = await captureStdio(() =>
      main(["check", "--manifest", manifestPath, "--worktree", dir]),
    );
    expect(rc).toBe(3);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.user.present).toBe(false);
    expect(parsed.pass.present).toBe(false);
  });
});

describe("flow-ui-login test-account", () => {
  const OTHER_SECRET = "unrelated-secret-zz1";

  it("prints exactly the two values and never an unrelated .env key", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    fs.appendFileSync(path.join(dir, ".env"), `OTHER_KEY=${OTHER_SECRET}\n`);
    const manifestPath = writeManifest(dir);
    const { rc, stdout, stderr } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      user: SENTINEL_USER,
      pass: SENTINEL_PASS,
    });
    expect(stdout).not.toContain(OTHER_SECRET);
    expect(stderr).not.toContain(OTHER_SECRET);
  });

  it("prefers .env.local over .env", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    fs.writeFileSync(
      path.join(dir, ".env.local"),
      "TEST_USER_EMAIL=local-user@x\nTEST_USER_PASSWORD=local-pass-1\n",
    );
    const manifestPath = writeManifest(dir);
    const { rc, stdout } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      user: "local-user@x",
      pass: "local-pass-1",
    });
  });

  it("exits 3 with names-only presence JSON when one var is missing", async () => {
    const dir = mkTmpDir();
    fs.writeFileSync(
      path.join(dir, ".env"),
      `TEST_USER_EMAIL=${SENTINEL_USER}\n`,
    );
    const manifestPath = writeManifest(dir);
    const { rc, stdout, stderr } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(3);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.user.present).toBe(true);
    expect(parsed.pass.present).toBe(false);
    expect(stdout).not.toContain(SENTINEL_USER);
    expect(stderr).not.toContain(SENTINEL_USER);
  });

  it("exits 2 non-local-base-url with no value for a non-local baseUrl", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const manifestPath = writeManifest(dir, {
      baseUrl: "https://staging.example.com",
    });
    const { rc, stdout, stderr } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      reason: "non-local-base-url",
    });
    expect(stdout + stderr).not.toContain(SENTINEL_PASS);
    expect(stdout + stderr).not.toContain(SENTINEL_USER);
  });

  it("exits 2 non-local-base-url for an absolute non-local loginUrl", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const manifestPath = writeManifest(dir, {
      loginUrl: "https://evil.example.com/login",
    });
    const { rc, stdout } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(2);
    expect(JSON.parse(stdout).reason).toBe("non-local-base-url");
    expect(stdout).not.toContain(SENTINEL_PASS);
  });

  it("accepts the {{PORT}} placeholder baseUrl", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const manifestPath = writeManifest(dir, {
      launch: "npm run dev -- --port {{PORT}}",
      baseUrl: "http://localhost:{{PORT}}",
    });
    const { rc, stdout } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("exits 2 (never falls back) for the bootstrap-draft manifest `check` accepts", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const manifestPath = path.join(dir, "ui-validation.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        credentialEnvVars: {
          user: "TEST_USER_EMAIL",
          pass: "TEST_USER_PASSWORD",
        },
      }),
    );
    const { rc, stdout } = await captureStdio(() =>
      main(["test-account", "--manifest", manifestPath, "--worktree", dir], {
        env: {},
      }),
    );
    expect(rc).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      reason: "no-credential-env-vars",
    });
    expect(stdout).not.toContain(SENTINEL_PASS);
  });

  it("exits 2 with usage when --manifest is missing", async () => {
    const { rc, stderr } = await captureStdio(() => main(["test-account"]));
    expect(rc).toBe(2);
    expect(stderr).toContain("test-account");
  });
});

describe("isLocalBaseUrl", () => {
  it.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:8080", true],
    ["http://localhost:{{PORT}}", true],
    ["http://localhost:{{PORT_WEB}}/app", true],
    ["http://0.0.0.0:3000", false],
    ["http://192.168.1.5:3000", false],
    ["http://localhost.evil.com", false],
    ["https://example.com", false],
    ["not a url", false],
    ["//localhost/login", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalBaseUrl(url)).toBe(expected);
  });
});

describe("flow-ui-login check — schema-invalid bootstrap-draft fallback", () => {
  it("exits 0 (not 2) for a manifest missing routes/launch but with valid credentialEnvVars", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const manifestPath = path.join(dir, "ui-validation.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        credentialEnvVars: {
          user: "TEST_USER_EMAIL",
          pass: "TEST_USER_PASSWORD",
        },
      }),
    );
    const { rc, stdout } = await captureStdio(() =>
      main(["check", "--manifest", manifestPath, "--worktree", dir]),
    );
    expect(rc).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("exits 2 with reason no-credential-env-vars for a valid manifest with no credentialEnvVars", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete raw.credentialEnvVars;
    fs.writeFileSync(manifestPath, JSON.stringify(raw));
    const { rc, stdout } = await captureStdio(() =>
      main(["check", "--manifest", manifestPath, "--worktree", dir]),
    );
    expect(rc).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      reason: "no-credential-env-vars",
    });
  });

  it("exits 2 when credentialEnvVars has non-string fields", async () => {
    const dir = mkTmpDir();
    const manifestPath = path.join(dir, "ui-validation.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ credentialEnvVars: { user: 1, pass: "X" } }),
    );
    const { rc } = await captureStdio(() =>
      main(["check", "--manifest", manifestPath, "--worktree", dir]),
    );
    expect(rc).toBe(2);
  });
});

describe("flow-ui-login.ts executable bit", () => {
  it("is executable on disk", () => {
    const scriptPath = path.join(__dirname, "flow-ui-login.ts");
    const mode = fs.statSync(scriptPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
