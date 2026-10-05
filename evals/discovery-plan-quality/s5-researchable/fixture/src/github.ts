const API = "https://api.github.com";

export type Issue = { number: number; title: string; state: "open" | "closed" };

export async function createIssue(
  repo: string,
  title: string,
  token: string,
): Promise<Issue> {
  const res = await fetch(`${API}/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()) as Issue;
}

export async function closeIssue(
  repo: string,
  number: number,
  token: string,
): Promise<void> {
  const res = await fetch(`${API}/repos/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
}
