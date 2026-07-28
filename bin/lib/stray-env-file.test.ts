import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  detectStrayEnvFiles,
  strayEnvWarning,
  STRAY_ENV_FILENAMES,
} from "./stray-env-file";
import { BRANCH_MARKER_FILENAME } from "./worktree-marker";

const WORKTREE_DIR = "/tmp/fake-worktree";
const MARKER_PATH = path.join(WORKTREE_DIR, BRANCH_MARKER_FILENAME);
const ENV_LOCAL_PATH = path.join(WORKTREE_DIR, ".env.local");

describe("detectStrayEnvFiles", () => {
  it("detects a .env.local present beside the .flow-branch marker", () => {
    const exists = (p: string) => p === MARKER_PATH || p === ENV_LOCAL_PATH;
    const result = detectStrayEnvFiles(WORKTREE_DIR, { exists });
    expect(result).toEqual([ENV_LOCAL_PATH]);
    // Detection never deletes — the fake fs seam is untouched, and no
    // deletion API is exposed at all.
    expect(exists(ENV_LOCAL_PATH)).toBe(true);
  });

  it("returns [] for the same file when the .flow-branch marker is absent", () => {
    const exists = (p: string) => p === ENV_LOCAL_PATH;
    expect(detectStrayEnvFiles(WORKTREE_DIR, { exists })).toEqual([]);
  });

  it("returns [] when the marker exists but no stray file is present", () => {
    const exists = (p: string) => p === MARKER_PATH;
    expect(detectStrayEnvFiles(WORKTREE_DIR, { exists })).toEqual([]);
  });

  it("detects every present sibling filename, not just .env.local", () => {
    const exists = (p: string) =>
      p === MARKER_PATH ||
      p === path.join(WORKTREE_DIR, ".env.test.local") ||
      p === path.join(WORKTREE_DIR, ".env.production.local");
    const result = detectStrayEnvFiles(WORKTREE_DIR, { exists });
    expect(result).toEqual([
      path.join(WORKTREE_DIR, ".env.test.local"),
      path.join(WORKTREE_DIR, ".env.production.local"),
    ]);
  });

  it("STRAY_ENV_FILENAMES carries the four documented env-override filenames", () => {
    expect(STRAY_ENV_FILENAMES).toEqual([
      ".env.local",
      ".env.development.local",
      ".env.test.local",
      ".env.production.local",
    ]);
  });
});

describe("strayEnvWarning", () => {
  it("names each path in the advisory", () => {
    const warning = strayEnvWarning([ENV_LOCAL_PATH]);
    expect(warning).toContain(ENV_LOCAL_PATH);
    expect(warning).toContain("flow never writes");
    expect(warning).toContain(".flow/ui-validation.json");
  });

  it("returns '' for an empty list", () => {
    expect(strayEnvWarning([])).toBe("");
  });
});
