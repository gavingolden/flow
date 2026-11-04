import { sql } from "bun";

// Postgres (Cloud SQL). Schema in migrations/.
export type Report = { id: string; company: string; status: string; created_at: string };

export async function getReport(id: string): Promise<Report | undefined> {
  const rows = await sql`select * from reports where id = ${id}`;
  return rows[0];
}

export async function listSections(reportId: string) {
  return sql`select id, name, body from sections where report_id = ${reportId} order by position`;
}

export async function saveSection(reportId: string, name: string, body: string) {
  await sql`update sections set body = ${body} where report_id = ${reportId} and name = ${name}`;
}
