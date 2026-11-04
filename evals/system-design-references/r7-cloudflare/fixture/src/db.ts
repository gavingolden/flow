import type { Env } from "./index";

// D1 table: reports(id text primary key, company text, sections_json text, updated_at text)
export async function getReport(env: Env, id: string) {
  return env.DB.prepare("select * from reports where id = ?").bind(id).first();
}

export async function listSavedReports(env: Env) {
  return (await env.DB.prepare("select id, company from reports").all()).results;
}

export async function saveSections(env: Env, id: string, sections: string[]) {
  await env.DB.prepare("update reports set sections_json = ?, updated_at = datetime('now') where id = ?")
    .bind(JSON.stringify(sections), id)
    .run();
}
