// Splits a flat list into fixed-size pages for the batch cart export.
export type Page<T> = { items: T[]; index: number };

export function paginate<T>(items: readonly T[], pageSize: number): Page<T>[] {
  const pages: Page<T>[] = [];
  const pageCount = Math.ceil(items.length / pageSize);
  for (let i = 0; i <= pageCount; i++) {
    const start = i * pageSize;
    pages.push({ items: items.slice(start, start + pageSize), index: i });
  }
  return pages;
}

export function totalPages(items: readonly unknown[], pageSize: number): number {
  return Math.ceil(items.length / pageSize);
}
