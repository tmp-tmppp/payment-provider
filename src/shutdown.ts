import type { Logger } from "./usecases/ports.js";

/** The most that closing the server and the background jobs may take, counted after the drain delay. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** What a shutdown does, step by step. The composition root supplies the real ones; the tests supply fakes. */
export interface ShutdownSteps {
  /** Readiness answers 503 from now on. The service keeps serving requests. */
  drain(): void;
  /** Stops accepting requests and finishes the ones in flight. */
  closeServer(): Promise<void>;
  /** Stops the sweep that expires sessions (it finishes the run it is in). */
  stopSweeper(): Promise<void>;
  /** Drops the payouts that wait for their delay; they stay pending, because the state is lost with the process anyway. */
  stopPayouts(): Promise<void>;
  /** Stops the webhook sender: waiting retries are dropped, an attempt in flight finishes. */
  stopWebhooks(): Promise<void>;
}

export interface ShutdownOptions {
  logger: Logger;
  /** How long the service keeps working after readiness turned 503, for the load balancer to stop sending requests. */
  delayMs: number;
  /** The hard limit for the steps after the delay; when it passes, the process exits with 1. Default SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Ends the process. The real one is process.exit. */
  exit: (code: number) => void;
}

/**
 * The graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal), in two parts. First the drain: readiness
 * answers 503 at once and the service keeps working for `delayMs`, because the load balancer needs a moment to stop
 * sending requests (without it, the requests that arrive while the server closes fail with 502). Then the steps run
 * one after the other: stop accepting requests, finish the ones in flight, stop the sweep, drop the waiting payouts,
 * stop the webhook sender. A timer started with the drain ends the process with 1 when all that takes longer than
 * `delayMs` plus `timeoutMs`; it does not keep the process alive. A step that fails ends the process with 1 too, and
 * the steps after it do not run. A second signal changes nothing.
 *
 * It takes its dependencies instead of reaching for them, so that the order and the timing are tested with fake timers.
 */
export function createShutdown(steps: ShutdownSteps, options: ShutdownOptions): (signal: string) => Promise<void> {
  const { logger, delayMs, exit } = options;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;
    steps.drain();
    logger.info({ signal, delayMs }, "Shutting down: the readiness probe now answers 503");
    const hardExit = setTimeout(() => {
      logger.error({}, "Shutdown took too long; exiting");
      exit(1);
    }, delayMs + timeoutMs);
    hardExit.unref();
    try {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      await steps.closeServer();
      await steps.stopSweeper();
      await steps.stopPayouts();
      await steps.stopWebhooks();
      logger.info({}, "Stopped");
      clearTimeout(hardExit);
      exit(0);
    } catch (error) {
      logger.error({ err: error }, "Shutdown failed");
      clearTimeout(hardExit);
      exit(1);
    }
  };
}

/** The part of `process` that listens to signals; the tests bring an EventEmitter. */
export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

/**
 * Runs the shutdown on SIGTERM (Kubernetes) and SIGINT (a terminal). The listeners stay: with `once`, a second signal
 * would find none and Node would end the process at once (exit 143) in the middle of the shutdown. The shutdown
 * itself ignores a repeat.
 */
export function registerShutdownSignals(source: SignalSource, shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    source.on(signal, () => void shutdown(signal));
  }
}
