/** The dedupe key for one owner-needed pause; the epic sequencer and the manager waiter both log it, so neither notifies twice. */
export function ownerNeededKey(s: {
  slug: string;
  phase: string;
  phaseLog?: unknown[];
}): string {
  return `${s.slug}:${s.phase}:${s.phaseLog?.length ?? 0}`;
}
