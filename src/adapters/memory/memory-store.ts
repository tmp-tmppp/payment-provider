import { initialDelivery } from "../../domain/event.js";
import type { Delivery, ProviderEvent } from "../../domain/event.js";
import type { Payout, PayoutStatus } from "../../domain/payout.js";
import type { CheckoutSession, SessionStatus } from "../../domain/session.js";
import type { Created, Store, StoredEvent, TestMode } from "../../usecases/ports.js";

/** How many sessions and how many payouts the store keeps at most (each kind on its own). */
export const DEFAULT_CAP = 10_000;

interface Keyed {
  fingerprint: string;
  id: string;
}

/**
 * The state of the provider, in memory (decision of the team): a restart forgets everything, and the payments service
 * expires its own pending deposits. It is bounded: with `cap` sessions (or payouts) stored, a new one makes room by
 * dropping the oldest one that is finished, together with its idempotency key and its events. When every stored one is
 * still open (or pending) the store answers "full" and the caller gets a 503, so memory never grows without limit.
 * Events live and die with their session or payout, so they are bounded by the same cap.
 */
export class MemoryStore implements Store {
  private readonly sessions = new Map<string, CheckoutSession>();
  private readonly payouts = new Map<string, Payout>();
  private readonly events = new Map<string, StoredEvent>();
  /** Event ids by the id of the session or payout they are about. */
  private readonly eventsByObject = new Map<string, string[]>();
  /** "<kind>:<Idempotency-Key>" -> the request and the resource it made. */
  private readonly keys = new Map<string, Keyed>();
  /** Resource id -> its entry in `keys`, to drop both together. */
  private readonly keyOf = new Map<string, string>();
  private testMode: TestMode = { declinePayouts: false };

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  createSession(key: string, fingerprint: string, session: CheckoutSession): Promise<Created<CheckoutSession>> {
    return Promise.resolve(
      this.createIdempotent("session", this.sessions, (candidate) => candidate.status !== "open", key, fingerprint, session),
    );
  }

  getSession(id: string): Promise<CheckoutSession | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  saveSession(session: CheckoutSession, expected: SessionStatus): Promise<boolean> {
    const current = this.sessions.get(session.id);
    if (current?.status !== expected) return Promise.resolve(false);
    this.sessions.set(session.id, session);
    return Promise.resolve(true);
  }

  dueSessions(now: Date): Promise<CheckoutSession[]> {
    return Promise.resolve([...this.sessions.values()].filter((session) => session.status === "open" && session.expiresAt.getTime() <= now.getTime()));
  }

  createPayout(key: string, fingerprint: string, payout: Payout): Promise<Created<Payout>> {
    return Promise.resolve(this.createIdempotent("payout", this.payouts, (candidate) => candidate.status !== "pending", key, fingerprint, payout));
  }

  getPayout(id: string): Promise<Payout | null> {
    return Promise.resolve(this.payouts.get(id) ?? null);
  }

  savePayout(payout: Payout, expected: PayoutStatus): Promise<boolean> {
    const current = this.payouts.get(payout.id);
    if (current?.status !== expected) return Promise.resolve(false);
    this.payouts.set(payout.id, payout);
    return Promise.resolve(true);
  }

  saveEvent(event: ProviderEvent): Promise<void> {
    this.events.set(event.id, { event, delivery: initialDelivery() });
    const ids = this.eventsByObject.get(event.data.id);
    if (ids) ids.push(event.id);
    else this.eventsByObject.set(event.data.id, [event.id]);
    return Promise.resolve();
  }

  getEvent(id: string): Promise<StoredEvent | null> {
    return Promise.resolve(this.events.get(id) ?? null);
  }

  setDelivery(eventId: string, delivery: Delivery): Promise<void> {
    const stored = this.events.get(eventId);
    if (stored) this.events.set(eventId, { event: stored.event, delivery });
    return Promise.resolve();
  }

  getTestMode(): Promise<TestMode> {
    return Promise.resolve({ ...this.testMode });
  }

  setTestMode(mode: TestMode): Promise<void> {
    this.testMode = { declinePayouts: mode.declinePayouts };
    return Promise.resolve();
  }

  /** How many sessions, payouts and events are held (for tests and the shutdown log). */
  sizes(): { sessions: number; payouts: number; events: number; keys: number } {
    return { sessions: this.sessions.size, payouts: this.payouts.size, events: this.events.size, keys: this.keys.size };
  }

  private createIdempotent<T extends { id: string }>(
    kind: "session" | "payout",
    table: Map<string, T>,
    isFinished: (resource: T) => boolean,
    key: string,
    fingerprint: string,
    resource: T,
  ): Created<T> {
    const mapKey = `${kind}:${key}`;
    const known = this.keys.get(mapKey);
    const existing = known ? table.get(known.id) : undefined;
    if (known && existing) {
      return known.fingerprint === fingerprint ? { kind: "replayed", value: existing } : { kind: "mismatch" };
    }
    if (table.size >= this.cap && !this.dropOldestFinished(table, isFinished)) return { kind: "full" };
    table.set(resource.id, resource);
    this.keys.set(mapKey, { fingerprint, id: resource.id });
    this.keyOf.set(resource.id, mapKey);
    return { kind: "created", value: resource };
  }

  /** Maps keep the order of insertion, so the first finished entry is the oldest finished one. */
  private dropOldestFinished<T extends { id: string }>(table: Map<string, T>, isFinished: (resource: T) => boolean): boolean {
    for (const [id, resource] of table) {
      if (!isFinished(resource)) continue;
      table.delete(id);
      const mapKey = this.keyOf.get(id);
      if (mapKey !== undefined) this.keys.delete(mapKey);
      this.keyOf.delete(id);
      for (const eventId of this.eventsByObject.get(id) ?? []) this.events.delete(eventId);
      this.eventsByObject.delete(id);
      return true;
    }
    return false;
  }
}
