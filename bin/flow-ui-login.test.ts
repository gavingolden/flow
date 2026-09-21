import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { main, buildServeChildArgs } from "./flow-ui-login";
import type { SpawnChildFn } from "./flow-ui-login";
import { resolveCredentials } from "./lib/ui-credentials";
import { startCredentialServer } from "./lib/ui-credential-server";
import type { CredentialServerHandle } from "./lib/ui-credential-server";

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

/**
 * Node's built-in `fetch` (undici) always sends `Sec-Fetch-Mode: cors` on a
 * cross-origin request and offers no way to omit it, so the
 * missing-header 403 case needs a raw `node:http` request instead.
 */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

function writeManifest(dir: string): string {
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

/**
 * Fakes the detached `__serve-child` process in-process: re-resolves the
 * credential values from the same NAMES/worktree/env the real child would
 * receive on its argv, then starts the real `startCredentialServer` and
 * reports the port back the same way the real child does — a tmp file.
 * This exercises `main`'s serve-side plumbing (port-file poll, fillScript
 * shape) without spawning a real OS subprocess.
 */
function fakeSpawnChild(handles: CredentialServerHandle[]): SpawnChildFn {
  return (opts) => {
    (async () => {
      const resolved = resolveCredentials(
        { user: opts.userName, pass: opts.passName },
        { worktree: opts.worktree, env: {} },
      );
      if (!resolved.values) return;
      const handle = await startCredentialServer({
        values: resolved.values,
        token: opts.token,
        origin: opts.origin,
        ttlMs: opts.ttlMs,
      });
      handles.push(handle);
      fs.writeFileSync(opts.portFilePath, String(handle.port));
    })();
  };
}

describe("flow-ui-login serve", () => {
  let handles: CredentialServerHandle[];

  beforeEach(() => {
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) handle.stop();
  });

  it("exit 3 with presence JSON when credentials missing (no child spawned)", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    let spawned = false;
    const { rc, stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        {
          spawnChild: () => {
            spawned = true;
          },
        },
      ),
    );
    expect(rc).toBe(3);
    expect(spawned).toBe(false);
    expect(JSON.parse(stdout).ok).toBe(false);
  });

  it("serves the values once, then 410s, and the fillScript carries no sentinel", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { rc, stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {} },
      ),
    );
    expect(rc).toBe(0);
    expect(stdout).not.toContain(SENTINEL_USER);
    expect(stdout).not.toContain(SENTINEL_PASS);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.port).toBe("number");
    expect(parsed.expiresInSec).toBe(90);
    expect(parsed.fillScript).not.toContain(SENTINEL_USER);
    expect(parsed.fillScript).not.toContain(SENTINEL_PASS);

    const url = parsed.fillScript.match(
      /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/,
    )[0];
    const first = await fetch(url, {
      headers: { Origin: "http://localhost:5173", "Sec-Fetch-Mode": "cors" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    const body = await first.json();
    expect(body).toEqual({ user: SENTINEL_USER, pass: SENTINEL_PASS });

    const second = await fetch(url, {
      headers: { Origin: "http://localhost:5173", "Sec-Fetch-Mode": "cors" },
    });
    expect(second.status).toBe(410);
  });

  it("404s a wrong token", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {} },
      ),
    );
    const parsed = JSON.parse(stdout);
    const res = await fetch(`http://127.0.0.1:${parsed.port}/wrong-token`, {
      headers: { Origin: "http://localhost:5173", "Sec-Fetch-Mode": "cors" },
    });
    expect(res.status).toBe(404);
  });

  it("403s a wrong origin", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {} },
      ),
    );
    const parsed = JSON.parse(stdout);
    const url = parsed.fillScript.match(
      /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/,
    )[0];
    const res = await fetch(url, {
      headers: { Origin: "http://evil.example", "Sec-Fetch-Mode": "cors" },
    });
    expect(res.status).toBe(403);
  });

  it("403s a missing Sec-Fetch-Mode: cors", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {} },
      ),
    );
    const parsed = JSON.parse(stdout);
    const url = parsed.fillScript.match(
      /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/,
    )[0];
    const res = await rawGet(url, { Origin: "http://localhost:5173" });
    expect(res.status).toBe(403);
  });

  it("accepts a loopback alias origin (127.0.0.1 <-> localhost)", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {} },
      ),
    );
    const parsed = JSON.parse(stdout);
    const url = parsed.fillScript.match(
      /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/,
    )[0];
    const res = await fetch(url, {
      headers: { Origin: "http://127.0.0.1:5173", "Sec-Fetch-Mode": "cors" },
    });
    expect(res.status).toBe(200);
  });

  it("the endpoint expires on its own with a short injected ttlMs", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        { spawnChild: fakeSpawnChild(handles), env: {}, ttlMs: 100 },
      ),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.expiresInSec).toBe(0);
    const url = parsed.fillScript.match(
      /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/,
    )[0];
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      fetch(url, {
        headers: { Origin: "http://localhost:5173", "Sec-Fetch-Mode": "cors" },
      }),
    ).rejects.toThrow();
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

describe("flow-ui-login serve — rejects a schema-invalid manifest", () => {
  it("exits 2 (never falls back) for the same bootstrap-draft manifest `check` accepts", async () => {
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
    let spawned = false;
    const { rc, stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        {
          spawnChild: () => {
            spawned = true;
          },
        },
      ),
    );
    expect(rc).toBe(2);
    expect(spawned).toBe(false);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      reason: "no-credential-env-vars",
    });
  });
});

describe("flow-ui-login __serve-child (real child argv path)", () => {
  it("buildServeChildArgs + __serve-child serves values end-to-end with no OS subprocess", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const portFilePath = path.join(dir, "port.txt");
    const token = "a".repeat(32);
    const args = buildServeChildArgs({
      scriptPath: "unused-in-test",
      userName: "TEST_USER_EMAIL",
      passName: "TEST_USER_PASSWORD",
      token,
      origin: "http://localhost:5173",
      worktree: dir,
      ttlMs: 5000,
      portFilePath,
    });
    expect(args).not.toContain("--token");
    expect(args).not.toContain(token);
    const childRest = args.slice(2); // drop scriptPath + "__serve-child"

    const childPromise = main(["__serve-child", ...childRest], {
      env: { ...process.env, FLOW_UI_LOGIN_TOKEN: token },
    });

    const start = Date.now();
    while (!fs.existsSync(portFilePath) && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(portFilePath)).toBe(true);
    const port = Number(fs.readFileSync(portFilePath, "utf8").trim());

    const res = await fetch(`http://127.0.0.1:${port}/${token}`, {
      headers: { Origin: "http://localhost:5173", "Sec-Fetch-Mode": "cors" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ user: SENTINEL_USER, pass: SENTINEL_PASS });

    expect(await childPromise).toBe(0);
  });

  it("returns exit 2 when FLOW_UI_LOGIN_TOKEN is absent from the child's env", async () => {
    const dir = mkTmpDir();
    writeSentinelEnv(dir);
    const portFilePath = path.join(dir, "port.txt");
    const args = buildServeChildArgs({
      scriptPath: "unused-in-test",
      userName: "TEST_USER_EMAIL",
      passName: "TEST_USER_PASSWORD",
      token: "irrelevant",
      origin: "http://localhost:5173",
      worktree: dir,
      ttlMs: 5000,
      portFilePath,
    });
    const childRest = args.slice(2);
    const envWithoutToken = { ...process.env };
    delete envWithoutToken.FLOW_UI_LOGIN_TOKEN;
    const rc = await main(["__serve-child", ...childRest], {
      env: envWithoutToken,
    });
    expect(rc).toBe(2);
  });
});

describe("flow-ui-login serve — child timeout", () => {
  it("exits 4 with a structured {ok:false} result when the child never reports its port", async () => {
    const dir = mkTmpDir();
    const manifestPath = writeManifest(dir);
    writeSentinelEnv(dir);
    const { rc, stdout } = await captureStdio(() =>
      main(
        [
          "serve",
          "--manifest",
          manifestPath,
          "--origin",
          "http://localhost:5173",
          "--worktree",
          dir,
        ],
        {
          spawnChild: () => {
            // Never writes the port file — simulates a child that dies or
            // never binds.
          },
        },
      ),
    );
    expect(rc).toBe(4);
    expect(JSON.parse(stdout)).toEqual({ ok: false, reason: "serve-timeout" });
  }, 10000);
});

describe("flow-ui-login.ts executable bit", () => {
  it("is executable on disk", () => {
    const scriptPath = path.join(__dirname, "flow-ui-login.ts");
    const mode = fs.statSync(scriptPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
