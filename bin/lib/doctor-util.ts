const MAX_LISTED = 5;

/** At most `max` items, with a `(+N more)` tail so a report line stays short. */
export function capped(items: string[], max: number = MAX_LISTED): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `(+${items.length - max} more)`];
}
