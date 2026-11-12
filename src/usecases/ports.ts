import type { Delivery, ProviderEvent } from "../domain/event.js";
import type { Payout, PayoutStatus } from "../domain/payout.js";
import type { CheckoutSession, SessionStatus } from "../domain/session.js";

// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** "cs_" and 24 random base64url characters. */
  newSessionId(): string;
  /** "po_" and 24 random base64url characters. */
  newPayoutId(): string;
  /** "evt_" and 24 random base64url characters. */
  newEventId(): string;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/**
 * The answer of an idempotent create: the resource is new, the same request came before (the resource as it is
 * now), the key was used for another request, or the store is full of requests that are still open.
 */
export type Created<T> = { kind: "created" | "replayed"; value: T } | { kind: "mismatch" } | { kind: "full" };

export interface TestMode {
  /** When true, every payout that settles fails with the reason "declined". */
  declinePayouts: boolean;
}

/** An event as the store keeps it: with how far its delivery has got. */
export interface StoredEvent {
  event: ProviderEvent;
  delivery: Delivery;
}

/**
 * The provider's state. The shipped adapter keeps it in memory (a restart forgets everything) and is bounded: when it
 * is full it makes room by dropping the oldest finished session or payout, with its idempotency key and its events.
 * Every method is atomic with respect to the others, so two requests with one key never create two resources.
 */
export interface Store {
  /** Creates the session unless the key was used: then it answers with the old one, or "mismatch" for another request. */
  createSession(key: string, fingerprint: string, session: CheckoutSession): Promise<Created<CheckoutSession>>;
  getSession(id: string): Promise<CheckoutSession | null>;
  /** Replaces the session if it still has the status `expected`; false when it changed meanwhile (or is gone). */
  saveSession(session: CheckoutSession, expected: SessionStatus): Promise<boolean>;
  /** Open sessions whose expiresAt is at or before `now`. */
  dueSessions(now: Date): Promise<CheckoutSession[]>;

  createPayout(key: string, fingerprint: string, payout: Payout): Promise<Created<Payout>>;
  getPayout(id: string): Promise<Payout | null>;
  /** Replaces the payout if it still has the status `expected`; false when it changed meanwhile (or is gone). */
  savePayout(payout: Payout, expected: PayoutStatus): Promise<boolean>;

  /** Keeps the event, with a delivery that has not started. */
  saveEvent(event: ProviderEvent): Promise<void>;
  getEvent(id: string): Promise<StoredEvent | null>;
  /** Records how far the delivery of the event has got; an event that is gone is ignored. */
  setDelivery(eventId: string, delivery: Delivery): Promise<void>;

  getTestMode(): Promise<TestMode>;
  setTestMode(mode: TestMode): Promise<void>;
}

/** Sends an event to the webhook URL, in the background; it never throws and never blocks the caller. */
export interface WebhookQueue {
  enqueue(event: ProviderEvent): void;
}

/** Runs a task once, later. The shipped adapter uses timers, the tests a manual one. */
export interface Scheduler {
  after(delayMs: number, task: () => Promise<void> | void): void;
}

/** What the use cases of the requests and of the background jobs need. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  webhooks: WebhookQueue;
  logger: Logger;
}
