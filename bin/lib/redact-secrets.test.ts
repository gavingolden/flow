import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets";

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
