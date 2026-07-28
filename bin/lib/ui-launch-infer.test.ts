import { describe, expect, it } from "vitest";
import {
  allocFreePort,
  allocFreePorts,
  collectPortSentinels,
  findMalformedPortSentinels,
  inferLaunch,
  PORT_PLACEHOLDER,
  resolvePortPlaceholder,
  resolvePorts,
} from "./ui-launch-infer";
import * as net from "node:net";

describe("inferLaunch — Story 3", () => {
  it("prefers scripts.dev over scripts.start", () => {
    const info = inferLaunch(
      JSON.stringify({ scripts: { dev: "vite", start: "node server" } }),
    );
    expect(info).not.toBeNull();
    expect(info!.launch).toContain("npm run dev");
    expect(info!.launch).not.toContain("npm run start");
  });

  it("falls back to scripts.start when dev is absent", () => {
    const info = inferLaunch(JSON.stringify({ scripts: { start: "node s" } }));
    expect(info!.launch).toContain("npm run start");
  });

  it("returns null when neither dev nor start exists", () => {
    expect(
      inferLaunch(JSON.stringify({ scripts: { build: "tsc" } })),
    ).toBeNull();
  });

  it("returns null when scripts is missing entirely", () => {
    expect(inferLaunch(JSON.stringify({ name: "x" }))).toBeNull();
  });

  it("returns null on malformed JSON without throwing", () => {
    expect(inferLaunch("{ not json")).toBeNull();
  });

  it("the persisted form carries the {{PORT}} placeholder, never a frozen port", () => {
    const info = inferLaunch(JSON.stringify({ scripts: { dev: "vite" } }))!;
    expect(info.launch).toContain(PORT_PLACEHOLDER);
    expect(info.baseUrl).toContain(PORT_PLACEHOLDER);
    // No frozen literal port digits leaked into the persisted form.
    expect(/:\d{2,5}/.test(info.baseUrl)).toBe(false);
    expect(info.baseUrl).toBe("http://localhost:{{PORT}}");
  });
});

describe("resolvePortPlaceholder", () => {
  it("literal-replaces every {{PORT}} occurrence", () => {
    expect(
      resolvePortPlaceholder("PORT={{PORT}} url=http://x:{{PORT}}", 4321),
    ).toBe("PORT=4321 url=http://x:4321");
  });

  it("is a no-op when no placeholder is present", () => {
    expect(resolvePortPlaceholder("npm run dev", 4321)).toBe("npm run dev");
  });
});

describe("allocFreePort", () => {
  it("returns a port in the ephemeral range", async () => {
    const port = await allocFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that is actually bindable (free at check time)", async () => {
    const port = await allocFreePort();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });
});

describe("allocFreePorts", () => {
  it("returns N distinct ports held simultaneously", async () => {
    const ports = await allocFreePorts(4);
    expect(ports).toHaveLength(4);
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    }
  });

  it("returns an empty array for count 0", async () => {
    expect(await allocFreePorts(0)).toEqual([]);
  });
});

describe("collectPortSentinels", () => {
  it("detects the bare {{PORT}} sentinel", () => {
    expect(collectPortSentinels(["PORT={{PORT}}"]).bare).toBe(true);
    expect(collectPortSentinels(["npm run dev"]).bare).toBe(false);
  });

  it("dedupes and sorts named sentinels, summing counts across inputs", () => {
    const result = collectPortSentinels([
      "PORT={{PORT_BACKEND}} url=http://x:{{PORT_BACKEND}}",
      "http://localhost:{{PORT_FRONTEND}}",
      "http://localhost:{{PORT_BACKEND}}",
    ]);
    expect(result.named).toEqual(["BACKEND", "FRONTEND"]);
    expect(result.counts).toEqual({ BACKEND: 3, FRONTEND: 1 });
  });
});

describe("findMalformedPortSentinels", () => {
  it("flags a lowercase named sentinel", () => {
    expect(findMalformedPortSentinels(["{{PORT_backend}}"])).toEqual([
      "{{PORT_backend}}",
    ]);
  });

  it("flags a missing-underscore named-looking sentinel", () => {
    expect(findMalformedPortSentinels(["{{PORTX}}"])).toEqual(["{{PORTX}}"]);
  });

  it("flags a hyphenated sentinel", () => {
    expect(findMalformedPortSentinels(["{{PORT-1}}"])).toEqual(["{{PORT-1}}"]);
  });

  it("does not flag well-formed bare or named sentinels", () => {
    expect(
      findMalformedPortSentinels(["{{PORT}}", "{{PORT_BACKEND}}"]),
    ).toEqual([]);
  });

  it("dedupes repeated offending tokens", () => {
    expect(
      findMalformedPortSentinels(["{{PORT_backend}} and {{PORT_backend}}"]),
    ).toEqual(["{{PORT_backend}}"]);
  });
});

describe("resolvePorts", () => {
  it("resolves named tokens then the bare token, literal-replace", () => {
    const result = resolvePorts(
      "PORT={{PORT_BACKEND}} url=http://x:{{PORT}} api={{PORT_BACKEND}}",
      { bare: 1111, named: { BACKEND: 2222 } },
    );
    expect(result).toBe("PORT=2222 url=http://x:1111 api=2222");
  });

  it("is a no-op when no sentinel is present", () => {
    expect(resolvePorts("npm run dev", { bare: 1111 })).toBe("npm run dev");
  });
});
