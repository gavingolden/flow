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
  type ScopedGrant,
} from "./manager-grants";
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

function seed(slug: string, epic?: { slug: string; featureId: string }) {
  writeState(
    {
      slug,
      phase: "planning",
      repo: "/r/flow",
      worktree: "/w",
      updatedAt: "2026-10-26T00:00:00.000Z",
      ...(epic ? { epic } : {}),
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
