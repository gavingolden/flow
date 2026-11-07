// Takes 20-60 s per call and costs money per call.
export async function generateSection(
  company: string,
  section: string,
): Promise<string> {
  const res = await fetch("https://api.example-llm.com/v1/generate", {
    method: "POST",
    body: JSON.stringify({ prompt: `Write the "${section}" section for ${company}` }),
  });
  return (await res.json()).text as string;
}

// Takes 1-3 s per call and costs money per call.
export async function suggestTitle(sections: string[]): Promise<string> {
  const res = await fetch("https://api.example-llm.com/v1/title", {
    method: "POST",
    body: JSON.stringify({ sections }),
  });
  return (await res.json()).title as string;
}
