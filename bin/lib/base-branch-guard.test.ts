import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASE_BRANCH_GUARD_HOOK,
  BASE_BRANCH_GUARD_VERSION,
  EPIC_STATUS_ALLOWLIST_MIN_VERSION,
  LEGACY_HOOK_BODIES,
  baseBranchGuardDecision,
  baseBranchGuardSidecarPath,
  classifyPreCommitHook,
  ensureGuardSidecar,
  extractMarkerVersion,
  foreignHookNotice,
  installBaseBranchGuard,
  installedGuardCapability,
  isCommittableOnBaseBranch,
  isKnownFlowHookBody,
} from "./base-branch-guard";
import { resolveHooksTarget } from "./hooks-target";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures");

function readFixture(n: number): string {
  return fs.readFileSync(
    path.join(FIXTURES, `base-branch-guard-v${n}.sh`),
    "utf8",
  );
}

describe("baseBranchGuardDecision", () => {
  it("refuses when both session markers are set AND HEAD is the default branch", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("refuse");
  });

  it("allows when the session id is missing (the user's own manual commit)", () => {
    expect(
      baseBranchGuardDecision({
        flowSlug: "csv-export",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });

  it("allows when the flow-slug pane marker is missing (a hand-driven Claude session)", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });

  it("allows when on a feature branch even with both markers set", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "feature/csv-export",
        defaultBranch: "main",
      }),
    ).toBe("allow");
  });

  it("keeps refusing on the base branch when stagedPaths is omitted (no caller regression)", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "main",
        defaultBranch: "main",
      }),
    ).toBe("refuse");
  });

  it("ignores stagedPaths entirely when the session is not flow-marked", () => {
    expect(
      baseBranchGuardDecision({
        currentBranch: "main",
        defaultBranch: "main",
        stagedPaths: ["bin/foo.ts"],
      }),
    ).toBe("allow");
  });

  it("ignores stagedPaths entirely when the branch is not the default branch", () => {
    expect(
      baseBranchGuardDecision({
        sessionId: "sess-1",
        flowSlug: "csv-export",
        currentBranch: "feature/csv-export",
        defaultBranch: "main",
        stagedPaths: ["bin/foo.ts"],
      }),
    ).toBe("allow");
  });
});

describe("status-board allowlist (base branch carve-out)", () => {
  const decision = (stagedPaths: string[]) =>
    baseBranchGuardDecision({
      sessionId: "s",
      flowSlug: "g",
      currentBranch: "main",
      defaultBranch: "main",
      stagedPaths,
    });

  it("allows a lone epic status board", () => {
    const paths = [".flow/epics/my-epic/status.json"];
    expect(isCommittableOnBaseBranch(paths)).toBe(true);
    expect(decision(paths)).toBe("allow");
  });

  it("allows two status boards from different epics", () => {
    const paths = [
      ".flow/epics/my-epic/status.json",
      ".flow/epics/other-epic/status.json",
    ];
    expect(isCommittableOnBaseBranch(paths)).toBe(true);
    expect(decision(paths)).toBe("allow");
  });

  it("refuses an empty staged set", () => {
    expect(isCommittableOnBaseBranch([])).toBe(false);
    expect(decision([])).toBe("refuse");
  });

  it("refuses manifest.json", () => {
    const paths = [".flow/epics/my-epic/manifest.json"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses design.md", () => {
    const paths = [".flow/epics/my-epic/design.md"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses a code file", () => {
    const paths = ["bin/foo.ts"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses a mixed set (the load-bearing case)", () => {
    const paths = [".flow/epics/my-epic/status.json", "bin/foo.ts"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses a nested epic-slug segment (the char class must not match a slash)", () => {
    const paths = [".flow/epics/a/b/status.json"];
    // ".flow/epics/a/b/status.json" has a slash inside the [^/]+ epic-slug
    // segment, so it does NOT match the allowlist regex — refused.
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses a traversal-ish path", () => {
    const paths = [".flow/epics/../../etc/status.json"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });

  it("refuses a path not anchored at repo root", () => {
    const paths = ["x/.flow/epics/e/status.json"];
    expect(isCommittableOnBaseBranch(paths)).toBe(false);
    expect(decision(paths)).toBe("refuse");
  });
});

describe("installBaseBranchGuard", () => {
  let repoDir!: string;
  let errors!: string[];

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const hookPath = () => path.join(repoDir, ".git", "hooks", "pre-commit");

  it("installs when there is no pre-commit hook and no core.hooksPath", () => {
    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "installed" });
    expect(fs.existsSync(hookPath())).toBe(true);
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    // Executable for the owner — git only runs an executable hook.
    expect(fs.statSync(hookPath()).mode & 0o111).not.toBe(0);
  });

  it("skips + warns when a foreign pre-commit hook already exists (never clobbers)", () => {
    const sentinel = "#!/bin/sh\n# user's own hook\nexit 0\n";
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), sentinel, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: false, reason: "foreign" });
    expect(result.sidecarPath).toBeTruthy();
    // The user's hook is left untouched.
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(sentinel);
    expect(errors.join("\n")).toMatch(/is not flow's/);
  });

  // When core.hooksPath points at a custom dir, git resolves it transparently
  // (`git rev-parse --git-path hooks` honors it), so the guard installs INTO
  // that dir — the disciplined repos that bother to configure a hooks dir are
  // exactly the ones the guard most needs to protect.
  it("installs into the configured core.hooksPath dir when it has no pre-commit", () => {
    const customHooks = path.join(repoDir, "my-hooks");
    fs.mkdirSync(customHooks, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", customHooks], {
      cwd: repoDir,
    });
    const customHook = path.join(customHooks, "pre-commit");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "installed" });
    // Written into the CUSTOM dir, not the default .git/hooks.
    expect(fs.existsSync(customHook)).toBe(true);
    expect(fs.readFileSync(customHook, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(fs.statSync(customHook).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(hookPath())).toBe(false);
  });

  // The three custom-dir specs above all configure an ABSOLUTE core.hooksPath.
  // This PR's actual motivating scenario is a *relative* hooks dir — econ-data
  // sets `core.hooksPath = .githooks` — which routes through the other arm of
  // `resolveHooksTarget`'s hooksDir resolution. Skipping the pre-create also
  // pins `mkdirSync(..., {recursive:true})` creating a not-yet-existing custom
  // dir.
  it("installs into a RELATIVE core.hooksPath dir (econ-data's .githooks case)", () => {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repoDir,
    });
    const customHook = path.join(repoDir, ".githooks", "pre-commit");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "installed" });
    expect(fs.existsSync(customHook)).toBe(true);
    expect(fs.readFileSync(customHook, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(fs.statSync(customHook).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(hookPath())).toBe(false);
  });

  // Non-clobber holds in the custom dir exactly as it does in the default dir:
  // a pre-existing pre-commit is the user's own hook, so we warn and skip.
  it("skips + warns when the configured core.hooksPath dir already has a foreign pre-commit", () => {
    const customHooks = path.join(repoDir, "my-hooks");
    fs.mkdirSync(customHooks, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", customHooks], {
      cwd: repoDir,
    });
    const customHook = path.join(customHooks, "pre-commit");
    const sentinel = "#!/bin/sh\n# user's own hook in the custom dir\nexit 0\n";
    fs.writeFileSync(customHook, sentinel, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: false, reason: "foreign" });
    // The user's hook is left byte-identical.
    expect(fs.readFileSync(customHook, "utf8")).toBe(sentinel);
    expect(errors.join("\n")).toMatch(/is not flow's/);
  });

  it("is idempotent over its own hook in the configured core.hooksPath dir", () => {
    const customHooks = path.join(repoDir, "my-hooks");
    fs.mkdirSync(customHooks, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", customHooks], {
      cwd: repoDir,
    });
    const customHook = path.join(customHooks, "pre-commit");

    expect(installBaseBranchGuard(repoDir)).toMatchObject({
      installed: true,
      reason: "installed",
    });
    const second = installBaseBranchGuard(repoDir);
    expect(second).toMatchObject({ installed: true, reason: "idempotent" });
    expect(fs.readFileSync(customHook, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
  });

  it("is idempotent — a second install over our own hook is a no-op", () => {
    const first = installBaseBranchGuard(repoDir);
    expect(first).toMatchObject({ installed: true, reason: "installed" });
    const contentAfterFirst = fs.readFileSync(hookPath(), "utf8");

    const second = installBaseBranchGuard(repoDir);
    expect(second).toMatchObject({ installed: true, reason: "idempotent" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(contentAfterFirst);
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(errors).toEqual([]);
  });

  it("falls back to <repo>/.git/hooks when git can't resolve the hooks path", () => {
    // A plain non-git directory: `git rev-parse --git-path hooks` fails, so
    // resolveHooksTarget's fallback fires, defaulting to
    // path.join(repoDir, ".git", "hooks"). This locks in the worktree/custom-
    // git-dir robustness invariant the happy-path tests never reach (they all
    // resolve via a real git repo). Driven through the public installer so no
    // internal export is needed.
    const nonGitDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-bbg-nongit-"),
    );
    try {
      const result = installBaseBranchGuard(nonGitDir);
      expect(result).toMatchObject({ installed: true, reason: "installed" });
      const fallbackHook = path.join(nonGitDir, ".git", "hooks", "pre-commit");
      expect(fs.existsSync(fallbackHook)).toBe(true);
      expect(fs.readFileSync(fallbackHook, "utf8")).toBe(
        BASE_BRANCH_GUARD_HOOK,
      );
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("upgrades a v1 (tmux-only) legacy hook in place", () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), readFixture(1), "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "upgraded" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(errors.join("\n")).toMatch(/upgraded the base-branch guard/);
  });

  it("upgrades a v2 (env-first, pre-marker) legacy hook in place", () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), readFixture(2), "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "upgraded" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(errors.join("\n")).toMatch(/upgraded the base-branch guard/);
  });

  it("upgrades a hook carrying an OLDER marker version", () => {
    const olderMarkerHook = `#!/bin/sh\n# flow:base-branch-guard v${
      BASE_BRANCH_GUARD_VERSION - 1
    }\nexit 0\n`;
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), olderMarkerHook, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "upgraded" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
  });

  it("is idempotent with NO stderr output when the hook carries the current marker and body", () => {
    installBaseBranchGuard(repoDir);
    errors.length = 0;

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "idempotent" });
    expect(errors).toEqual([]);
  });

  it("never downgrades a hook carrying a NEWER marker version", () => {
    const newerMarkerHook = `#!/bin/sh\n# flow:base-branch-guard v${
      BASE_BRANCH_GUARD_VERSION + 1
    }\n# some future body\nexit 0\n`;
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), newerMarkerHook, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: false, reason: "newer" });
    // Byte-unchanged.
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(newerMarkerHook);
  });

  it("classifies an arbitrary user hook as foreign and leaves it byte-unchanged", () => {
    const sentinel = "#!/bin/sh\n# totally unrelated hook\nexit 3\n";
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), sentinel, "utf8");

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: false, reason: "foreign" });
    expect(fs.readFileSync(hookPath(), "utf8")).toBe(sentinel);
  });

  it("ensures the GLOBAL sidecar on the foreign path and writes nothing inside the repo", () => {
    const sentinel = "#!/bin/sh\n# totally unrelated hook\nexit 3\n";
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), sentinel, "utf8");

    const beforeEntries = fs.readdirSync(repoDir, { recursive: true } as {
      recursive: true;
    }) as string[];

    const result = installBaseBranchGuard(repoDir);
    expect(result.sidecarPath).toBeTruthy();
    expect(result.sidecarPath!.startsWith(repoDir)).toBe(false);
    expect(fs.existsSync(result.sidecarPath!)).toBe(true);

    const afterEntries = fs.readdirSync(repoDir, { recursive: true } as {
      recursive: true;
    }) as string[];
    expect(afterEntries).toEqual(beforeEntries);
  });

  it("names the sidecar path and the source-safe snippet in the foreign notice", () => {
    const sentinel = "#!/bin/sh\n# totally unrelated hook\nexit 3\n";
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), sentinel, "utf8");

    const result = installBaseBranchGuard(repoDir);
    const joined = errors.join("\n");
    expect(joined).toContain(result.sidecarPath!);
    expect(joined).toMatch(
      /\[ -r "\$HOME\/\.flow\/hooks\/base-branch-guard\.sh" \] && \. "\$HOME\/\.flow\/hooks\/base-branch-guard\.sh"/,
    );
  });

  it("treats a husky-managed hooks dir as foreign even when pre-commit is absent, and never writes into `_`", () => {
    const huskyDir = path.join(repoDir, ".husky", "_");
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(path.join(huskyDir, "husky.sh"), "# husky\n", "utf8");
    execFileSync("git", ["config", "core.hooksPath", huskyDir], {
      cwd: repoDir,
    });

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: false, reason: "foreign" });
    expect(fs.existsSync(path.join(huskyDir, "pre-commit"))).toBe(false);
    expect(errors.join("\n")).toMatch(/managed by husky/);
  });

  it("states that a TRACKED file was modified when upgrading a hook that git tracks", () => {
    // A hook under .git/hooks/ can never be `git add`ed (`.git/` is outside
    // the working tree) — the realistic tracked-hook shape is a
    // core.hooksPath pointing at a WORKING-TREE dir, exactly like
    // econ-data's `.githooks/pre-commit`.
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repoDir,
    });
    const trackedHook = path.join(repoDir, ".githooks", "pre-commit");
    fs.mkdirSync(path.dirname(trackedHook), { recursive: true });
    fs.writeFileSync(trackedHook, readFixture(1), "utf8");
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Flow Test"], {
      cwd: repoDir,
    });
    execFileSync("git", ["add", ".githooks/pre-commit"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "track the legacy hook"], {
      cwd: repoDir,
    });

    const result = installBaseBranchGuard(repoDir);
    expect(result).toMatchObject({ installed: true, reason: "upgraded" });
    expect(errors.join("\n")).toMatch(/TRACKED file/);
  });

  it("resolves the sidecar path at CALL TIME, honouring the test sandbox's $HOME", () => {
    // Regression lock for the module-scope os.homedir() hazard: HOME is
    // captured at import time (before vitest.setup.ts swaps it for a
    // sandbox), so an eager module-scope constant would resolve against the
    // developer's real home instead of the sandbox vitest.setup.ts creates
    // (prefixed "flow-vitest-home-").
    expect(baseBranchGuardSidecarPath()).toContain("flow-vitest-home-");
  });
});

describe("classifyPreCommitHook", () => {
  it("classifies null/empty contents as absent", () => {
    expect(classifyPreCommitHook(null)).toBe("absent");
    expect(classifyPreCommitHook("")).toBe("absent");
    expect(classifyPreCommitHook("   \n")).toBe("absent");
  });

  it("classifies the current hook body as own-current", () => {
    expect(classifyPreCommitHook(BASE_BRANCH_GUARD_HOOK)).toBe("own-current");
  });

  // The substring-contains marker match is the whole reason byte-exact compare
  // was abandoned (see the classifyPreCommitHook doc comment): whitespace/CRLF
  // churn in a marker-bearing hook must NOT re-trigger a `foreign`
  // misclassification. This is that guarantee under test, not just asserted.
  it("stays own-current when the current body has CRLF line endings", () => {
    const crlf = BASE_BRANCH_GUARD_HOOK.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(BASE_BRANCH_GUARD_HOOK); // genuinely byte-different
    expect(classifyPreCommitHook(crlf)).toBe("own-current");
  });

  it("stays own-current when the marker line has trailing whitespace", () => {
    const padded = BASE_BRANCH_GUARD_HOOK.replace(
      `v${BASE_BRANCH_GUARD_VERSION}`,
      `v${BASE_BRANCH_GUARD_VERSION}   `,
    );
    expect(classifyPreCommitHook(padded)).toBe("own-current");
  });

  it("classifies an older marker version as own-outdated regardless of surrounding churn", () => {
    const older = BASE_BRANCH_GUARD_HOOK.replace(
      `v${BASE_BRANCH_GUARD_VERSION}`,
      `v${BASE_BRANCH_GUARD_VERSION - 1}`,
    ).replace(/\n/g, "\r\n");
    expect(classifyPreCommitHook(older)).toBe("own-outdated");
  });

  // A malformed marker integer must fall through to the legacy/foreign path
  // rather than producing a NaN comparison that silently classifies wrong.
  it("treats a non-numeric marker version as foreign, not a NaN class", () => {
    const bad = "#!/bin/sh\n# flow:base-branch-guard vABC\nexit 0\n";
    expect(classifyPreCommitHook(bad)).toBe("foreign");
  });

  it("treats a marker with no trailing integer as foreign", () => {
    const bare = "#!/bin/sh\n# flow:base-branch-guard v\nexit 0\n";
    expect(classifyPreCommitHook(bare)).toBe("foreign");
  });
});

describe("isKnownFlowHookBody", () => {
  it("is true for the current body and every registered legacy body", () => {
    expect(isKnownFlowHookBody(BASE_BRANCH_GUARD_HOOK)).toBe(true);
    for (const body of LEGACY_HOOK_BODIES["base-branch"]) {
      expect(isKnownFlowHookBody(body)).toBe(true);
    }
  });

  it("is false for a marker-intact body with hand-appended lines", () => {
    expect(isKnownFlowHookBody(`${BASE_BRANCH_GUARD_HOOK}# custom\n`)).toBe(
      false,
    );
  });

  it("is false for an unrelated body", () => {
    expect(isKnownFlowHookBody("#!/bin/sh\nexit 1\n")).toBe(false);
  });
});

describe("extractMarkerVersion (promoted export)", () => {
  it("reads the marker version out of the current hook body", () => {
    expect(extractMarkerVersion(BASE_BRANCH_GUARD_HOOK)).toBe(
      BASE_BRANCH_GUARD_VERSION,
    );
  });

  it("returns null when no marker is present", () => {
    expect(extractMarkerVersion(LEGACY_HOOK_BODIES["base-branch"][0])).toBe(
      null,
    );
  });
});

describe("installedGuardCapability", () => {
  let repoDir!: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-cap-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const hookPath = () => path.join(repoDir, ".git", "hooks", "pre-commit");

  const writeHook = (contents: string) => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), contents, "utf8");
  };

  it("absent: allows the status board, is never self-healable", () => {
    const cap = installedGuardCapability(repoDir);
    expect(cap).toMatchObject({
      allowsStatusBoard: true,
      selfHealable: false,
      classification: "absent",
      version: null,
    });
  });

  it("own-current (v4): allows the status board, is never self-healable", () => {
    writeHook(BASE_BRANCH_GUARD_HOOK);
    const cap = installedGuardCapability(repoDir);
    expect(cap).toMatchObject({
      allowsStatusBoard: true,
      selfHealable: false,
      classification: "own-current",
      version: BASE_BRANCH_GUARD_VERSION,
    });
  });

  it("own-outdated (v3): disallows but is self-healable", () => {
    writeHook(LEGACY_HOOK_BODIES["base-branch"][2]);
    const cap = installedGuardCapability(repoDir);
    expect(cap.classification).toBe("own-outdated");
    expect(cap.version).toBe(3);
    expect(cap.version).toBeLessThan(EPIC_STATUS_ALLOWLIST_MIN_VERSION);
    expect(cap.allowsStatusBoard).toBe(false);
    expect(cap.selfHealable).toBe(true);
  });

  // The dangerous case a marker-only check would miss: the marker says v3
  // (own-outdated) but the BODY has been hand-edited, so it is NOT a body
  // flow ever shipped. `selfHealable` must be false here — an
  // optimistic `true` would let `flow-stop-guard.ts` promise a
  // `flow-epic-sync --commit` route that `commitEpicStatus`'s own
  // byte-identity gate then declines, exactly the over-promised-route bug
  // this PR exists to close.
  it("own-outdated (v3) with hand-appended lines: disallows AND is NOT self-healable", () => {
    writeHook(
      `${LEGACY_HOOK_BODIES["base-branch"][2]}# custom line 1\n# custom line 2\n`,
    );
    const cap = installedGuardCapability(repoDir);
    expect(cap.classification).toBe("own-outdated");
    expect(cap.version).toBe(3);
    expect(cap.allowsStatusBoard).toBe(false);
    expect(cap.selfHealable).toBe(false);
  });

  it("own-legacy (v1/v2, pre-marker): disallows but is self-healable", () => {
    writeHook(LEGACY_HOOK_BODIES["base-branch"][0]);
    const cap = installedGuardCapability(repoDir);
    expect(cap).toMatchObject({
      allowsStatusBoard: false,
      selfHealable: true,
      classification: "own-legacy",
      version: null,
    });
  });

  it("foreign: disallows and is never self-healable", () => {
    writeHook("#!/bin/sh\n# a hand-rolled hook\nexit 0\n");
    const cap = installedGuardCapability(repoDir);
    expect(cap).toMatchObject({
      allowsStatusBoard: false,
      selfHealable: false,
      classification: "foreign",
    });
  });

  it("husky: classifies as foreign (no dedicated enum member) and is never self-healable", () => {
    const huskyDir = path.join(repoDir, ".husky", "_");
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(path.join(huskyDir, "husky.sh"), "# husky\n", "utf8");
    execFileSync(
      "git",
      ["config", "core.hooksPath", path.join(".husky", "_")],
      { cwd: repoDir },
    );

    const cap = installedGuardCapability(repoDir);
    expect(cap).toMatchObject({
      allowsStatusBoard: false,
      selfHealable: false,
      classification: "foreign",
    });
  });

  it("never throws: an unreadable hook resolves to the fail-safe capability", () => {
    // Real OS-level unreadable file (chmod 0), not a `vi.spyOn(fs, ...)` —
    // `node:fs`'s named exports aren't reconfigurable under vitest's ESM
    // interop, so a spy throws "Cannot redefine property" before the
    // assertion under test even runs.
    if (process.getuid && process.getuid() === 0) {
      // root ignores file-mode read restrictions; skip rather than false-fail.
      return;
    }
    writeHook(BASE_BRANCH_GUARD_HOOK);
    fs.chmodSync(hookPath(), 0o000);

    let cap: ReturnType<typeof installedGuardCapability> | undefined;
    expect(() => {
      cap = installedGuardCapability(repoDir);
    }).not.toThrow();
    expect(cap?.allowsStatusBoard).toBe(false);
    expect(cap?.selfHealable).toBe(false);

    fs.chmodSync(hookPath(), 0o755); // restore so afterEach's rmSync succeeds
  });
});

// The sidecar is the linchpin of the "stale hooks self-upgrade in every
// foreign repo" claim: every foreign repo sources this ONE machine-global
// file, so a future BASE_BRANCH_GUARD_VERSION bump must propagate to it. The
// path resolves under the vitest sandbox $HOME (see the call-time-path test
// above), so these writes never touch the developer's real ~/.flow/hooks.
describe("ensureGuardSidecar", () => {
  const sidecarPath = () => baseBranchGuardSidecarPath();

  afterEach(() => {
    fs.rmSync(sidecarPath(), { force: true });
  });

  it("writes the current guard body (mode 0644) when absent", () => {
    const p = ensureGuardSidecar();
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    // Sourced, not executed — must NOT carry the executable bit.
    expect(fs.statSync(p).mode & 0o111).toBe(0);
  });

  it("is idempotent: a second call does not rewrite a current sidecar", () => {
    const p = ensureGuardSidecar();
    // Sentinel: a rewrite would replace the whole body and erase this line,
    // so its survival proves the current-version sidecar was left untouched.
    fs.appendFileSync(p, "# sentinel\n");
    ensureGuardSidecar();
    expect(fs.readFileSync(p, "utf8")).toContain("# sentinel");
  });

  it("upgrades an older-version sidecar in place", () => {
    const p = sidecarPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, readFixture(BASE_BRANCH_GUARD_VERSION - 1), "utf8");
    ensureGuardSidecar();
    expect(fs.readFileSync(p, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    expect(classifyPreCommitHook(fs.readFileSync(p, "utf8"))).toBe(
      "own-current",
    );
  });

  it("overwrites an unversioned (legacy) sidecar", () => {
    const p = sidecarPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, readFixture(1), "utf8"); // v1: no marker
    ensureGuardSidecar();
    expect(fs.readFileSync(p, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
  });
});

describe("foreignHookNotice", () => {
  it("is pure and STDOUT-safe: the notice text never leaks to stdout", () => {
    const target = resolveHooksTarget(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-notice-")),
    );
    const notice = foreignHookNotice(
      target,
      path.join(target.hooksDir, "pre-commit"),
      "/fake/sidecar.sh",
    );
    expect(notice).toContain("is not flow's");
    expect(notice).toContain("/fake/sidecar.sh");
  });
});

// Exercises the emitted sh hook through a REAL `git commit`. The hook's only
// non-git dependency is `tmux show-options ... @flow-slug`, so a tiny `tmux`
// PATH shim stands in for a live tmux server — that is the single seam between
// the unit-tested decision function and the actual per-commit behaviour.
describe("BASE_BRANCH_GUARD_HOOK (integration: real git commit)", () => {
  let repoDir!: string;
  let shimDir!: string;

  const writeTmuxShim = (slug: string) => {
    const p = path.join(shimDir, "tmux");
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${slug}"\n`, "utf8");
    fs.chmodSync(p, 0o755);
  };

  type Env = Record<string, string | undefined>;

  // Base env with the ambient flow-session markers stripped (this very test
  // process runs inside one), so each case opts INTO exactly the markers it
  // needs. shimDir is prefixed so the `tmux` shim wins while real `git`/`sh`
  // still resolve from the rest of PATH.
  const baseEnv = (): Env => {
    const env: Env = {
      ...(process.env as Env),
      PATH: `${shimDir}:${process.env.PATH}`,
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.TMUX_PANE;
    return env;
  };

  const tryCommit = (
    env: Env,
    file: string,
  ): { ok: boolean; stderr: string } => {
    fs.writeFileSync(path.join(repoDir, file), `${file}\n`, "utf8");
    execFileSync("git", ["add", file], { cwd: repoDir });
    try {
      execFileSync("git", ["commit", "-m", `add ${file}`], {
        cwd: repoDir,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
      });
      return { ok: true, stderr: "" };
    } catch (err) {
      const e = err as { stderr?: Buffer | string };
      return { ok: false, stderr: String(e.stderr ?? "") };
    }
  };

  // Sibling to tryCommit: commits a SINGLE relative path directly (no `git
  // add`), mirroring the path-scoped commit the epic-status carve-out relies
  // on. The file must already be written to disk (and staged, if the caller
  // wants an unrelated-file-stays-staged assertion) before calling this.
  const tryPathScopedCommit = (
    env: Env,
    relPath: string,
    contents: string,
  ): { ok: boolean; stderr: string } => {
    const abs = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, "utf8");
    // `git commit -- <path>` alone refuses a brand-new UNTRACKED path
    // ("pathspec did not match any files known to git"); a path-scoped
    // `git add -- <path>` first (never a bare, whole-index `git add`) makes
    // both the first-ever write and a later modification commit the same
    // way, without touching any OTHER staged path.
    execFileSync("git", ["add", "--", relPath], { cwd: repoDir });
    try {
      execFileSync("git", ["commit", "-m", `sync ${relPath}`, "--", relPath], {
        cwd: repoDir,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
      });
      return { ok: true, stderr: "" };
    } catch (err) {
      const e = err as { stderr?: Buffer | string };
      return { ok: false, stderr: String(e.stderr ?? "") };
    }
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-hook-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bbg-shim-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Flow Test"], { cwd: repoDir });
    installBaseBranchGuard(repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it("refuses a default-branch commit inside a flow session", () => {
    writeTmuxShim("csv-export");
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "a.txt",
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/refusing to commit on the base branch/);
  });

  it("allows a feature-branch commit inside a flow session", () => {
    writeTmuxShim("csv-export");
    execFileSync("git", ["checkout", "-b", "feature/csv-export"], {
      cwd: repoDir,
    });
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "b.txt",
    );
    expect(r.ok).toBe(true);
  });

  it("allows a default-branch commit outside a flow session (no session id)", () => {
    writeTmuxShim("csv-export");
    const r = tryCommit({ ...baseEnv(), TMUX_PANE: "%1" }, "c.txt");
    expect(r.ok).toBe(true);
  });

  it("allows a default-branch commit when the pane carries no @flow-slug", () => {
    writeTmuxShim(""); // empty slug → guard is inert
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "d.txt",
    );
    expect(r.ok).toBe(true);
  });

  // The production default-branch arm: real repos resolve the default via
  // `git symbolic-ref refs/remotes/origin/HEAD` and strip the `origin/` prefix.
  // Every other case here is a no-remote `git init -b main` repo with no
  // origin/HEAD, so they only ever hit the local main/master fallback — leaving
  // the symbolic-ref resolution + `${default_branch#origin/}` strip (the path
  // that actually runs for real users) uncovered. Point origin/HEAD at a
  // NON-`main` branch to exercise both and prove the guard keys off origin/HEAD,
  // not a hardcoded `main`.
  it("refuses on the origin/HEAD-resolved default branch (non-`main`) and allows elsewhere", () => {
    const seed = (file: string) => {
      fs.writeFileSync(path.join(repoDir, file), "seed\n", "utf8");
      execFileSync("git", ["add", file], { cwd: repoDir });
      // --no-verify: setup commits predate the assertion and bypass the guard.
      execFileSync("git", ["commit", "--no-verify", "-m", `seed ${file}`], {
        cwd: repoDir,
      });
    };
    // Born on `main` (the beforeEach init branch), then branch `trunk` off it so
    // both are real, checkout-able branches.
    seed("main-seed.txt");
    execFileSync("git", ["checkout", "-b", "trunk"], { cwd: repoDir });
    seed("trunk-seed.txt");
    // Wire origin/HEAD → origin/trunk exactly as `git remote set-head` would
    // after a fetch, without standing up a real remote.
    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk"],
      { cwd: repoDir },
    );
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
      { cwd: repoDir },
    );

    writeTmuxShim("csv-export");
    const sessionEnv = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };

    // HEAD is `trunk` (the origin/HEAD-resolved default) → refused, and the
    // message names the resolved default, proving the `#origin/` strip ran.
    execFileSync("git", ["checkout", "trunk"], { cwd: repoDir });
    const onTrunk = tryCommit(sessionEnv, "on-trunk.txt");
    expect(onTrunk.ok).toBe(false);
    expect(onTrunk.stderr).toMatch(
      /refusing to commit on the base branch 'trunk'/,
    );

    // `main` is NOT the resolved default here → allowed.
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    const onMain = tryCommit(sessionEnv, "on-main.txt");
    expect(onMain.ok).toBe(true);
  });

  // The local `refs/heads/main` fallback arm (no origin/HEAD) only runs when the
  // default branch is BORN: the first-commit cases above commit on an UNBORN
  // `main`, where `show-ref --verify refs/heads/main` fails and resolution falls
  // through to the final `else default_branch=main`. A born `main` makes that
  // show-ref succeed, exercising the elif itself.
  it("refuses on a born `main` via the local fallback when origin/HEAD is absent", () => {
    fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n", "utf8");
    execFileSync("git", ["add", "seed.txt"], { cwd: repoDir });
    // --no-verify: the seed commit borns `main` and bypasses the guard.
    execFileSync("git", ["commit", "--no-verify", "-m", "seed"], {
      cwd: repoDir,
    });

    writeTmuxShim("csv-export");
    const r = tryCommit(
      { ...baseEnv(), CLAUDE_CODE_SESSION_ID: "sess-1", TMUX_PANE: "%1" },
      "after-born.txt",
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/refusing to commit on the base branch 'main'/);
  });

  // Symmetric to the born-`main` case but on a born `master` with no `main` and
  // no origin/HEAD, exercising the `master` elif of the local fallback.
  it("refuses on a born `master` via the local fallback when origin/HEAD is absent", () => {
    const masterRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-bbg-master-"),
    );
    try {
      execFileSync("git", ["init", "-b", "master", masterRepo]);
      execFileSync("git", ["config", "user.email", "t@example.com"], {
        cwd: masterRepo,
      });
      execFileSync("git", ["config", "user.name", "Flow Test"], {
        cwd: masterRepo,
      });
      installBaseBranchGuard(masterRepo);
      fs.writeFileSync(path.join(masterRepo, "seed.txt"), "seed\n", "utf8");
      execFileSync("git", ["add", "seed.txt"], { cwd: masterRepo });
      execFileSync("git", ["commit", "--no-verify", "-m", "seed"], {
        cwd: masterRepo,
      });

      writeTmuxShim("csv-export");
      fs.writeFileSync(path.join(masterRepo, "next.txt"), "next\n", "utf8");
      execFileSync("git", ["add", "next.txt"], { cwd: masterRepo });
      let refused = false;
      let stderr = "";
      try {
        execFileSync("git", ["commit", "-m", "next"], {
          cwd: masterRepo,
          encoding: "utf8",
          env: {
            ...baseEnv(),
            CLAUDE_CODE_SESSION_ID: "sess-1",
            TMUX_PANE: "%1",
          } as NodeJS.ProcessEnv,
        });
      } catch (err) {
        refused = true;
        stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      }
      expect(refused).toBe(true);
      expect(stderr).toMatch(/refusing to commit on the base branch 'master'/);
    } finally {
      fs.rmSync(masterRepo, { recursive: true, force: true });
    }
  });

  it("allows a path-scoped commit of a lone epic status board on the base branch inside a flow session", () => {
    writeTmuxShim("csv-export");
    const env = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };
    const r = tryPathScopedCommit(
      env,
      ".flow/epics/e1/status.json",
      '{"version":1}\n',
    );
    expect(r.ok).toBe(true);
  });

  const hasJq =
    spawnSync("command", ["-v", "jq"], { shell: "/bin/sh" }).status === 0;

  (hasJq ? it : it.skip)(
    "refuses a staged epic status board that is not valid JSON (jq-gated content check)",
    () => {
      writeTmuxShim("csv-export");
      const env = {
        ...baseEnv(),
        CLAUDE_CODE_SESSION_ID: "sess-1",
        TMUX_PANE: "%1",
      };
      const r = tryPathScopedCommit(
        env,
        ".flow/epics/e1/status.json",
        "{not valid json\n",
      );
      expect(r.ok).toBe(false);
      expect(r.stderr).toMatch(
        /refusing to commit a malformed epic status board/,
      );
    },
  );

  it("refuses a path-scoped commit of manifest.json on the base branch inside a flow session", () => {
    writeTmuxShim("csv-export");
    const env = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };
    const r = tryPathScopedCommit(
      env,
      ".flow/epics/e1/manifest.json",
      '{"version":1}\n',
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/refusing to commit on the base branch/);
  });

  it("leaves an unrelated staged file out of the path-scoped board commit, still staged afterwards", () => {
    writeTmuxShim("csv-export");
    const env = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };
    // Stage an unrelated file WITHOUT committing it.
    fs.writeFileSync(
      path.join(repoDir, "unrelated.txt"),
      "unrelated\n",
      "utf8",
    );
    execFileSync("git", ["add", "unrelated.txt"], { cwd: repoDir });

    const r = tryPathScopedCommit(
      env,
      ".flow/epics/e1/status.json",
      '{"version":1}\n',
    );
    expect(r.ok).toBe(true);

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    // unrelated.txt must remain staged (index "A"), NOT swept into the
    // just-made commit — this pins the git behaviour the whole design rests
    // on: `git commit -- <path>` builds a temporary index for that path only.
    expect(status).toMatch(/^A\s+unrelated\.txt$/m);
  });

  it("refuses a `git mv` from manifest.json to status.json — --no-renames closes the rename-detection allowlist escape", () => {
    // Without `--no-renames` on the staged-name probe, `git diff --cached
    // --name-only` prints ONLY the destination path for a detected rename,
    // so this rename would show a single allowlisted `status.json` line and
    // pass the check while committing a DELETION of manifest.json.
    writeTmuxShim("csv-export");
    const env = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };
    const manifestAbs = path.join(repoDir, ".flow/epics/e1/manifest.json");
    fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
    fs.writeFileSync(manifestAbs, '{"version":1}\n', "utf8");
    execFileSync("git", ["add", "--", ".flow/epics/e1/manifest.json"], {
      cwd: repoDir,
    });
    execFileSync("git", ["commit", "-m", "seed manifest"], {
      cwd: repoDir,
      env: baseEnv() as NodeJS.ProcessEnv,
    });

    execFileSync(
      "git",
      ["mv", ".flow/epics/e1/manifest.json", ".flow/epics/e1/status.json"],
      { cwd: repoDir },
    );
    let ok = true;
    let stderr = "";
    try {
      execFileSync("git", ["commit", "-m", "rename manifest to status"], {
        cwd: repoDir,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
      });
    } catch (err) {
      ok = false;
      const e = err as { stderr?: Buffer | string };
      stderr = String(e.stderr ?? "");
    }
    expect(ok).toBe(false);
    expect(stderr).toMatch(/refusing to commit on the base branch/);
  });

  it("the TS mirror (baseBranchGuardDecision) and the real-git sh hook AGREE on a mixed-staged-set (board + unrelated file)", () => {
    writeTmuxShim("csv-export");
    const env = {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: "sess-1",
      TMUX_PANE: "%1",
    };
    const boardAbs = path.join(repoDir, ".flow/epics/e1/status.json");
    fs.mkdirSync(path.dirname(boardAbs), { recursive: true });
    fs.writeFileSync(boardAbs, '{"version":1}\n', "utf8");
    fs.writeFileSync(
      path.join(repoDir, "unrelated.txt"),
      "unrelated\n",
      "utf8",
    );
    execFileSync("git", ["add", "--", ".flow/epics/e1/status.json"], {
      cwd: repoDir,
    });
    execFileSync("git", ["add", "--", "unrelated.txt"], { cwd: repoDir });

    let ok = true;
    try {
      execFileSync("git", ["commit", "-m", "mixed set"], {
        cwd: repoDir,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
      });
    } catch {
      ok = false;
    }

    const mirrorDecision = baseBranchGuardDecision({
      sessionId: "sess-1",
      flowSlug: "csv-export",
      currentBranch: "main",
      defaultBranch: "main",
      stagedPaths: [".flow/epics/e1/status.json", "unrelated.txt"],
    });

    // The real hook refuses a whole-index commit that mixes the board with
    // an unrelated file (only a PATH-SCOPED commit is exempt), and the TS
    // mirror must agree on this same staged set.
    expect(ok).toBe(false);
    expect(mirrorDecision).toBe("refuse");
  });
});

describe("version-drift lock", () => {
  it(`BASE_BRANCH_GUARD_HOOK is byte-equal to bin/fixtures/base-branch-guard-v${BASE_BRANCH_GUARD_VERSION}.sh`, () => {
    expect(BASE_BRANCH_GUARD_HOOK).toBe(readFixture(BASE_BRANCH_GUARD_VERSION));
  });

  it('LEGACY_HOOK_BODIES["base-branch"] has exactly VERSION-1 entries', () => {
    expect(LEGACY_HOOK_BODIES["base-branch"].length).toBe(
      BASE_BRANCH_GUARD_VERSION - 1,
    );
  });

  // LOAD-BEARING: this assertion's violation IS the reported bug — a legacy
  // body that byte-compares "foreign" against a newer BASE_BRANCH_GUARD_HOOK
  // makes the guard warn forever instead of upgrading in place. If this
  // fails: bump BASE_BRANCH_GUARD_VERSION AND append the prior body to
  // LEGACY_HOOK_BODIES (plus a matching bin/fixtures/ fixture).
  it("every registered legacy body classifies as own-legacy or own-outdated, NEVER foreign", () => {
    for (const body of LEGACY_HOOK_BODIES["base-branch"]) {
      const classification = classifyPreCommitHook(body);
      expect(
        classification === "own-legacy" || classification === "own-outdated",
        `expected a registered legacy body to classify as own-legacy/own-outdated, got "${classification}". ` +
          "Bump BASE_BRANCH_GUARD_VERSION and add the prior body to LEGACY_HOOK_BODIES + a bin/fixtures/ fixture.",
      ).toBe(true);
    }
  });

  it("each registered legacy body is byte-equal to its bin/fixtures/ fixture (rendered bytes, not TS source)", () => {
    const bodies = LEGACY_HOOK_BODIES["base-branch"];
    for (let i = 0; i < bodies.length; i++) {
      const version = i + 1;
      expect(
        bodies[i],
        `LEGACY_HOOK_BODIES["base-branch"][${i}] (v${version}) does not match bin/fixtures/base-branch-guard-v${version}.sh. ` +
          "Fixtures must hold RENDERED hook bytes, not `git show <sha>:...` TS source.",
      ).toBe(readFixture(version));
    }
  });
});
