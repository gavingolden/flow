import { getReport, saveReport } from "./db";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const getMatch = url.pathname.match(/^\/reports\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const report = getReport(getMatch[1]);
    return report ? json(report) : json({ error: "not found" }, 404);
  }
  const shareMatch = url.pathname.match(/^\/reports\/([^/]+)\/share$/);
  if (req.method === "POST" && shareMatch) {
    const report = getReport(shareMatch[1]);
    if (!report) return json({ error: "not found" }, 404);
    saveReport({ ...report, shared: true });
    return json({ shared: true });
  }
  return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: handle });
}
