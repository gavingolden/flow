/**
 * Spawn-free synchronous sleep. `Atomics.wait` on a `SharedArrayBuffer` view
 * blocks the thread for `ms` without forking a process — unlike `spawnSync`
 * sleep, which pays a process-fork tax per call. Bun and Node both support it.
 *
 * The flow CLI's launch/lock paths are synchronous (their callers return a
 * number, not a Promise), so `setTimeout` / `Bun.sleep` / `await` are not
 * options at those sites; this is the shared primitive they all import.
 */
export function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
