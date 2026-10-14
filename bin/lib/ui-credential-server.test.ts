import { describe, expect, it } from "vitest";
import * as http from "node:http";
import {
  CREDENTIAL_LOGIN_PATH,
  originsMatch,
  startCredentialServer,
} from "./ui-credential-server";

describe("originsMatch", () => {
  it.each([
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:5173", "http://localhost:5173"],
    ["http://localhost:5173", "http://127.0.0.1:5173"],
    ["http://[::1]:5173", "http://localhost:5173"],
  ])("accepts %s against allowed %s", (requestOrigin, allowedOrigin) => {
    expect(originsMatch(requestOrigin, allowedOrigin)).toBe(true);
  });

  it.each([
    ["http://localhost:3000", "http://localhost:5173"],
    ["https://localhost:5173", "http://localhost:5173"],
    ["http://evil.example", "http://localhost:5173"],
    ["not a url", "http://localhost:5173"],
    ["http://localhost:5173", "not a url"],
  ])("rejects %s against allowed %s", (requestOrigin, allowedOrigin) => {
    expect(originsMatch(requestOrigin, allowedOrigin)).toBe(false);
  });
});

function get(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startCredentialServer OPTIONS preflight", () => {
  it("204s an OPTIONS request from the allowed origin", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: "http://localhost:5173",
    });
    try {
      const res = await get(
        `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`,
        {
          method: "OPTIONS",
          headers: { Origin: "http://localhost:5173" },
        },
      );
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
    } finally {
      handle.stop();
    }
  });

  it("403s an OPTIONS request from a disallowed origin", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: "http://localhost:5173",
    });
    try {
      const res = await get(
        `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`,
        {
          method: "OPTIONS",
          headers: { Origin: "http://evil.example" },
        },
      );
      expect(res.status).toBe(403);
    } finally {
      handle.stop();
    }
  });
});

describe("startCredentialServer fixed path", () => {
  const ORIGIN = "http://localhost:5173";
  const corsHeaders = { Origin: ORIGIN, "Sec-Fetch-Mode": "cors" };

  it("answers the fixed path once (200) then 410, ignoring the query", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const base = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
      const first = await get(`${base}?x=1`, { headers: corsHeaders });
      expect(first.status).toBe(200);
      const second = await get(base, { headers: corsHeaders });
      expect(second.status).toBe(410);
    } finally {
      handle.stop();
    }
  });

  it("404s a non-login path for GET and OPTIONS", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      expect(
        (await get(`${base}/other`, { headers: corsHeaders })).status,
      ).toBe(404);
      expect((await get(`${base}/`, { headers: corsHeaders })).status).toBe(
        404,
      );
      expect(
        (
          await get(`${base}/other`, {
            method: "OPTIONS",
            headers: { Origin: ORIGIN },
          })
        ).status,
      ).toBe(404);
    } finally {
      handle.stop();
    }
  });

  it("fails closed: a 403 refusal spends the single use, so a later valid request gets 410", async () => {
    const refusals: Array<[string, Record<string, string>, string?]> = [
      ["missing Sec-Fetch-Mode", { Origin: ORIGIN }],
      [
        "wrong origin",
        { Origin: "http://evil.example", "Sec-Fetch-Mode": "cors" },
      ],
      ["no headers", {}],
      [
        "OPTIONS from a wrong origin",
        { Origin: "http://evil.example" },
        "OPTIONS",
      ],
    ];
    for (const [label, headers, method] of refusals) {
      const handle = await startCredentialServer({
        values: { user: "u", pass: "p" },
        origin: ORIGIN,
      });
      try {
        const url = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
        expect((await get(url, { headers, method })).status, label).toBe(403);
        expect((await get(url, { headers: corsHeaders })).status, label).toBe(
          410,
        );
      } finally {
        handle.stop();
      }
    }
  });

  it("a wrong-path 404 does not spend the single use", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      expect(
        (await get(`${base}/other`, { headers: corsHeaders })).status,
      ).toBe(404);
      expect(
        (await get(`${base}${CREDENTIAL_LOGIN_PATH}`, { headers: corsHeaders }))
          .status,
      ).toBe(200);
    } finally {
      handle.stop();
    }
  });

  it("echoes the allowed origin on 410 and the Sec-Fetch-Mode 403, never a mismatched one", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const url = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
      const noMode = await get(url, { headers: { Origin: ORIGIN } });
      expect(noMode.status).toBe(403);
      expect(noMode.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(noMode.headers.vary).toBe("Origin");

      const used = await get(url, { headers: corsHeaders });
      expect(used.status).toBe(410);
      expect(used.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(used.headers.vary).toBe("Origin");

      const mismatched = await get(url, {
        headers: { Origin: "http://evil.example", "Sec-Fetch-Mode": "cors" },
      });
      expect(mismatched.status).toBe(410);
      expect(mismatched.headers["access-control-allow-origin"]).toBeUndefined();

      const bare = await get(url);
      expect(bare.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      handle.stop();
    }
  });

  it("does not echo a mismatched origin on the first-request 403", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const url = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
      const res = await get(url, {
        headers: { Origin: "http://evil.example", "Sec-Fetch-Mode": "cors" },
      });
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    } finally {
      handle.stop();
    }
  });

  it("keeps listening after the 200 and answers 410 until the TTL expires", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
      ttlMs: 600,
    });
    const url = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
    expect((await get(url, { headers: corsHeaders })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await get(url, { headers: corsHeaders });
    expect(after.status).toBe(410);
    expect(after.headers["access-control-allow-origin"]).toBe(ORIGIN);
    await handle.closed;
    await expect(get(url, { headers: corsHeaders })).rejects.toThrow();
  });
});
