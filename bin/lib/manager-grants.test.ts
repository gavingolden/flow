import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EpicManifest } from "./epic-manifest-schema";
import {
  grantForEpic,
  grantForSlug,
  liveGrants,
  readGrants,
  removeGrant,
  resolveGrant,
  upsertGrant,
  withdrawPipelineGrant,
  type ScopedGrant,
} from "./manager-grants";
import { appendManagerLog, readManagerLog } from "./manager-log";
import { writeState } from "./state";

let dir: string;
let stateDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgrants-"));
  stateDir = path.join(dir, "state");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-01T00:00:00.000Z");
const grant = (
  scope: string,
  over: Partial<ScopedGrant> = {},
): ScopedGrant => ({
  scope,
  classes: ["plan"],
  grantedAt: "2026-10-26T00:00:00.000Z",
  grantedBy: "owner-cli",
  ...over,
});
const id = { slug: "x", epic: "e", repo: "flow" };

const manifest: EpicManifest = {
  epicId: "e",
  prompt: "p",
  createdAt: "t",
  features: [{ id: "f1", title: "t", description: "d", dependsOn: [] }],
};

function seed(
  slug: string,
  epic?: { slug: string; featureId: string },
  createdAt?: string,
) {
  writeState(
    {
      slug,
      phase: "planning",
      repo: "/r/flow",
      worktree: "/w",
      updatedAt: "2026-10-26T00:00:00.000Z",
      ...(epic ? { epic } : {}),
      ...(createdAt ? { createdAt } : {}),
    },
    stateDir,
  );
}

describe("grants.json store", () => {
  it("reads missing or malformed files as no grants and skips bad entries", () => {
    expect(readGrants(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "grants.json"), "not json");
    expect(readGrants(dir)).toEqual([]);
    fs.writeFileSync(
      path.join(dir, "grants.json"),
      JSON.stringify({
        version: 1,
        grants: [grant("repo:flow"), { scope: "all", classes: ["plan"] }],
      }),
    );
    expect(readGrants(dir).map((g) => g.scope)).toEqual(["repo:flow"]);
  });

  it("keeps one entry per scope on upsert and removes by scope", () => {
    upsertGrant(grant("repo:flow"), dir);
    upsertGrant(grant("repo:flow", { classes: ["plan", "subjective"] }), dir);
    upsertGrant(grant("epic:e"), dir);
    expect(readGrants(dir)).toHaveLength(2);
    expect(readGrants(dir)[0].classes).toEqual(["plan", "subjective"]);
    expect(removeGrant("epic:e", dir)).toBe(true);
    expect(removeGrant("epic:e", dir)).toBe(false);
    expect(readGrants(dir).map((g) => g.scope)).toEqual(["repo:flow"]);
  });

  it("an expired grant is not live", () => {
    upsertGrant(
      grant("repo:flow", { expiresAt: "2026-10-31T00:00:00.000Z" }),
      dir,
    );
    upsertGrant(
      grant("epic:e", { expiresAt: "2026-11-02T00:00:00.000Z" }),
      dir,
    );
    expect(liveGrants(NOW, dir).map((g) => g.scope)).toEqual(["epic:e"]);
  });
});

describe("resolveGrant", () => {
  it("the most specific live grant wins; after it expires the broader one does", () => {
    upsertGrant(grant("repo:flow"), dir);
    upsertGrant(
      grant("pipeline:x", {
        classes: ["plan", "subjective"],
        expiresAt: "2026-11-02T00:00:00.000Z",
      }),
      dir,
    );
    expect(resolveGrant(id, NOW, dir)?.scope).toBe("pipeline:x");
    expect(
      resolveGrant(id, new Date("2026-11-03T00:00:00.000Z"), dir)?.scope,
    ).toBe("repo:flow");
  });

  it("unions classes across every live covering grant", () => {
    upsertGrant(grant("repo:flow", { classes: ["plan", "subjective"] }), dir);
    upsertGrant(grant("epic:e"), dir);
    expect(resolveGrant(id, NOW, dir)).toEqual({
      scope: "epic:e",
      classes: ["plan", "subjective"],
    });
  });

  it("a loose pipeline is covered by pipeline: and repo: but not epic:", () => {
    const loose = { slug: "x", repo: "flow" };
    upsertGrant(grant("epic:e"), dir);
    expect(resolveGrant(loose, NOW, dir)).toBeNull();
    upsertGrant(grant("repo:flow"), dir);
    expect(resolveGrant(loose, NOW, dir)?.scope).toBe("repo:flow");
    upsertGrant(grant("pipeline:x"), dir);
    expect(resolveGrant(loose, NOW, dir)?.scope).toBe("pipeline:x");
  });

  it("returns null with no covering grant", () => {
    upsertGrant(grant("repo:other"), dir);
    expect(resolveGrant(id, NOW, dir)).toBeNull();
  });
});

describe("grantForSlug", () => {
  const deps = () => ({
    stateDir,
    home: dir,
    now: () => NOW,
    loadManifest: () => manifest,
  });

  it("reports state-missing, no-grant and other-epic", () => {
    expect(grantForSlug("ghost", deps())).toEqual({
      granted: false,
      reason: "state-missing",
    });
    seed("feat", { slug: "e", featureId: "f1" });
    expect(grantForSlug("feat", deps())).toEqual({
      granted: false,
      reason: "no-grant",
    });
    upsertGrant(grant("epic:e"), dir);
    expect(grantForSlug("feat", { ...deps(), expectedEpic: "z" })).toEqual({
      granted: false,
      reason: "other-epic",
    });
  });

  it("an epic feature still has to be in its manifest", () => {
    seed("feat", { slug: "e", featureId: "f1" });
    seed("gone", { slug: "e", featureId: "f9" });
    upsertGrant(grant("epic:e"), dir);
    expect(grantForSlug("feat", deps())).toEqual({
      granted: true,
      scope: "epic:e",
      classes: ["plan"],
      epic: "e",
      featureId: "f1",
    });
    expect(grantForSlug("gone", deps())).toEqual({
      granted: false,
      reason: "unknown-feature",
    });
  });

  it("a loose pipeline is granted with no epic and no manifest check", () => {
    seed("solo");
    upsertGrant(grant("pipeline:solo"), dir);
    expect(grantForSlug("solo", deps())).toEqual({
      granted: true,
      scope: "pipeline:solo",
      classes: ["plan"],
    });
  });
});

describe("grantForSlug — reused slug (#1047)", () => {
  const deps = () => ({ stateDir, home: dir, now: () => NOW });
  const CREATED = "2026-10-27T00:00:00.000Z";

  it("ignores a pipeline grant given before the state was created", () => {
    seed("solo", undefined, CREATED);
    upsertGrant(grant("pipeline:solo"), dir);
    expect(grantForSlug("solo", deps())).toEqual({
      granted: false,
      reason: "no-grant",
    });
  });

  it("honours a pipeline grant given after the state was created", () => {
    seed("solo", undefined, CREATED);
    upsertGrant(
      grant("pipeline:solo", { grantedAt: "2026-10-28T00:00:00.000Z" }),
      dir,
    );
    expect(grantForSlug("solo", deps())).toMatchObject({
      granted: true,
      scope: "pipeline:solo",
    });
  });

  it("an older repo: grant still applies", () => {
    seed("solo", undefined, CREATED);
    upsertGrant(grant("repo:flow"), dir);
    upsertGrant(grant("pipeline:solo"), dir);
    expect(grantForSlug("solo", deps())).toMatchObject({
      granted: true,
      scope: "repo:flow",
    });
  });

  it("ignores a pipeline grant whose grantedAt is unparseable", () => {
    seed("solo", undefined, CREATED);
    upsertGrant(grant("pipeline:solo", { grantedAt: "garbage" }), dir);
    expect(grantForSlug("solo", deps())).toEqual({
      granted: false,
      reason: "no-grant",
    });
  });

  it("keeps today's behaviour when the state has no createdAt", () => {
    seed("solo");
    upsertGrant(grant("pipeline:solo"), dir);
    expect(grantForSlug("solo", deps())).toMatchObject({ granted: true });
  });
});

describe("withdrawPipelineGrant", () => {
  const opts = (
    over: Partial<Parameters<typeof withdrawPipelineGrant>[1]> = {},
  ) => ({
    repo: (prior?: string) => prior ?? "fallback",
    reason: "slug-reused",
    now: NOW,
    home: dir,
    ...over,
  });
  const logLines = () =>
    readManagerLog({ slug: "solo" }, dir).filter(
      (e) => e.kind === "grant-withdrawn",
    );

  it("removes the grant and writes one grant-withdrawn line", () => {
    upsertGrant(grant("pipeline:solo"), dir);
    expect(withdrawPipelineGrant("solo", opts())).toEqual({ removed: true });
    expect(readGrants(dir)).toEqual([]);
    expect(logLines()).toMatchObject([
      {
        kind: "grant-withdrawn",
        scope: "pipeline:solo",
        slug: "solo",
        reason: "slug-reused",
        repo: "fallback",
        ts: NOW.toISOString(),
      },
    ]);
  });

  it("hands the prior grant line's repo to the repo thunk", () => {
    upsertGrant(grant("pipeline:solo"), dir);
    appendManagerLog(
      {
        ts: "2026-10-26T00:00:00.000Z",
        kind: "grant",
        scope: "pipeline:solo",
        repo: "flow",
        slug: "solo",
      },
      { home: dir },
    );
    withdrawPipelineGrant("solo", opts());
    expect(logLines()[0].repo).toBe("flow");
  });

  it("leaves repo: and other-slug grants alone", () => {
    upsertGrant(grant("pipeline:solo"), dir);
    upsertGrant(grant("pipeline:other"), dir);
    upsertGrant(grant("repo:flow"), dir);
    withdrawPipelineGrant("solo", opts());
    expect(
      readGrants(dir)
        .map((g) => g.scope)
        .sort(),
    ).toEqual(["pipeline:other", "repo:flow"]);
  });

  it("returns removed:false and writes no log when no grant exists", () => {
    upsertGrant(grant("repo:flow"), dir);
    expect(withdrawPipelineGrant("solo", opts())).toEqual({ removed: false });
    expect(logLines()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "log.jsonl"))).toBe(false);
  });

  it("reports a log failure but keeps the grant removed", () => {
    upsertGrant(grant("pipeline:solo"), dir);
    const r = withdrawPipelineGrant(
      "solo",
      opts({
        repo: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r).toEqual({ removed: true, logError: "boom" });
    expect(readGrants(dir)).toEqual([]);
  });
});

describe("grantForEpic", () => {
  it("returns the narrowest live grant covering the epic, epic: over repo:", () => {
    expect(grantForEpic("e", "flow", NOW, dir)).toBeNull();
    upsertGrant(grant("repo:flow"), dir);
    expect(grantForEpic("e", "flow", NOW, dir)?.scope).toBe("repo:flow");
    upsertGrant(grant("epic:e"), dir);
    expect(grantForEpic("e", "flow", NOW, dir)?.scope).toBe("epic:e");
    expect(grantForEpic("e", "other", NOW, dir)?.scope).toBe("epic:e");
    expect(grantForEpic("z", "other", NOW, dir)).toBeNull();
  });
});

describe("the relay class", () => {
  it("survives a read, so a relay-only grant is not silently dropped", () => {
    upsertGrant(grant("repo:flow", { classes: ["relay"] }), dir);
    expect(readGrants(dir)[0].classes).toEqual(["relay"]);
  });

  it("a relay-only grant covers the slug but carries no plan class", () => {
    seed("solo");
    upsertGrant(grant("pipeline:solo", { classes: ["relay"] }), dir);
    const r = grantForSlug("solo", {
      stateDir,
      home: dir,
      now: () => NOW,
      loadManifest: () => manifest,
    });
    expect(r).toMatchObject({ granted: true, classes: ["relay"] });
  });

  it("grantForEpic unions classes, so a narrow relay grant never strips a broader plan class", () => {
    upsertGrant(grant("repo:flow"), dir);
    upsertGrant(grant("epic:e", { classes: ["relay"] }), dir);
    const g = grantForEpic("e", "flow", NOW, dir);
    expect(g?.scope).toBe("epic:e");
    expect(g?.classes).toEqual(["plan", "relay"]);
  });
});
