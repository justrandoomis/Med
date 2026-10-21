// A tiny FIFO concurrency limiter (review fix, P1-T3): the compare screen asks for one page image per row, and each
// image is a pdftoppm child process — without a bound, scrolling a 300-page comparison on a small server (Render
// starter instance) could start hundreds of renderers at once. Slots are handed over in arrival order.
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** renders running now (for tests and diagnostics) */
  readonly active: number;
  readonly waiting: number;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next(); // the slot passes straight to the next caller (active stays the same)
    else active--;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
