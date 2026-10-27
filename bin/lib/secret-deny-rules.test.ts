import { describe, expect, it } from "vitest";
import {
  EPIC_GRANT_DENY_RULES,
  FLOW_CREATE_ISSUE_ALLOW_RULES,
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
  it("pre-approves only check and test-account, never a blanket flow-ui-login *", () => {
    expect(FLOW_UI_LOGIN_ALLOW_RULES).toEqual([
      "Bash(flow-ui-login check *)",
      "Bash(flow-ui-login test-account *)",
    ]);
  });
});

describe("FLOW_CREATE_ISSUE_ALLOW_RULES", () => {
  it("pre-approves the standalone flow-create-issue call", () => {
    expect(FLOW_CREATE_ISSUE_ALLOW_RULES).toEqual([
      "Bash(flow-create-issue *)",
    ]);
  });
});

describe("EPIC_GRANT_DENY_RULES", () => {
  it("denies the high-autonomy grant in space and equals forms", () => {
    expect(EPIC_GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant * --autonomy high*)",
    );
    expect(EPIC_GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant * --autonomy=high*)",
    );
  });

  it("denies the flag-first grant form", () => {
    expect(EPIC_GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant --autonomy high*)",
    );
  });

  it("denies an env-wrapped grant and shell writes naming grant.json", () => {
    expect(EPIC_GRANT_DENY_RULES).toContain("Bash(env * flow epic grant *)");
    expect(EPIC_GRANT_DENY_RULES).toContain("Bash(*managers/*grant.json*)");
  });

  it("denies Write and Edit under the managers state directory", () => {
    expect(EPIC_GRANT_DENY_RULES).toContain("Write(~/.flow/state/managers/**)");
    expect(EPIC_GRANT_DENY_RULES).toContain("Edit(~/.flow/state/managers/**)");
  });

  it("never denies the withdraw form and has no duplicates", () => {
    expect(
      EPIC_GRANT_DENY_RULES.some((r) => r.includes("--autonomy off")),
    ).toBe(false);
    expect(new Set(EPIC_GRANT_DENY_RULES).size).toBe(
      EPIC_GRANT_DENY_RULES.length,
    );
  });
});
