import { describe, expect, it } from "vitest";
import {
  FLOW_UI_LOGIN_ALLOW_RULES,
  SECRET_FILE_DENY_RULES,
} from "./secret-deny-rules";

describe("SECRET_FILE_DENY_RULES", () => {
  it("names every canonical + variant dotenv file, never a bare .env* glob", () => {
    for (const rule of SECRET_FILE_DENY_RULES) {
      expect(rule).toMatch(/^Read\(\/\/\*\*\/\.[\w.*-]+\)$/);
      expect(rule).not.toBe("Read(//**/.env*)");
    }
  });

  it("covers the Next/Vite canonical names and the common variant names", () => {
    for (const name of [
      ".env",
      ".env.local",
      ".env.*.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".env.staging",
      ".env.prod",
      ".env.dev",
      ".env.stage",
      ".env.preview",
      ".env.ci",
      ".env.qa",
      ".env.vault",
      ".env.keys",
      ".dev.vars",
      ".envrc",
    ]) {
      expect(SECRET_FILE_DENY_RULES).toContain(`Read(//**/${name})`);
    }
  });

  it("never denies an example/sample/template file", () => {
    for (const stillReadable of [
      ".env.example",
      ".env.sample",
      ".env.template",
    ]) {
      expect(
        SECRET_FILE_DENY_RULES.some((rule) => rule.includes(stillReadable)),
      ).toBe(false);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(SECRET_FILE_DENY_RULES).size).toBe(
      SECRET_FILE_DENY_RULES.length,
    );
  });
});

describe("FLOW_UI_LOGIN_ALLOW_RULES", () => {
  it("pre-approves only check and serve, never a blanket flow-ui-login *", () => {
    expect(FLOW_UI_LOGIN_ALLOW_RULES).toEqual([
      "Bash(flow-ui-login check *)",
      "Bash(flow-ui-login serve *)",
    ]);
  });
});
