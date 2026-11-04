import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isLocalLoginUrl,
  MANIFEST_REL,
  resolveTestAccount,
} from "./ui-test-account";

let dir!: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-ta-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function manifest(over: Record<string, unknown> = {}): string {
  const p = path.join(dir, MANIFEST_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      loginUrl: "/login",
      credentialEnvVars: {
        user: "TEST_USER_EMAIL",
        pass: "TEST_USER_PASSWORD",
      },
      routes: [{ path: "/" }],
      ...over,
    }),
  );
  return p;
}
const ENV = { TEST_USER_EMAIL: "u@x", TEST_USER_PASSWORD: "p-9f3" };
const committed = () => true;

describe("resolveTestAccount", () => {
  it("resolves both values from a committed local manifest", () => {
    const r = resolveTestAccount({
      manifest: manifest(),
      worktree: dir,
      env: ENV,
      isManifestCommitted: committed,
    });
    expect(r).toEqual({
      ok: true,
      values: { user: "u@x", pass: "p-9f3" },
      baseUrl: "http://localhost:5173",
    });
  });

  it("refuses a manifest outside the worktree without touching credentials", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ui-ta-other-"));
    try {
      const p = path.join(other, "m.json");
      fs.writeFileSync(p, "{}");
      const r = resolveTestAccount({
        manifest: p,
        worktree: dir,
        env: ENV,
        isManifestCommitted: committed,
      });
      expect(r).toEqual({ ok: false, reason: "manifest-not-in-worktree" });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses an uncommitted or modified manifest", () => {
    const r = resolveTestAccount({
      manifest: manifest(),
      worktree: dir,
      env: ENV,
      isManifestCommitted: () => false,
    });
    expect(r).toEqual({ ok: false, reason: "manifest-not-committed" });
  });

  it("refuses a non-localhost base url or login url, with no value in the result", () => {
    for (const over of [
      { baseUrl: "https://app.example.com" },
      { loginUrl: "https://evil.example.com/login" },
    ]) {
      const r = resolveTestAccount({
        manifest: manifest(over),
        worktree: dir,
        env: ENV,
        isManifestCommitted: committed,
      });
      expect(r).toEqual({ ok: false, reason: "non-local-base-url" });
      expect(JSON.stringify(r)).not.toContain("p-9f3");
    }
  });

  it("refuses a manifest without credentialEnvVars", () => {
    const r = resolveTestAccount({
      manifest: manifest({ credentialEnvVars: undefined }),
      worktree: dir,
      env: ENV,
      isManifestCommitted: committed,
    });
    expect(r).toMatchObject({ ok: false, reason: "no-credential-env-vars" });
  });

  it("reports presence only when a value is missing", () => {
    const r = resolveTestAccount({
      manifest: manifest(),
      worktree: dir,
      env: { TEST_USER_EMAIL: "u@x" },
      isManifestCommitted: committed,
    });
    expect(r).toMatchObject({ ok: false, reason: "credentials-missing" });
    expect(JSON.stringify(r)).not.toContain("u@x");
  });
});

describe("isLocalLoginUrl", () => {
  it("resolves a protocol-relative url the way a browser would", () => {
    expect(isLocalLoginUrl("http://localhost:5173", "//evil.com/x")).toBe(
      false,
    );
    expect(isLocalLoginUrl("http://localhost:5173", "/login")).toBe(true);
  });
});
