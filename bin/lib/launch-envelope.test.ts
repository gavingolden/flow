import { describe, expect, it } from "vitest";
import { launchSpecFromEnvelope } from "./launch-envelope";

const env = (meta: unknown) => JSON.stringify({ meta });

function errorOf(raw: string): string {
  const r = launchSpecFromEnvelope(raw);
  if (r.ok) throw new Error("expected ok:false");
  return r.error;
}

describe("launchSpecFromEnvelope", () => {
  it("round-trips a launch containing a single quote verbatim", () => {
    const launch = `bash -lc 'echo "it'"'"'s up"'`;
    const r = launchSpecFromEnvelope(env({ launch }));
    expect(r).toEqual({
      ok: true,
      spec: { command: ["sh", "-c", launch], env: {} },
    });
  });

  it("passes meta.env through", () => {
    const r = launchSpecFromEnvelope(
      env({ launch: "npm run dev", env: { PORT: "4242", A: "b" } }),
    );
    expect(r).toEqual({
      ok: true,
      spec: {
        command: ["sh", "-c", "npm run dev"],
        env: { PORT: "4242", A: "b" },
      },
    });
  });

  it("fails each invalid shape with a distinct error", () => {
    const errors = [
      errorOf("{not json"),
      errorOf(JSON.stringify({ launch: "x" })),
      errorOf(env({ baseUrl: "http://localhost:1" })),
      errorOf(env({ launch: "   " })),
      errorOf(env({ launch: "x", env: ["a"] })),
      errorOf(env({ launch: "x", env: { PORT: 4242 } })),
      errorOf(env({ launch: "PORT={{PORT}} npm run dev" })),
      errorOf(
        env({ launch: "x", env: { URL: "http://localhost:{{PORT_BACKEND}}" } }),
      ),
    ];
    expect(errors.every((e) => e.length > 0)).toBe(true);
    expect(new Set(errors).size).toBe(errors.length);
  });

  it("names the failing reason", () => {
    expect(errorOf("{not json")).toMatch(/not valid JSON/);
    expect(errorOf(env({}))).toMatch(/meta\.launch/);
    expect(errorOf(env({ launch: "x", env: { PORT: 1 } }))).toMatch(
      /meta\.env\.PORT/,
    );
    expect(errorOf(env({ launch: "a {{PORT}}" }))).toMatch(/\{\{PORT/);
    expect(
      errorOf(env({ launch: "x", env: { U: "http://h:{{PORT_BACKEND}}" } })),
    ).toMatch(/meta\.env\.U/);
  });

  it("never echoes env values in an error", () => {
    const secret = "s3cr3t-value";
    const msg = errorOf(
      env({ launch: "x", env: { TOKEN: secret, BAD: { nested: secret } } }),
    );
    expect(msg).not.toContain(secret);
  });
});
