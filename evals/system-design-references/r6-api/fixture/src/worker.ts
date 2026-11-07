import { generateSection } from "./llm";
import { getReport, saveSection } from "./db";

// Cloud Tasks HTTP target: POST /tasks/generate-section with { reportId, section }.
export async function handleGenerateSection(req: Request): Promise<Response> {
  const { reportId, section } = (await req.json()) as { reportId: string; section: string };
  const report = await getReport(reportId);
  if (!report) return new Response("gone", { status: 200 });
  const body = await generateSection(report.company, section);
  await saveSection(reportId, section, body);
  return new Response("ok");
}
