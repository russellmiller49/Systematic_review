export interface ScopePico {
  id: string;
  title: string;
  picoNumber: number;
}

export function pooledScopeLabel(picos: ScopePico[]): string {
  return `PICOs ${picos.map((pico) => pico.picoNumber).join(", ")} together`;
}

export function screeningQueueHref(guidelineId: string, queue: string): string {
  return `/projects/${guidelineId}/screening?queue=${encodeURIComponent(queue)}`;
}

// An unavailable/stale explicit link must not silently send a reviewer to a different scope.
export function initialScreeningQueue(
  requested: string | null,
  poolId: string | null,
  unpooledIds: string[],
): string | null {
  const queues = [...(poolId ? [`pool:${poolId}`] : []), ...unpooledIds.map((id) => `pico:${id}`)];
  return requested !== null ? (queues.includes(requested) ? requested : null) : (queues[0] ?? null);
}
