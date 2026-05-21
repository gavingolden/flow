/**
 * Regression tests for `.github/workflows/*.yml` against bug classes we've
 * shipped at least once. Lives in `bin/` so the existing `scripts` scope (now
 * also claiming `.github/workflows/`) runs it on every workflow or helper edit.
 *
 * No YAML parser dependency — `js-yaml` / `yaml` are not in flow's deps and
 * adding one for a regression-shape check is heavier than the bug surface
 * warrants. Line-oriented scans against the original byte stream are
 * sufficient for the checks below.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = path.resolve(__dirname, "../.github/workflows");

function listWorkflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(WORKFLOWS_DIR, name));
}

describe("reusable-workflow self-checkout SHA resolution (regression: PR #158 + this-PR follow-up)", () => {
  // Both `github.workflow_sha` and `github.workflow_ref` resolve to the
  // *caller's* values when the workflow file is loaded via `uses:` from
  // another repo (or another workflow in the same repo). A reusable
  // workflow that uses `ref: ${{ github.workflow_sha }}` or `ref: ${{
  // github.workflow_ref }}` on its own self-checkout step is therefore
  // checking out the wrong revision — the bug class covers both `_sha`
  // and `_ref` resolution cases. PR #158 (merge SHA b464d2c) is the
  // originating bug-class anchor: it shipped a fix that swapped from
  // `_sha` to `_ref` on the premise that `_ref` would resolve called-
  // side, but empirically `_ref` resolves caller-side too. The correct
  // alternative is `job.workflow_ref` / `job.workflow_sha` (per the
  // `job` context table). This test asserts both broken fields stay out
  // of self-checkout `ref:` lines.
  const files = listWorkflowFiles();

  if (files.length === 0) {
    it.skip("no .github/workflows/ files found", () => {});
    return;
  }

  for (const file of files) {
    const rel = path.relative(path.resolve(__dirname, ".."), file);
    const body = fs.readFileSync(file, "utf8");
    const isReusable = /^\s*workflow_call:/m.test(body);
    if (!isReusable) continue;

    it(`${rel} (reusable workflow) does not use github.workflow_sha as a self-checkout ref`, () => {
      // Match any `ref:` line whose value is `${{ github.workflow_sha }}`
      // (with arbitrary surrounding whitespace). The bug class is specifically
      // "ref pinned to caller's SHA"; non-`ref:` uses of github.workflow_sha
      // (e.g. logging it) are legitimate.
      const offending = body
        .split(/\r?\n/)
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line }) => /^\s*ref:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/.test(line));

      expect(offending).toEqual([]);
    });

    it(`${rel} (reusable workflow) does not use github.workflow_ref as a self-checkout ref`, () => {
      // Match any `ref:` line whose value is `${{ github.workflow_ref }}`
      // (with arbitrary surrounding whitespace). Same bug class as the
      // `_sha` case — `github.workflow_ref` also resolves caller-side
      // inside a reusable workflow. Non-`ref:` uses (e.g. diagnostic
      // logging) are legitimate and left alone.
      const offending = body
        .split(/\r?\n/)
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line }) => /^\s*ref:\s*\$\{\{\s*github\.workflow_ref\s*\}\}/.test(line));

      expect(offending).toEqual([]);
    });
  }
});

describe("ci.yml verify-gate workflow shape (regression: PR #207)", () => {
  // ci.yml is not a reusable workflow, so the loop above (`if (!isReusable)
  // continue;`) gives it zero assertions. These checks are the regression
  // home for the workflow's own correctness — SHA-pinned actions, both
  // runtimes, the PR + push-to-main triggers — replacing the one-shot grep
  // checks the PR #207 Test Steps section carried as a manual checklist.
  const CI_YML = path.join(WORKFLOWS_DIR, "ci.yml");

  if (!fs.existsSync(CI_YML)) {
    it.skip("ci.yml not found", () => {});
    return;
  }

  const body = fs.readFileSync(CI_YML, "utf8");

  it("invokes `npm run verify`", () => {
    expect(body).toMatch(/npm run verify/);
  });

  it("triggers on pull_request and on push to main", () => {
    expect(body).toMatch(/^\s*pull_request:/m);
    expect(body).toMatch(/branches:\s*\[\s*main\s*\]/);
  });

  it("sets up both Node and Bun runtimes", () => {
    expect(body).toMatch(/actions\/setup-node@/);
    expect(body).toMatch(/oven-sh\/setup-bun@/);
  });

  it("SHA-pins every third-party action to a 40-char commit", () => {
    const usesLines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("uses:") || line.startsWith("- uses:"));

    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      // `uses: owner/repo@<sha>` — the ref after `@` must be a full 40-char
      // hex SHA, never a mutable tag or branch.
      expect(line).toMatch(/uses:\s*[^@\s]+@[0-9a-f]{40}\b/);
    }
  });
});
