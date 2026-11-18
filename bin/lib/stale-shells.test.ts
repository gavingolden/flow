import { describe, expect, it } from "vitest";
import {
  ancestryOf,
  forPipelines,
  isClaudeToolShell,
  referencedPaths,
  selectStaleShells,
  toolShellCommand,
  type StaleRef,
} from "./stale-shells";
import type { OrphanProc } from "./worktree-orphans";

const HOME = "/Users/me";
const STATE = `${HOME}/.flow/state`;
const SELF_UID = 501;

const quoted = (body: string): string =>
  `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && eval '${body.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`;
const unquoted = (body: string): string =>
  `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && eval ${body} < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`;

function row(over: Partial<OrphanProc>): OrphanProc {
  return {
    pid: 100,
    ppid: 50,
    pgid: 100,
    uid: SELF_UID,
    tty: null,
    ageSec: 600,
    cpuSec: 0,
    command: "",
    cwd: null,
    ...over,
  };
}

const claude = row({ pid: 50, ppid: 1, pgid: 50, command: "claude --foo" });

function select(
  command: string,
  targets: Parameters<typeof forPipelines>[0],
  extra: Partial<OrphanProc> = {},
  opts: { exclude?: Set<number>; procs?: OrphanProc[] } = {},
) {
  const procs = opts.procs ?? [claude, row({ command, ...extra })];
  return selectStaleShells(procs, {
    selfUid: SELF_UID,
    exclude: opts.exclude ?? new Set(),
    minAgeSec: 60,
    home: HOME,
    stateDir: STATE,
    matches: forPipelines(targets, STATE),
  });
}

const INCIDENT = `until [ "$(jq -r .phase ~/.flow/state/vitest5-vite-upgrade.json)" = merged ] && tmux capture-pane -p | grep done ; do sleep 20; done`;
const SLUG = [{ slug: "vitest5-vite-upgrade" }];

describe("toolShellCommand", () => {
  it("should unwrap the quoted eval form and restore embedded quotes", () => {
    expect(toolShellCommand(quoted("echo 'hi' && ls"))).toBe("echo 'hi' && ls");
  });

  it("should unwrap the unquoted live form", () => {
    expect(toolShellCommand(unquoted("flow-manager-wait"))).toBe(
      "flow-manager-wait",
    );
  });

  it("should return null when the wrapper is absent", () => {
    expect(toolShellCommand("/bin/zsh -c sleep 5")).toBeNull();
  });
});

describe("referencedPaths", () => {
  it.each([
    ["~/", "~/.flow/state/foo.json"],
    ["$HOME/", "$HOME/.flow/state/foo.json"],
    ["${HOME}/", "${HOME}/.flow/state/foo.json"],
  ])("should expand the %s home form", (_n, p) => {
    expect(referencedPaths(`cat ${p}`, HOME, STATE)).toEqual([
      { kind: "state-file", path: `${STATE}/foo.json` },
    ]);
  });

  it("should expand a literal NAME assignment made earlier in the command", () => {
    const refs = referencedPaths(
      'slug="foo"; cat ~/.flow/state/${slug}.json',
      HOME,
      STATE,
    );
    expect(refs).toEqual([{ kind: "state-file", path: `${STATE}/foo.json` }]);
  });

  it("should treat the literal \\012 as a statement separator", () => {
    const refs = referencedPaths("s=foo\\012cat ~/.flow/state/$s.json", HOME, STATE);
    expect(refs.map((r) => r.path)).toEqual([`${STATE}/foo.json`]);
  });

  it("should find a worktree root and ignore files below the state dir", () => {
    const refs = referencedPaths(
      `cd ${HOME}/code/flow-worktrees.noindex/foo/sub && cat ~/.flow/state/procs/foo.jsonl`,
      HOME,
      STATE,
    );
    expect(refs).toEqual([
      { kind: "worktree", path: `${HOME}/code/flow-worktrees.noindex/foo` },
    ]);
  });
});

describe("forPipelines", () => {
  const m = (ref: StaleRef, t: Parameters<typeof forPipelines>[0]): boolean =>
    forPipelines(t, STATE)(ref);

  it("should never match foo against foo-bar state or worktree paths", () => {
    const t = [{ slug: "foo", worktree: "/x/flow-worktrees.noindex/foo" }];
    expect(m({ kind: "state-file", path: `${STATE}/foo-bar.json` }, t)).toBe(false);
    expect(m({ kind: "worktree", path: "/x/flow-worktrees.noindex/foo-bar" }, t)).toBe(false);
  });

  it("should match the slug's json and request files", () => {
    const t = [{ slug: "foo" }];
    expect(m({ kind: "state-file", path: `${STATE}/foo.json` }, t)).toBe(true);
    expect(m({ kind: "state-file", path: `${STATE}/foo.request.md` }, t)).toBe(true);
  });

  it("should match the recorded worktree exactly", () => {
    const t = [{ slug: "foo", worktree: "/x/flow-worktrees.noindex/foo" }];
    expect(m({ kind: "worktree", path: "/x/flow-worktrees.noindex/foo" }, t)).toBe(true);
  });
});

describe("isClaudeToolShell", () => {
  it("should accept a no-tty zsh child of claude without the wrapper", () => {
    expect(isClaudeToolShell(row({ command: "/bin/zsh -c sleep 1" }), "claude")).toBe(true);
  });

  it("should reject a no-tty node child of claude", () => {
    expect(isClaudeToolShell(row({ command: "node server.js" }), "claude")).toBe(false);
  });
});

describe("selectStaleShells", () => {
  it("should select the incident command inside the quoted wrapper", () => {
    const got = select(quoted(INCIDENT), SLUG);
    expect(got).toHaveLength(1);
    expect(got[0].pid).toBe(100);
    expect(got[0].ownerAlive).toBe(true);
    expect(got[0].preview.length).toBeLessThanOrEqual(80);
  });

  it("should select the unquoted live form and the \\012 form", () => {
    expect(select(unquoted(INCIDENT), SLUG)).toHaveLength(1);
    const nl = `s=vitest5-vite-upgrade\\012until [ "$(jq -r .phase ~/.flow/state/$s.json)" = merged ]; do sleep 20; done`;
    expect(select(quoted(nl), SLUG)).toHaveLength(1);
  });

  it("should select a variable-built state path", () => {
    const cmd = `s=vitest5-vite-upgrade; until [ "$(jq -r .phase ~/.flow/state/$s.json)" = merged ]; do sleep 20; done`;
    expect(select(quoted(cmd), SLUG)).toHaveLength(1);
  });

  it("should select the $HOME and ${HOME} forms", () => {
    for (const home of ["$HOME", "${HOME}"]) {
      const cmd = `until grep -q merged ${home}/.flow/state/vitest5-vite-upgrade.json; do sleep 5; done`;
      expect(select(quoted(cmd), SLUG)).toHaveLength(1);
    }
  });

  it("should select a shell only once every slug it watches has closed", () => {
    const cmd = "cat ~/.flow/state/a.json ~/.flow/state/b.json";
    expect(select(quoted(cmd), [{ slug: "a" }])).toHaveLength(0);
    expect(select(quoted(cmd), [{ slug: "a" }, { slug: "b" }])).toHaveLength(1);
  });

  it.each([
    "flow ls | grep vitest5-vite-upgrade",
    "until gh pr checks 412 --watch; do sleep 5; done",
    `ls ${HOME}/scratch/vitest5-vite-upgrade.json`,
  ])("should never select %s", (cmd) => {
    expect(select(quoted(cmd), SLUG)).toHaveLength(0);
  });

  it("should never select a flow helper, wrapped or after cd", () => {
    const wt = [{ slug: "foo", worktree: "/x/flow-worktrees.noindex/foo" }];
    expect(select(quoted("flow-remove-worktree /x/flow-worktrees.noindex/foo"), wt)).toHaveLength(0);
    expect(select(unquoted("flow-remove-worktree /x/flow-worktrees.noindex/foo"), wt)).toHaveLength(0);
    expect(select(quoted("cd /x/flow-worktrees.noindex/foo && flow-ci-wait"), wt)).toHaveLength(0);
  });

  it("should never select a shell it cannot unwrap", () => {
    expect(select(`/bin/zsh -c cat ${STATE}/foo.json`, [{ slug: "foo" }], {}, {
      procs: [claude, row({ command: `/bin/zsh -c cat ${STATE}/foo.json` })],
    })).toHaveLength(0);
  });

  it("should never select a no-tty node child of claude", () => {
    expect(select(`node ${STATE}/foo.json`, [{ slug: "foo" }])).toHaveLength(0);
  });

  it("should skip ancestors, excluded pids, young rows, other uids and non-leaders", () => {
    const cmd = quoted("cat ~/.flow/state/foo.json");
    const t = [{ slug: "foo" }];
    expect(select(cmd, t, {}, { exclude: new Set([100]) })).toHaveLength(0);
    expect(select(cmd, t, { ageSec: 5 })).toHaveLength(0);
    expect(select(cmd, t, { uid: 0 })).toHaveLength(0);
    expect(select(cmd, t, { pgid: 7 })).toHaveLength(0);
    expect(select(cmd, t, { tty: "ttys001" })).toHaveLength(0);
  });

  it("should mark the owner gone when the shell was reparented to init", () => {
    const got = select(quoted("cat ~/.flow/state/foo.json"), [{ slug: "foo" }], { ppid: 1 });
    expect(got[0].ownerAlive).toBe(false);
  });
});

describe("ancestryOf", () => {
  it("should walk parents up to the root", () => {
    const procs = [
      row({ pid: 3, ppid: 2 }),
      row({ pid: 2, ppid: 1 }),
      row({ pid: 1, ppid: 0 }),
    ];
    expect([...ancestryOf(3, procs)].sort()).toEqual([1, 2, 3]);
  });
});
