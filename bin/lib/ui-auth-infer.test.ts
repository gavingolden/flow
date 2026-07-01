import { describe, expect, it } from "vitest";
import { inferAuth } from "./ui-auth-infer";

const ENV_EXAMPLE = [
  "# app config",
  "DATABASE_URL=",
  "TEST_USER_EMAIL=",
  "TEST_USER_PASSWORD=",
  "PUBLIC_API_URL=",
].join("\n");

// A POPULATED .env with real VALUES — used to prove no VALUE ever leaks.
const ENV_POPULATED = [
  "TEST_USER_EMAIL=alice@example.com",
  "TEST_USER_PASSWORD=hunter2-s3cret",
  "DATABASE_URL=postgres://user:pw@localhost/db",
].join("\n");

describe("inferAuth — Story 4", () => {
  it("surfaces credential NAMES from .env.example", () => {
    const out = inferAuth({ routes: ["/login"], envExampleText: ENV_EXAMPLE });
    expect(out.credentialEnvVars).toEqual({
      user: "TEST_USER_EMAIL",
      pass: "TEST_USER_PASSWORD",
    });
  });

  it("picks /login as the loginUrl when present", () => {
    const out = inferAuth({
      routes: ["/", "/dashboard", "/login"],
      envExampleText: ENV_EXAMPLE,
    });
    expect(out.loginUrl).toBe("/login");
  });

  it("falls back to /auth when no /login route exists", () => {
    const out = inferAuth({ routes: ["/", "/auth"] });
    expect(out.loginUrl).toBe("/auth");
  });

  it("omits loginUrl when no login-ish route exists", () => {
    const out = inferAuth({ routes: ["/", "/dashboard"] });
    expect(out.loginUrl).toBeUndefined();
  });

  it("omits credentialEnvVars when only one of user/pass is present", () => {
    const out = inferAuth({
      routes: ["/login"],
      envExampleText: "TEST_USER_EMAIL=\n",
    });
    expect(out.credentialEnvVars).toBeUndefined();
  });

  it("prefers TEST_/E2E_ prefixed names over incidental config", () => {
    const env = [
      "ADMIN_EMAIL=",
      "ADMIN_PASSWORD=",
      "E2E_USER_EMAIL=",
      "E2E_USER_PASSWORD=",
    ].join("\n");
    const out = inferAuth({ routes: ["/login"], envExampleText: env });
    expect(out.credentialEnvVars).toEqual({
      user: "E2E_USER_EMAIL",
      pass: "E2E_USER_PASSWORD",
    });
  });

  it("GUARDRAIL: no VALUE from a populated .env appears anywhere in the output", () => {
    const out = inferAuth({
      routes: ["/login"],
      envExampleText: ENV_EXAMPLE,
      envText: ENV_POPULATED,
    });
    // Deep-serialize the whole output and assert no secret VALUE substring.
    const serialized = JSON.stringify(out);
    for (const value of [
      "alice@example.com",
      "hunter2-s3cret",
      "postgres://user:pw@localhost/db",
    ]) {
      expect(serialized).not.toContain(value);
    }
    // The NAMES still surface (from either file).
    expect(out.credentialEnvVars).toEqual({
      user: "TEST_USER_EMAIL",
      pass: "TEST_USER_PASSWORD",
    });
  });

  it("mines NAMES from .env alone (names-only) when no example is supplied", () => {
    const out = inferAuth({ routes: ["/login"], envText: ENV_POPULATED });
    expect(out.credentialEnvVars).toEqual({
      user: "TEST_USER_EMAIL",
      pass: "TEST_USER_PASSWORD",
    });
    expect(JSON.stringify(out)).not.toContain("hunter2-s3cret");
  });
});
