import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBinDirOnPath, checkFlowSlug } from "./doctor-env";
import { makeDeps } from "./doctor-test-deps";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-env-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writePhase(slug: string, phase: string): void {
  const dir = path.join(root, "home", ".flow", "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      slug,
      phase,
      repo: "/r",
      branch: slug,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

const withSlug = (FLOW_SLUG?: string) => makeDeps(root, { env: { FLOW_SLUG } });

describe("checkFlowSlug", () => {
  it("passes when FLOW_SLUG is unset or empty", () => {
    expect(checkFlowSlug(withSlug(undefined))[0].status).toBe("pass");
    expect(checkFlowSlug(withSlug(""))[0].status).toBe("pass");
  });

  it("fails on a malformed slug", () => {
    const [c] = checkFlowSlug(withSlug("Not A Slug!"));
    expect(c).toMatchObject({
      status: "fail",
      fix: "unset FLOW_SLUG FLOW_PIPELINE",
    });
  });

  it("fails when the slug has no state file", () => {
    const [c] = checkFlowSlug(withSlug("ghost-pipeline"));
    expect(c.status).toBe("fail");
    expect(c.summary).toContain("ghost-pipeline");
  });

  it.each(["merged", "cancelled"])("fails when the pipeline is %s", (phase) => {
    writePhase("done-one", phase);
    const [c] = checkFlowSlug(withSlug("done-one"));
    expect(c.status).toBe("fail");
    expect(c.fix).toBe("unset FLOW_SLUG FLOW_PIPELINE");
  });

  it.each(["implementing", "epic-approved", "gated", "needs-human"])(
    "warns, never fails, for a live %s pipeline",
    (phase) => {
      writePhase("live-one", phase);
      const [c] = checkFlowSlug(withSlug("live-one"));
      expect(c.status).toBe("warn");
      expect(c.summary).toBe("this shell belongs to pipeline live-one");
      expect(c.fix).toBe("unset FLOW_SLUG FLOW_PIPELINE");
    },
  );

  it("reads state from deps.stateDir, not an inherited FLOW_SLUG", () => {
    const prior = process.env.FLOW_SLUG;
    process.env.FLOW_SLUG = "inherited-slug";
    try {
      expect(checkFlowSlug(makeDeps(root, { env: {} }))[0].status).toBe("pass");
    } finally {
      if (prior === undefined) delete process.env.FLOW_SLUG;
      else process.env.FLOW_SLUG = prior;
    }
  });
});

describe("checkBinDirOnPath", () => {
  it("passes when the install bin dir is a PATH segment", () => {
    const deps = makeDeps(root);
    const [c] = checkBinDirOnPath({
      ...deps,
      env: { PATH: `/usr/bin:${deps.targets.binDir}` },
    });
    expect(c.status).toBe("pass");
  });

  it("fails with the export fix and names the bun fallback when it is absent", () => {
    const [c] = checkBinDirOnPath(
      makeDeps(root, { env: { PATH: "/usr/bin:/bin" } }),
    );
    expect(c.status).toBe("fail");
    expect(c.fix).toBe(
      'export PATH="$HOME/.local/bin:$PATH" (add it to your shell rc)',
    );
    expect(c.details.join(" ")).toContain(
      "bun <flow checkout>/bin/flow doctor",
    );
  });

  it("fails on a missing PATH entirely", () => {
    expect(checkBinDirOnPath(makeDeps(root, { env: {} }))[0].status).toBe(
      "fail",
    );
  });
});
