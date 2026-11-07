import { getReport, listSavedReports } from "./db";

export interface Env { DB: D1Database; LLM_API_KEY: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/reports\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const report = await getReport(env, m[1]);
      return report ? Response.json(report) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (req.method === "GET" && new URL(req.url).pathname === "/reports") {
      return Response.json(await listSavedReports(env));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
