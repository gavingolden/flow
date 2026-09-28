import { describe, expect, it } from "vitest";
import { redactForPublish, redactSecrets } from "./redact-secrets";

describe("redactSecrets", () => {
  it("returns empty/falsy input unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("masks a Bearer token", () => {
    expect(redactSecrets("Authorization: Bearer abc123XYZ")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("masks a key=value assignment, keeping the key name", () => {
    expect(redactSecrets("api_key=sk-abcdef1234567890")).toBe(
      "api_key=[REDACTED]",
    );
    expect(redactSecrets("token: ghp_abcdefghijklmnop")).toBe(
      "token: [REDACTED]",
    );
    expect(redactSecrets("password=hunter2extra")).toBe("password=[REDACTED]");
  });

  it("masks an underscore-prefixed env-var-shaped key=value assignment", () => {
    // \b never matches between `_` (a \w char) and the following letter, so
    // a bare \b anchor silently never engages on these — the common shape
    // for env-var-style credential names.
    expect(redactSecrets("GITHUB_TOKEN=hunter2secretpw")).toBe(
      "GITHUB_TOKEN=[REDACTED]",
    );
    expect(redactSecrets("client_secret=abc123def456")).toBe(
      "client_secret=[REDACTED]",
    );
    expect(redactSecrets("access_token: 0123456789abcdef")).toBe(
      "access_token: [REDACTED]",
    );
  });

  it("masks a Basic auth header alongside Bearer", () => {
    expect(
      redactSecrets(
        "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw",
      ),
    ).toBe("Authorization: [REDACTED]");
  });

  it("masks a standard-base64 opaque run (with +, /, = padding)", () => {
    // The canonical AWS secret access key shape: standard base64, not
    // base64url — a base64url-only character class fragments this at every
    // `+`/`/`, and each fragment then falls under the 32-char floor.
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(redactSecrets(`aws_secret=${secret}`)).toBe("aws_secret=[REDACTED]");
  });

  it("masks a standalone opaque 32+ char run", () => {
    const opaque = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    expect(opaque.length).toBeGreaterThanOrEqual(32);
    expect(redactSecrets(`trace=${opaque}`)).toBe("trace=[REDACTED]");
  });

  it("does NOT mask a 40-char hex git SHA", () => {
    const sha = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
    expect(redactSecrets(`commit ${sha} failed`)).toBe(`commit ${sha} failed`);
  });

  it("does NOT mask a canonical UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(redactSecrets(`trace id ${uuid}`)).toBe(`trace id ${uuid}`);
  });

  it("does not mask short strings under the 32-char floor", () => {
    expect(redactSecrets("short-token-1234")).toBe("short-token-1234");
  });

  it("never throws on arbitrary input", () => {
    expect(() => redactSecrets("\0\n\t weird   bytes")).not.toThrow();
  });
});

describe("redactForPublish", () => {
  const GHP = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  const ANT = `sk-ant-api03-${"aB3dE6gH9j".repeat(4)}`;

  it.each([
    "at /Users/me/code/flow-evidence-redact/bin/lib/redact-secrets.ts:45:3",
    "✓ bin/lib/claude-headless-subprocess-environment.test.ts (12 tests)",
    "in skills/pipeline/flow-pipeline/references/pause-output-contract.md",
    "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
    "123e4567-e89b-12d3-a456-426614174000",
    "compat=true",
    "✓ parser > handles basic input (2ms)",
    "ends with Basic\nnext line",
    "sk-learn",
    "task-runner-configuration-for-long-hyphenated-names",
  ])("leaves %s unchanged", (s) => {
    expect(redactForPublish(s)).toBe(s);
  });

  it("masks a Bearer header", () => {
    expect(redactForPublish("Authorization: Bearer abc123")).not.toContain(
      "abc123",
    );
  });

  it("masks GITHUB_TOKEN but keeps the key", () => {
    const out = redactForPublish(`GITHUB_TOKEN=${GHP}`);
    expect(out).toBe("GITHUB_TOKEN=[REDACTED]");
  });

  it("masks an AWS secret access key assignment", () => {
    const out = redactForPublish(
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(out).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED]");
  });

  it.each([
    ["bare ghp_", `see ${GHP} end`],
    ["sk-ant", `key ${ANT} end`],
    ["AWS access key id", "id AKIAIOSFODNN7EXAMPLE end"],
    [
      "JWT",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N end",
    ],
  ])("masks %s", (_n, s) => {
    const out = redactForPublish(s);
    expect(out).toContain("[REDACTED]");
    expect(out.endsWith(" end")).toBe(true);
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|eyJ/);
  });

  it("masks Authorization Basic/Bearer and token-shaped Bearer values", () => {
    expect(redactForPublish("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redactForPublish("got Bearer abcdefghijklmnop1234 here")).toBe(
      "got [REDACTED] here",
    );
  });

  it("masks the password in a connection URL", () => {
    expect(
      redactForPublish("DATABASE_URL=postgres://admin:s3cr3t@db:5432/app"),
    ).toBe("DATABASE_URL=postgres://admin:[REDACTED]@db:5432/app");
    expect(redactForPublish("clone https://user:tok@github.com/x done")).toBe(
      "clone https://user:[REDACTED]@github.com/x done",
    );
  });

  it.each([
    ["github_pat", `pat github_pat_${"A1b2C3d4E5".repeat(3)} end`],
    ["slack", "s xoxb-1234567890-abcdefABCDEF end"],
    ["gitlab", `g glpat-${"aB3dE6gH9j".repeat(2)}xy end`],
    ["google", `k AIza${"aB3dE6gH9j".repeat(3)}abcde end`],
  ])("masks vendor token %s", (_n, s) => {
    const out = redactForPublish(s);
    expect(out).toContain("[REDACTED]");
    expect(out.endsWith(" end")).toBe(true);
    expect(out).not.toMatch(/github_pat|xox|glpat|AIza/);
  });

  it("masks PASSWORD, passwd, credentials and the JSON forms, keeping JSON well-formed", () => {
    expect(redactForPublish("DB_PASSWORD=hunter2")).toBe(
      "DB_PASSWORD=[REDACTED]",
    );
    expect(redactForPublish("passwd=hunter2")).toBe("passwd=[REDACTED]");
    expect(redactForPublish("credentials: hunter2")).toBe(
      "credentials: [REDACTED]",
    );
    expect(redactForPublish('{"client_secret": "abc"}')).toBe(
      '{"client_secret": "[REDACTED]"}',
    );
    expect(redactForPublish('{"api_key":"abc"}')).toBe(
      '{"api_key":"[REDACTED]"}',
    );
    expect(redactForPublish("api_key=abc, next=1")).toBe(
      "api_key=[REDACTED], next=1",
    );
  });

  it("opaque-run fallback masks a bare mixed-case base64 blob", () => {
    const out = redactForPublish(
      "blob Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo end",
    );
    expect(out).toBe("blob [REDACTED] end");
  });

  it("masks a slash-bearing base64 secret without a KEY= prefix", () => {
    const out = redactForPublish(
      "v wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end",
    );
    expect(out).not.toContain("wJalr");
  });

  it("completes quickly on a 200k-char unbroken run", () => {
    const start = Date.now();
    redactForPublish("a".repeat(200_000));
    redactForPublish("A1".repeat(100_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("masks a token embedded in a path", () => {
    expect(redactForPublish(`/api/${GHP}`)).toBe("/api/[REDACTED]");
  });

  it("masks a hyphen-joined vendor token", () => {
    expect(redactForPublish(`x-${ANT}`)).toBe("x-[REDACTED]");
  });

  it("masks the value of TOKEN=<path>", () => {
    expect(redactForPublish("TOKEN=bin/lib/x.ts")).toBe("TOKEN=[REDACTED]");
  });

  it("is a no-op on empty input", () => {
    expect(redactForPublish("")).toBe("");
  });
});
