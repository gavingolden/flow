import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnPipelinePr } from "./pipeline-pr-ownership";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pr-ownership-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seed(slug: string, extra: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify({
      slug,
      phase: "reviewing",
      repo: "/tmp/repo",
      updatedAt: "2026-05-22T11:00:00Z",
      ...extra,
    }),
  );
}

describe("checkOwnPipelinePr", () => {
  it("refuses a PR that is not state.pr", () => {
    seed("my-slug", { pr: 5 });
    expect(
      checkOwnPipelinePr(6, { env: { FLOW_SLUG: "my-slug" }, stateDir }),
    ).toEqual({ ok: false, reason: "pr-not-owned: state.pr is 5, not #6" });
  });

  it("allows the pipeline's own PR", () => {
    seed("my-slug", { pr: 5 });
    expect(
      checkOwnPipelinePr(5, { env: { FLOW_SLUG: "my-slug" }, stateDir }),
    ).toEqual({ ok: true });
  });

  it("names an unset state.pr", () => {
    seed("my-slug", {});
    expect(
      checkOwnPipelinePr(5, { env: { FLOW_SLUG: "my-slug" }, stateDir }),
    ).toEqual({ ok: false, reason: "pr-not-owned: state.pr is unset, not #5" });
  });

  it("refuses when the slug has no state file", () => {
    expect(
      checkOwnPipelinePr(5, { env: { FLOW_SLUG: "ghost" }, stateDir }),
    ).toEqual({ ok: false, reason: "no-pipeline-state: ghost" });
  });

  it("does not check when no slug resolves", () => {
    expect(checkOwnPipelinePr(5, { env: {}, stateDir })).toEqual({ ok: true });
  });
});
