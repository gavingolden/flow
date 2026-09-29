import { describe, expect, it } from "vitest";
import {
  defaultDoctorDeps,
  doctorExitCode,
  guarded,
  renderDoctorText,
  runDoctor,
  type DoctorCheck,
  type DoctorDeps,
  type DoctorProbe,
} from "./doctor";

const deps = {} as DoctorDeps;

function check(over: Partial<DoctorCheck>): DoctorCheck {
  return {
    id: "x",
    section: "install",
    title: "Thing",
    status: "pass",
    summary: "fine",
    details: [],
    ...over,
  };
}

const probeOf =
  (...checks: DoctorCheck[]): DoctorProbe =>
  () =>
    checks;

describe("runDoctor aggregation", () => {
  it("counts every status and is ok with only pass/warn/skip", async () => {
    const report = await runDoctor(
      [
        probeOf(
          check({ status: "pass" }),
          check({ status: "warn", fix: "do a thing" }),
          check({ status: "skip" }),
        ),
      ],
      deps,
    );
    expect(report.version).toBe(1);
    expect(report.counts).toEqual({ pass: 1, warn: 1, fail: 0, skip: 1 });
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("is not ok and exits 1 when any check fails", async () => {
    const report = await runDoctor(
      [probeOf(check({ status: "fail", fix: "fix it" }), check({}))],
      deps,
    );
    expect(report.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  it("supports async probes and preserves check order", async () => {
    const asyncProbe: DoctorProbe = async () => [check({ id: "a" })];
    const report = await runDoctor(
      [asyncProbe, probeOf(check({ id: "b" }))],
      deps,
    );
    expect(report.checks.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("turns a throwing probe into one 'could not run' warn and keeps going", async () => {
    const boom: DoctorProbe = () => {
      throw new Error("kaput");
    };
    const report = await runDoctor(
      [boom, probeOf(check({ id: "after" }))],
      deps,
    );
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]).toMatchObject({
      status: "warn",
      summary: "could not run: kaput",
    });
    expect(report.checks[0].fix).toBeTruthy();
    expect(report.checks[1].id).toBe("after");
    expect(report.ok).toBe(true);
  });

  it("guarded() keeps the probe's own id and section on a throw", async () => {
    const wrapped = guarded(
      { id: "tools-gh", section: "tools", title: "gh" },
      async () => {
        throw new Error("spawn failed");
      },
    );
    const report = await runDoctor([wrapped], deps);
    expect(report.checks[0]).toMatchObject({
      id: "tools-gh",
      section: "tools",
      status: "warn",
      summary: "could not run: spawn failed",
    });
  });
});

describe("renderDoctorText", () => {
  const report = () =>
    runDoctor(
      [
        probeOf(
          check({
            id: "i",
            section: "install",
            status: "pass",
            title: "Links",
          }),
          check({
            id: "s",
            section: "shell",
            status: "fail",
            title: "PATH",
            summary: "missing",
            details: ["see /tmp/some/dir now"],
            fix: "export PATH=x",
          }),
          check({
            id: "t",
            section: "tools",
            status: "warn",
            title: "gh",
            summary: "old",
            fix: "gh auth login",
          }),
          check({
            id: "l",
            section: "leftovers",
            status: "skip",
            title: "Procs",
          }),
        ),
      ],
      deps,
    );

  it("groups by section with a symbol per status and a fix line under warn/fail", async () => {
    const out = renderDoctorText(await report(), {
      color: false,
      linkMode: "plain",
    });
    const idx = ["Install", "Shell", "Tools", "Leftovers"].map((h) =>
      out.indexOf(`\n${h}\n`),
    );
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(out).toContain("✓ Links: fine");
    expect(out).toContain("✗ PATH: missing");
    expect(out).toContain("! gh: old");
    expect(out).toContain("- Procs: fine");
    expect(out).toContain("fix: export PATH=x");
    expect(out).toContain("fix: gh auth login");
    expect(out.match(/fix:/g)).toHaveLength(2);
    expect(out).toContain("1 passed, 1 warnings, 1 failed, 1 skipped");
    expect(out).not.toContain("\x1b");
  });

  it("colors symbols only when asked and links detail paths only in a link mode", async () => {
    const colored = renderDoctorText(await report(), {
      color: true,
      linkMode: "markdown",
    });
    expect(colored).toContain("\x1b[31m✗\x1b[0m");
    expect(colored).toContain("[/tmp/some/dir](file://");
  });

  it("omits empty sections", async () => {
    const out = renderDoctorText(
      await runDoctor([probeOf(check({ section: "tools" }))], deps),
      { color: false, linkMode: "plain" },
    );
    expect(out).toContain("\nTools\n");
    expect(out).not.toContain("Install");
  });
});

describe("JSON shape", () => {
  it("serializes as {version, ok, counts, checks[]}", async () => {
    const report = await runDoctor([probeOf(check({}))], deps);
    expect(Object.keys(JSON.parse(JSON.stringify(report))).sort()).toEqual([
      "checks",
      "counts",
      "ok",
      "version",
    ]);
  });
});

describe("defaultDoctorDeps", () => {
  it("run() reports ENOENT as notFound and captures stdout", () => {
    const d = defaultDoctorDeps();
    expect(d.run("flow-no-such-binary-xyz", []).notFound).toBe(true);
    const ok = d.run("sh", ["-c", "echo hi"]);
    expect(ok).toMatchObject({ status: 0, stdout: "hi\n", timedOut: false });
  });

  it("run() flags a timeout", () => {
    const r = defaultDoctorDeps().run("sh", ["-c", "sleep 5"], {
      timeoutMs: 50,
    });
    expect(r.timedOut).toBe(true);
  });
});
