import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Spawner } from "./git";
import {
  collectInstallNamesSafe,
  collectInstallOnlyNames,
  isGateEligible,
  matchInstallDependent,
  partitionAfterMerge,
  type InstallOnlyName,
} from "./install-only-names";

const BASE_VERBS = `export const VERBS = [\n  "install",\n  "feature",\n] as const;\n`;
const HEAD_VERBS = `export const VERBS = [\n  "install",\n  "manage",\n  "feature",\n  "--help",\n] as const;\n`;

let repo: string;

function write(rel: string, text: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function fakeSpawn(
  diff: string,
  show: Record<string, string> = {},
  diffStatus = 0,
): Spawner {
  return (_cmd, args) => {
    if (args[0] === "diff")
      return { status: diffStatus, stdout: diff } as ReturnType<Spawner>;
    if (args[0] === "show") {
      const body = show[args[1]];
      return (
        body === undefined
          ? { status: 128, stdout: "" }
          : { status: 0, stdout: body }
      ) as ReturnType<Spawner>;
    }
    return { status: 0, stdout: "" } as ReturnType<Spawner>;
  };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "install-only-"));
  write("bin/lib/modules.ts", "");
  write(
    "skills/pipeline/flow-manage/SKILL.md",
    "---\nname: flow-module-core:flow-manage\n---\n",
  );
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const PR_1064 = [
  "A\tbin/flow-manager-wait.ts",
  "A\tbin/flow-manager-wait.test.ts",
  "M\tbin/flow-eval.ts",
  "M\tbin/lib/verbs.ts",
  "A\tskills/pipeline/flow-manage/SKILL.md",
  "A\tskills/pipeline/flow-manage/references/x.md",
].join("\n");

const show = {
  "HEAD:bin/lib/verbs.ts": HEAD_VERBS,
  "origin/main:bin/lib/verbs.ts": BASE_VERBS,
};

describe("collectInstallOnlyNames", () => {
  it("collects the helper, verb and skill a PR adds, and skips tests and maintainer-only helpers", () => {
    const names = collectInstallOnlyNames(repo, {
      base: "origin/main",
      spawn: fakeSpawn(PR_1064, show),
    });
    expect(names).toEqual([
      { name: "flow-manager-wait", kind: "helper", change: "added" },
      { name: "flow-manage", kind: "skill", change: "added" },
      { name: "manage", kind: "verb", change: "added" },
    ]);
  });

  it("marks a modified helper and a modified skill as modified", () => {
    const names = collectInstallOnlyNames(repo, {
      base: "origin/main",
      spawn: fakeSpawn(
        "M\tbin/flow-x.ts\nM\tskills/pipeline/flow-manage/SKILL.md",
      ),
    });
    expect(names).toEqual([
      { name: "flow-x", kind: "helper", change: "modified" },
      { name: "flow-manage", kind: "skill", change: "modified" },
    ]);
    expect(names!.map(isGateEligible)).toEqual([false, true]);
  });

  it("treats a renamed helper's new path as added", () => {
    const names = collectInstallOnlyNames(repo, {
      base: "origin/main",
      spawn: fakeSpawn("R090\tbin/flow-old.ts\tbin/flow-new.ts"),
    });
    expect(names).toEqual([
      { name: "flow-new", kind: "helper", change: "added" },
    ]);
  });

  it("returns [] outside a flow checkout without calling git", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
    try {
      const spawn: Spawner = () => {
        throw new Error("git must not run");
      };
      expect(collectInstallOnlyNames(other, { spawn })).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("returns null when git fails", () => {
    expect(
      collectInstallOnlyNames(repo, {
        base: "origin/main",
        spawn: fakeSpawn("", {}, 128),
      }),
    ).toBeNull();
  });

  it("returns null when verbs.ts changed but the base copy is unreadable", () => {
    expect(
      collectInstallOnlyNames(repo, {
        base: "origin/main",
        spawn: fakeSpawn("M\tbin/lib/verbs.ts", {
          "HEAD:bin/lib/verbs.ts": HEAD_VERBS,
        }),
      }),
    ).toBeNull();
  });

  it("collectInstallNamesSafe maps a throwing spawner to null and a missing repo to []", () => {
    const boom: Spawner = () => {
      throw new Error("boom");
    };
    expect(collectInstallNamesSafe(repo, "origin/main", boom)).toBeNull();
    expect(collectInstallNamesSafe(undefined, "origin/main")).toEqual([]);
  });
});

describe("matchInstallDependent", () => {
  const names: InstallOnlyName[] = [
    { name: "flow-manager-wait", kind: "helper", change: "added" },
    { name: "manage", kind: "verb", change: "added" },
    { name: "flow-manage", kind: "skill", change: "added" },
  ];

  it.each([
    ["Run `flow-manager-wait --x` and confirm exit 0", "flow-manager-wait"],
    ["Run `flow manage` and read the window", "manage"],
    ["Open a session and run /flow-manage", "flow-manage"],
  ])("matches %s", (text, name) => {
    expect(matchInstallDependent(text, names)?.name).toBe(name);
  });

  it.each([
    "Run `bun bin/flow-manager-wait.ts` and confirm exit 0",
    "Run `bin/flow-manager-wait.test.ts`",
    "Read `skills/pipeline/flow-manage/SKILL.md`",
    "flow-manager-wait is mentioned in prose only",
    "Run `bun bin/flow manage` from the worktree",
    "Run `flow-eval --x`",
  ])("does not match %s", (text) => {
    expect(matchInstallDependent(text, names)).toBeNull();
  });

  it("prefers a gate-eligible match over a modified helper", () => {
    const mixed: InstallOnlyName[] = [
      { name: "flow-x", kind: "helper", change: "modified" },
      { name: "manage", kind: "verb", change: "added" },
    ];
    expect(
      matchInstallDependent("`flow-x` then `flow manage`", mixed)?.name,
    ).toBe("manage");
  });
});

describe("partitionAfterMerge", () => {
  const names: InstallOnlyName[] = [
    { name: "manage", kind: "verb", change: "added" },
  ];
  const verified =
    "After merge: run `flow manage` and watch it claim the window";
  const unverified = "After merge: run `flow other` and watch it";
  const unmarked = "Run `flow manage` and watch it";

  it("excludes a verified After merge item", () => {
    const r = partitionAfterMerge([verified], names);
    expect(r.afterMerge).toEqual([verified]);
    expect(r.counted).toEqual([]);
  });

  it("keeps an unverified After merge item counted", () => {
    const r = partitionAfterMerge([unverified], names);
    expect(r.counted).toEqual([unverified]);
    expect(r.unverifiedAfterMerge).toEqual([unverified]);
  });

  it("counts everything when names is null", () => {
    const r = partitionAfterMerge([verified], null);
    expect(r.counted).toEqual([verified]);
    expect(r.afterMerge).toEqual([]);
    expect(r.unverifiedAfterMerge).toEqual([verified]);
  });

  it("counts an unmarked install-dependent item and lists it in needsInstall", () => {
    const r = partitionAfterMerge([{ text: `- [ ] ${unmarked}` }], names);
    expect(r.counted).toEqual([`- [ ] ${unmarked}`]);
    expect(r.needsInstall).toEqual([
      { item: `- [ ] ${unmarked}`, name: "manage", kind: "verb" },
    ]);
  });

  it("records the new skill, not the existing verb it quotes", () => {
    const item = "Run `flow status` then invoke /flow-new-thing";
    const r = partitionAfterMerge(
      [item],
      [{ name: "flow-new-thing", kind: "skill", change: "added" }],
    );
    expect(r.needsInstall).toEqual([
      { item, name: "flow-new-thing", kind: "skill" },
    ]);
  });

  it("records the new helper, not the existing helper it quotes", () => {
    const item = "Run `flow-ci-wait` then `flow-gate-x`";
    const r = partitionAfterMerge(
      [item],
      [{ name: "flow-gate-x", kind: "helper", change: "added" }],
    );
    expect(r.needsInstall).toEqual([
      { item, name: "flow-gate-x", kind: "helper" },
    ]);
  });
});
