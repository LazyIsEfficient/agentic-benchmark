import { sleep as realSleep } from "./retry.js";

/** Outcome of one pool item: either a value or a captured error (never both). */
export interface PoolOutcome<R> {
  value?: R;
  error?: Error;
}

export interface PoolOptions {
  /** Pause this many ms before each item a worker picks up (rate-limit pacing). */
  delayMs?: number;
  /** Injectable sleep (tests); defaults to the real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bounded fan-out over `items`: at most `concurrency` workers run at once.
 *
 * - Results are returned in INPUT order (not completion order).
 * - A worker that throws does NOT reject the pool — its outcome captures the
 *   error so one failing item never aborts the batch (mirrors the matrix's
 *   "one failure doesn't abort the run" guarantee).
 * - `delayMs` (optional) paces dispatches: a worker sleeps that long before each
 *   item it picks up, relieving sustained rate-limit pressure. Default 0 = no
 *   pacing, so existing callers are unchanged.
 * - Zero external deps; single shared index cursor is safe because Node runs the
 *   scheduling on one thread.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: PoolOptions = {},
): Promise<PoolOutcome<R>[]> {
  const outcomes: PoolOutcome<R>[] = new Array(items.length);
  const workers = Math.max(1, Math.min(concurrency, items.length || 1));
  const delayMs = opts.delayMs ?? 0;
  const sleep = opts.sleep ?? realSleep;
  let next = 0;

  async function drain(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      if (delayMs > 0) await sleep(delayMs);
      try {
        outcomes[index] = { value: await worker(item, index) };
      } catch (err) {
        outcomes[index] = { error: err as Error };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => drain()));
  return outcomes;
}
