import { getReport } from "./db";
import { summarize } from "./llm";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Reports are edited occasionally (sections regenerated); each is opened hundreds of times a day.
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/reports\/([^/]+)(\/summary)?$/);
  if (req.method === "GET" && m) {
    const report = getReport(m[1]);
    if (!report) return json({ error: "not found" }, 404);
    if (m[2]) return json({ summary: await summarize(report.sections) });
    return json(report);
  }
  return json({ error: "not found" }, 404);
}

if (import.meta.main) Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: handle });
