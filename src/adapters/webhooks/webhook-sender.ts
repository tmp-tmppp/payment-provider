import { eventBody, initialDelivery } from "../../domain/event.js";
import type { Delivery, ProviderEvent } from "../../domain/event.js";
import { SIGNATURE_HEADER, signatureHeader } from "../../domain/signature.js";
import type { Clock, Logger, WebhookQueue } from "../../usecases/ports.js";

/** One POST to the webhook URL; the adapter around fetch is in fetch-post.ts, the tests bring their own. */
export type PostFn = (request: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ status: number }>;

export interface WebhookSenderOptions {
  /** Where the events go. */
  url: string;
  /** Signs every request. Never logged. */
  secret: string;
  post: PostFn;
  clock: Clock;
  logger: Logger;
  /** Told after every attempt how far the delivery has got (the store keeps it for GET /v1/events/{id}). */
  report: (eventId: string, delivery: Delivery) => void;
  /** Attempts in all, the first one included. Default 8. */
  maxAttempts?: number;
  /** The wait after the first failed attempt; every further wait doubles. Default 1000 ms. */
  baseDelayMs?: number;
  /** Per attempt. Default 5000 ms. */
  timeoutMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 5000;

/** A short word for a failure without an answer; never the message, which may name addresses. */
function describeFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "cause" in error ? (error.cause as { code?: unknown } | null)?.code : undefined;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Delivers events to the webhook URL, in the background. An answer other than 2xx, a network error and a timeout are
 * retried with exponential backoff (1 s, 2 s, 4 s ... between at most 8 attempts); when the last attempt fails the
 * event is given up and an error is logged. Every attempt carries a fresh signature time, so a late retry is not
 * refused as a replay. Events about one object (one session or payout) go out one after the other, in the order
 * they were queued: the next one waits until the one before has been delivered or given up. Events about different
 * objects do not wait for each other. The queue lives in memory; a restart drops what was still waiting.
 */
export class WebhookSender implements WebhookQueue {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  /** The tail of the delivery chain of each object that has events waiting or in flight. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly sleepers = new Set<{ timer: NodeJS.Timeout; wake: () => void }>();
  private stopped = false;

  constructor(private readonly options: WebhookSenderOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  enqueue(event: ProviderEvent): void {
    if (this.stopped) {
      this.options.logger.warn({ eventId: event.id, type: event.type }, "The webhook sender is stopped; the event is not sent");
      return;
    }
    const key = event.data.id;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const chain: Promise<void> = previous
      .then(() => this.deliver(event))
      .catch((error: unknown) => {
        this.options.logger.error({ eventId: event.id, type: event.type, failure: describeFailure(error) }, "Delivering a webhook crashed");
      })
      .then(() => {
        if (this.chains.get(key) === chain) this.chains.delete(key);
      });
    this.chains.set(key, chain);
  }

  /** Events that are queued, waiting for a retry or in flight. */
  pending(): number {
    return this.chains.size;
  }

  /**
   * Stops sending: waiting retries are dropped (and logged), an attempt that is in flight finishes (it ends within the
   * attempt timeout) and, when it fails, is not repeated (it is logged as not delivered), and nothing new is accepted.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const sleeper of this.sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.wake();
    }
    this.sleepers.clear();
    await Promise.all([...this.chains.values()]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const sleeper = {
        timer: setTimeout(() => {
          this.sleepers.delete(sleeper);
          resolve();
        }, ms),
        wake: resolve,
      };
      // A waiting retry must not keep a stopping process alive.
      sleeper.timer.unref();
      this.sleepers.add(sleeper);
    });
  }

  private logNotDelivered(event: ProviderEvent, attempts: number): void {
    this.options.logger.warn({ eventId: event.id, type: event.type, attempts }, "A webhook was not delivered: the service is stopping");
  }

  private async deliver(event: ProviderEvent): Promise<void> {
    const { url, secret, post, clock, logger, report } = this.options;
    // The body is made once: every attempt sends the same bytes, only the signature time changes.
    const body = eventBody(event);
    let delivery = initialDelivery();
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.stopped) {
        this.logNotDelivered(event, delivery.attempts);
        return;
      }
      const startedAt = clock.now();
      const timestamp = Math.floor(startedAt.getTime() / 1000);
      let status: number | null = null;
      let failure: string | null = null;
      try {
        ({ status } = await post({
          url,
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, body) },
          body,
          timeoutMs: this.timeoutMs,
        }));
      } catch (error) {
        failure = describeFailure(error);
      }
      delivery = { ...delivery, attempts: attempt, lastStatus: status, lastError: failure, lastAttemptAt: startedAt, nextAttemptAt: null };

      if (status !== null && status >= 200 && status < 300) {
        report(event.id, { ...delivery, status: "delivered" });
        logger.info({ eventId: event.id, type: event.type, attempts: attempt }, "A webhook was delivered");
        return;
      }
      if (attempt === this.maxAttempts) {
        report(event.id, { ...delivery, status: "failed" });
        logger.error({ eventId: event.id, type: event.type, attempts: attempt, lastStatus: status, failure }, "A webhook was given up after the last attempt");
        return;
      }
      // stop() may have come while this attempt was in flight. A wait now would not be woken (stop() already woke the
      // waiting ones), so stop() would have to wait for it, up to 64 s, and the hard exit would kill the process.
      if (this.stopped) {
        this.logNotDelivered(event, attempt);
        return;
      }
      const waitMs = this.baseDelayMs * 2 ** (attempt - 1);
      report(event.id, { ...delivery, status: "pending", nextAttemptAt: new Date(clock.now().getTime() + waitMs) });
      logger.warn({ eventId: event.id, type: event.type, attempt, lastStatus: status, failure, retryInMs: waitMs }, "A webhook attempt failed; it will be repeated");
      await this.sleep(waitMs);
    }
  }
}
