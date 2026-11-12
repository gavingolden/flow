import { describe, expect, it } from "vitest";
import {
  GRANT_DENY_RULES,
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

describe("GRANT_DENY_RULES", () => {
  it("denies the high-autonomy grant in space and equals forms", () => {
    expect(GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant * --autonomy high*)",
    );
    expect(GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant * --autonomy=high*)",
    );
  });

  it("denies the flag-first grant form", () => {
    expect(GRANT_DENY_RULES).toContain(
      "Bash(*flow epic grant --autonomy high*)",
    );
  });

  it("denies the same forms for the top-level flow grant", () => {
    for (const r of [
      "Bash(*flow grant * --autonomy high*)",
      "Bash(*flow grant * --autonomy=high*)",
      "Bash(*flow grant --autonomy high*)",
      "Bash(*flow grant --autonomy=high*)",
      "Bash(env * flow grant *)",
    ]) {
      expect(GRANT_DENY_RULES).toContain(r);
    }
  });

  it("denies an env-wrapped grant and shell writes naming grants.json", () => {
    expect(GRANT_DENY_RULES).toContain("Bash(env * flow epic grant *)");
    expect(GRANT_DENY_RULES).toContain("Bash(*manager/grants.json*)");
  });

  it("denies Edit of the grant file and the decision log, with no never-matching Write rule", () => {
    for (const f of ["grants.json", "log.jsonl"]) {
      expect(GRANT_DENY_RULES).toContain(`Edit(~/.flow/manager/${f})`);
      expect(GRANT_DENY_RULES).not.toContain(`Write(~/.flow/manager/${f})`);
    }
  });

  it("denies the relay grant, the ruling writer and Bash/Edit access to the trust files", () => {
    for (const r of [
      "Bash(*flow grant * --relay*)",
      "Bash(*flow grant --relay*)",
      "Bash(*flow epic grant * --relay*)",
      "Bash(*flow epic grant --relay*)",
      "Bash(*flow-manager-ctl ruling*)",
      "Bash(*manager/rulings*)",
      "Bash(*manager/log.jsonl*)",
      "Bash(*manager/scope.json*)",
      "Bash(*owner-words*)",
      "Edit(~/.flow/manager/rulings/**)",
      "Edit(~/.flow/manager/scope.json)",
      "Edit(~/.flow/manager/owner-words.jsonl)",
    ]) {
      expect(GRANT_DENY_RULES).toContain(r);
    }
  });

  it("denies Edit under the managers state directory, with no never-matching Write rule", () => {
    expect(GRANT_DENY_RULES).toContain("Edit(~/.flow/state/managers/**)");
    expect(GRANT_DENY_RULES).not.toContain("Write(~/.flow/state/managers/**)");
    expect(GRANT_DENY_RULES.some((r) => r.startsWith("Write("))).toBe(false);
  });

  it("never denies the withdraw or list forms and has no duplicates", () => {
    expect(
      GRANT_DENY_RULES.some(
        (r) => r.includes("--autonomy off") || r.includes("--list"),
      ),
    ).toBe(false);
    expect(new Set(GRANT_DENY_RULES).size).toBe(GRANT_DENY_RULES.length);
  });
});
