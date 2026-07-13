import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompletion } from "./completion";
import { resolveFlowSource } from "./paths";
import { VERBS } from "./verbs";

const FLOW_SOURCE = resolveFlowSource();

describe("flow completion", () => {
  let stderrSpy!: ReturnType<typeof vi.spyOn>;
  let captured!: string;
  let stderrCaptured!: string[];

  function out(s: string): void {
    captured += s;
  }

  beforeEach(() => {
    captured = "";
    stderrCaptured = [];
    stderrSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      stderrCaptured.push(msg);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("prints the bash script byte-for-byte", () => {
    const code = runCompletion("bash", { out });
    expect(code).toBe(0);
    const onDisk = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.bash"),
      "utf8",
    );
    expect(captured).toBe(onDisk);
  });

  it("prints the zsh script byte-for-byte", () => {
    const code = runCompletion("zsh", { out });
    expect(code).toBe(0);
    const onDisk = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.zsh"),
      "utf8",
    );
    expect(captured).toBe(onDisk);
  });

  it("exits 2 with an error message for an unsupported shell", () => {
    const code = runCompletion("fish", { out });
    expect(code).toBe(2);
    expect(stderrCaptured).toEqual([
      "flow completion: unsupported shell 'fish' (supported: bash, zsh)",
    ]);
    expect(captured).toBe("");
  });

  it("exits 2 when no shell is provided", () => {
    const code = runCompletion(undefined, { out });
    expect(code).toBe(2);
    expect(stderrCaptured[0]).toBe(
      "flow completion: shell argument is required",
    );
    expect(stderrCaptured[1]).toBe("usage: flow completion <bash|zsh>");
  });

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 with verb-specific help for '${flag}' (no fs read)`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runCompletion(flag, { out });
      expect(code).toBe(0);
      expect(captured).toBe("");
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(
        /^flow completion — print a shell completion/,
      );
      expect(stderrCaptured).toEqual([]);
      log.mockRestore();
    });

    it(`exits 0 and prints help for 'bash ${flag}' (no script emitted)`, () => {
      // Regression: `flow completion bash --help` previously printed the
      // bash completion script because runCompletion only inspected the
      // first arg. Every other verb honours --help anywhere — completion
      // must match.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runCompletion("bash", { out }, [flag]);
      expect(code).toBe(0);
      expect(captured).toBe("");
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(
        /^flow completion — print a shell completion/,
      );
      expect(stderrCaptured).toEqual([]);
      log.mockRestore();
    });
  }
});

describe("completion scripts stay in sync with VERBS", () => {
  // The verb-list-stays-in-sync property test: every verb dispatched by
  // bin/flow must appear in both shell scripts. Without this assertion, the
  // static scripts silently rot when a new verb lands. The test reads both
  // scripts from disk and looks for each verb as a whole-word match.
  //
  // Aliases (`a`) and short flags (`-v`, `-h`) have to use word-boundary
  // checks rather than substring checks to avoid spurious matches inside
  // longer words (e.g. "bash" contains "a"). The regex below requires a
  // non-word character on each side.

  function verbInScript(verb: string, script: string): boolean {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(script);
  }

  it("bash script lists every verb", () => {
    const script = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.bash"),
      "utf8",
    );
    const missing = VERBS.filter((v) => !verbInScript(v, script));
    expect(missing).toEqual([]);
  });

  it("zsh script lists every verb", () => {
    const script = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.zsh"),
      "utf8",
    );
    const missing = VERBS.filter((v) => !verbInScript(v, script));
    expect(missing).toEqual([]);
  });

  it("bash script contains the registration line", () => {
    const script = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.bash"),
      "utf8",
    );
    expect(script).toContain("complete -F _flow flow");
  });

  it("zsh script starts with the #compdef directive and ends with compdef registration", () => {
    const script = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.zsh"),
      "utf8",
    );
    expect(script.startsWith("#compdef flow")).toBe(true);
    expect(script).toContain("compdef _flow flow");
  });

  it("zsh `feature resume` completes a repeating slug list, not a single value", () => {
    // Pins the multi-slug resume intent: the `feature resume` subcommand path
    // must use the repeating `*::pipeline:_flow_slugs` rest-spec (mirroring
    // `done`), not the old single-value `--resume:pipeline:_flow_slugs` optarg.
    const script = fs.readFileSync(
      path.join(FLOW_SOURCE, "completions", "flow.zsh"),
      "utf8",
    );
    expect(script).toContain("'*::pipeline:_flow_slugs'");
    expect(script).not.toContain(
      "'--resume[resume a crashed pipeline]:pipeline:_flow_slugs'",
    );
  });

  it("both scripts advertise every per-phase --model-<phase> feature-create flag with the alias value set", () => {
    for (const shell of ["bash", "zsh"] as const) {
      const script = fs.readFileSync(
        path.join(FLOW_SOURCE, "completions", `flow.${shell}`),
        "utf8",
      );
      for (const flag of [
        "--model-planning",
        "--model-implement",
        "--model-review",
        "--model-verify",
        "--model-fix-applier",
        "--model-consolidator",
        "--model-merge-resolver",
      ]) {
        expect(
          script.includes(flag),
          `flow.${shell} must advertise the ${flag} feature-create flag`,
        ).toBe(true);
      }
      // The alias value set is offered for the per-phase flags.
      expect(script).toContain("opus haiku sonnet fable");
    }
  });

  it("both scripts advertise the config-group models subcommand + --slug/--json tokens", () => {
    for (const shell of ["bash", "zsh"] as const) {
      const script = fs.readFileSync(
        path.join(FLOW_SOURCE, "completions", `flow.${shell}`),
        "utf8",
      );
      for (const token of ["models", "--slug", "--json"]) {
        expect(
          script.includes(token),
          `flow.${shell} must advertise the config-group ${token} token`,
        ).toBe(true);
      }
    }
  });

  it("both scripts advertise the epic --model-planning (create) + --model (run), the bind/launch subcommands, and drop --model-judge", () => {
    for (const shell of ["bash", "zsh"] as const) {
      const script = fs.readFileSync(
        path.join(FLOW_SOURCE, "completions", `flow.${shell}`),
        "utf8",
      );
      expect(script).toContain("--model-planning");
      // The loop-era judgment knob is gone from both scripts.
      expect(script).not.toContain("--model-judge");
      // The new safe-write actuators complete (zsh uses `bind:<desc>`, bash a
      // bare word in the subcommand list — both contain the bare tokens).
      expect(script).toContain("bind");
      expect(script).toContain("launch");
    }
  });

  it("both scripts advertise epic run --effort and epic launch --model/--effort", () => {
    for (const shell of ["bash", "zsh"] as const) {
      const script = fs.readFileSync(
        path.join(FLOW_SOURCE, "completions", `flow.${shell}`),
        "utf8",
      );
      // `run`'s completion arm gains --effort alongside the existing --model.
      const runArm =
        shell === "bash"
          ? script.slice(
              script.indexOf('esub" = "run"'),
              script.indexOf('esub" = "status"'),
            )
          : script.slice(
              script.indexOf('line[2]" == run '),
              script.indexOf('line[2]" == status '),
            );
      expect(runArm).toContain("--effort");
      expect(runArm).toContain("low medium high xhigh max");

      // `launch`'s completion arm gains --model and --effort alongside --force.
      const launchArm =
        shell === "bash"
          ? script.slice(script.indexOf('esub" = "launch"'))
          : script.slice(script.indexOf('line[2]" == launch '));
      expect(launchArm).toContain("--model");
      expect(launchArm).toContain("--effort");
      expect(launchArm).toContain("opus haiku sonnet fable");
      expect(launchArm).toContain("low medium high xhigh max");
    }
  });

  it("both scripts complete the feature create/resume subcommands and drop new/setup/migrate", () => {
    // The `feature` mini-dispatcher must offer `create`/`resume` (mirroring
    // `epic`'s subcommand arm), and the removed verbs must not linger in the
    // top-level verb list.
    for (const shell of ["bash", "zsh"] as const) {
      const script = fs.readFileSync(
        path.join(FLOW_SOURCE, "completions", `flow.${shell}`),
        "utf8",
      );
      expect(script).toContain("create");
      expect(script).toContain("resume");
      // No lingering old verb arms / verb-list entries. `setup` and `migrate`
      // are pinnable as bare words (zero legitimate occurrences); `new` is NOT
      // bare-word-assertable because the `create` subcommand's description
      // ("start a new pipeline") legitimately contains the word.
      expect(script).not.toMatch(/(^|[^\w-])setup([^\w-]|$)/m);
      expect(script).not.toMatch(/(^|[^\w-])migrate([^\w-]|$)/m);
    }
  });
});
