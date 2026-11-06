import { getReport, listSections } from "./db";
import { handleGenerateSection } from "./worker";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/tasks/generate-section") return handleGenerateSection(req);
  const m = url.pathname.match(/^\/reports\/([^/]+)$/);
  if (req.method === "GET" && m) {
    const report = await getReport(m[1]);
    if (!report) return json({ error: "not found" }, 404);
    return json({ ...report, sections: await listSections(m[1]) });
  }
  return json({ error: "not found" }, 404);
}

if (import.meta.main) Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: handle });
