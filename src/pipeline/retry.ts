export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function retryOnce<T>(
  fn: (attempt: number, lastFailure?: string) => Promise<AttemptResult<T>>,
): Promise<AttemptResult<T>> {
  const first = await fn(1);
  if (first.ok) return first;
  return await fn(2, first.error);
}
