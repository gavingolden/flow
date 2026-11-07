// Takes 20-60 s per call and costs money per call.
export async function generateSection(company: string, section: string): Promise<string> {
  const res = await fetch("https://api.example-llm.com/v1/generate", {
    method: "POST",
    body: JSON.stringify({ prompt: `Write the "${section}" section for ${company}` }),
  });
  return ((await res.json()) as { text: string }).text;
}
