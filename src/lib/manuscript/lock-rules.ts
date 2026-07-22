// Section-lock protocol constants — shared by the service (enforcement) and the client
// (heartbeat/autosave cadence). Pure, unit-tested.

export const LOCK_HEARTBEAT_INTERVAL_MS = 30_000; // client PUTs a heartbeat on this cadence
export const LOCK_STALE_MS = 90_000; // 3 missed heartbeats → lock is stale, takeover allowed
export const AUTOSAVE_DEBOUNCE_MS = 2_000;
export const AUTOSAVE_MAX_INTERVAL_MS = 10_000;

export function isLockStale(heartbeatAt: Date | null, now: Date): boolean {
  if (!heartbeatAt) return true;
  return now.getTime() - heartbeatAt.getTime() >= LOCK_STALE_MS;
}
