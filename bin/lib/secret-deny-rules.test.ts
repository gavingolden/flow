import { describe, expect, it } from "vitest";
import {
  GRANT_DENY_RULES,
  FLOW_CREATE_ISSUE_ALLOW_RULES,
  FLOW_UI_LOGIN_ALLOW_RULES,
  SECRET_FILE_DENY_RULES,
} from "./secret-deny-rules";

// Approximates https://code.claude.com/docs/en/permissions: compound commands
// split on && || ; | |& & and newlines, a deny rule applies when any subcommand
// matches, leading VAR=value assignments and common wrappers are stripped, and
// a rule ending in " *" also matches the bare prefix.
function subcommands(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||\|&|[;|&\n]/)
    .map((c) => {
      let t = c.trim();
      for (;;) {
        const n = t
          .replace(/^[A-Za-z_]\w*=\S*\s+/, "")
          .replace(/^timeout\s+\d+\s+/, "")
          .replace(/^(?:time|nice|nohup|stdbuf|command|builtin|noglob)\s+/, "");
        if (n === t) return t;
        t = n;
      }
    })
    .filter(Boolean);
}
function ruleMatches(rule: string, sub: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const glob = (p: string) =>
    new RegExp(
      `^${p
        .split("*")
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
  const p = m[1];
  if (glob(p).test(sub)) return true;
  return (
    p.endsWith(" *") && !p.slice(0, -2).includes("*") && sub === p.slice(0, -2)
  );
}
const denied = (cmd: string) =>
  subcommands(cmd).some((sub) =>
    GRANT_DENY_RULES.some((r) => ruleMatches(r, sub)),
  );

const ALLOWED = [
  "npm run test -- bin/flow-manager-ctl.test.ts",
  "npx vitest run bin/flow-manager-ctl.test.ts bin/lib/manager-owner-words.test.ts",
  "git diff bin/lib/manager-owner-words.ts",
  "git diff main -- bin/flow-manager-owner-words.ts",
  "grep -rn flow-manager-ctl bin",
  "grep -n ownerShowsIntent bin/lib/manager-owner-words.ts",
  "rg owner-words skills",
  "cat bin/flow-manager-ctl.ts",
];
const DENIED = [
  "flow-manager-ctl ruling write --slug x --reply approve --source owner --reason r",
  "flow-manager-ctl",
  "FLOW_MANAGER=1 flow-manager-ctl proposal add",
  "cd /tmp && ~/.flow/bin/flow-manager-ctl ruling write",
  "env FOO=1 flow-manager-ctl ruling write",
  "timeout 5 flow-manager-ctl ruling write",
  "bun bin/flow-manager-ctl.ts ruling write",
  `echo '{"prompt":"yes #3"}' | FLOW_MANAGER=1 flow-manager-owner-words`,
  "cat ~/.flow/manager/owner-words.jsonl",
  "echo x >> $HOME/.flow/manager/owner-words.jsonl",
];

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
      "Bash(*manager/proposals.json*)",
      "Bash(*manager/handles.json*)",
      "Edit(~/.flow/manager/proposals.json)",
      "Edit(~/.flow/manager/handles.json)",
      "Bash(*manager/rulings*)",
      "Bash(*manager/log.jsonl*)",
      "Bash(*manager/scope.json*)",
      "Bash(*manager/owner-words*)",
      "Bash(flow-manager-ctl *)",
      "Bash(*/flow-manager-owner-words *)",
      "Edit(~/.flow/manager/rulings/**)",
      "Edit(~/.flow/manager/scope.json)",
      "Edit(~/.flow/manager/owner-words.jsonl)",
    ]) {
      expect(GRANT_DENY_RULES).toContain(r);
    }
  });

  it("drops the broad name-match rules that blocked repo files", () => {
    expect(GRANT_DENY_RULES).not.toContain("Bash(*flow-manager-ctl*)");
    expect(GRANT_DENY_RULES).not.toContain("Bash(*owner-words*)");
  });

  it("denies the manager commands and trust files but allows repo files of the same name", () => {
    for (const c of ALLOWED) expect(denied(c), c).toBe(false);
    for (const c of DENIED) expect(denied(c), c).toBe(true);
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
