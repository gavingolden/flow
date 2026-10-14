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
      const res = await get(`http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });
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
      const res = await get(`http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example" },
      });
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
      expect((await get(`${base}/other`, { headers: corsHeaders })).status).toBe(
        404,
      );
      expect((await get(`${base}/`, { headers: corsHeaders })).status).toBe(404);
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

  it("403s the fixed path without Sec-Fetch-Mode: cors or from another origin", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      origin: ORIGIN,
    });
    try {
      const url = `http://127.0.0.1:${handle.port}${CREDENTIAL_LOGIN_PATH}`;
      expect((await get(url, { headers: { Origin: ORIGIN } })).status).toBe(403);
      expect(
        (
          await get(url, {
            headers: { Origin: "http://evil.example", "Sec-Fetch-Mode": "cors" },
          })
        ).status,
      ).toBe(403);
      expect((await get(url)).status).toBe(403);
    } finally {
      handle.stop();
    }
  });
});
