import type { Logger, Scheduler } from "../usecases/ports.js";

/** Runs a task once, later, with setTimeout. A task that fails is logged; it never stops the process. */
export class TimerScheduler implements Scheduler {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly logger: Logger) {}

  after(delayMs: number, task: () => Promise<void> | void): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const run: Promise<void> = Promise.resolve()
        .then(task)
        .catch((error: unknown) => this.logger.error({ err: error }, "A scheduled task failed"))
        .then(() => {
          this.running.delete(run);
        });
      this.running.add(run);
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  /** Drops every task that has not started and waits for the ones that run now. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    const dropped = this.timers.size;
    this.timers.clear();
    if (dropped > 0) this.logger.warn({ dropped }, "Scheduled tasks were dropped at shutdown");
    await Promise.all([...this.running]);
  }
}

/** Runs a job again and again, one run at a time: a run that is still going makes the next tick wait. */
export class PeriodicJob {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;

  constructor(
    private readonly options: { name: string; everyMs: number; run: () => Promise<unknown>; logger: Logger },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.current) return;
      this.current = this.options
        .run()
        .then(() => undefined)
        .catch((error: unknown) => this.options.logger.error({ err: error, job: this.options.name }, "A periodic job failed"))
        .then(() => {
          this.current = null;
        });
    }, this.options.everyMs);
    this.timer.unref();
  }

  /** Stops the schedule and waits for the run that is going. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }
}
