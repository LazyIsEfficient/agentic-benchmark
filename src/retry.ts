/** Resolve after `ms` milliseconds. Normal Node timer — fine for backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Total attempts (>= 1). The op runs at most this many times. */
  maxAttempts: number;
  /** Base backoff; delay after a failed attempt N is baseMs * 2^(N-1). */
  baseMs: number;
  /** Called after a failed attempt that will be retried (not after the last). */
  onRetry?: (failedAttempt: number, error: Error) => void;
  /** Injectable for deterministic tests; defaults to the real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `op` with exponential backoff, retrying on ANY thrown error. Returns the
 * value and the attempt number that succeeded. If every attempt throws, the last
 * error is rethrown. Pure control-flow with injectable sleep so tests stay
 * deterministic and fast.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  opts: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleepFn = opts.sleep ?? sleep;
  let lastError: Error = new Error("withRetry: op never ran");

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const value = await op();
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err as Error;
      if (attempt < opts.maxAttempts) {
        opts.onRetry?.(attempt, lastError);
        await sleepFn(opts.baseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}
