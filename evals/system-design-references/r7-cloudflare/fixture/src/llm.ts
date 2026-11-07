// Takes 20-60 s per call and costs money per call. Each saved report has five sections.
export async function generateSection(apiKey: string, company: string, section: string): Promise<string> {
  const res = await fetch("https://api.example-llm.com/v1/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt: `Write the "${section}" section for ${company}` }),
  });
  return ((await res.json()) as { text: string }).text;
}
