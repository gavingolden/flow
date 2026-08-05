// Consumer B: never imports RetryPolicy or retry-contract.ts at all. Its
// only coupling to the contract is transitive, through makeRetrying's
// generic constraint in retry-runner.ts — a trace that stops at "who
// imports RetryPolicy" will miss this file entirely.
import { makeRetrying } from "./retry-runner";

async function rawFetchUser(id: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`https://example.invalid/users/${id}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.json();
}

export const fetchUser = makeRetrying(rawFetchUser);
