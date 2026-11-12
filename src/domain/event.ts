/** The events the provider sends to the webhook URL. */
export const EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.declined",
  "checkout.session.expired",
  "payout.paid",
  "payout.failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type EventObject = "checkout_session" | "payout";

/**
 * A thin event, as large providers send them: what happened and to which object, nothing more. The receiver reads
 * the object back through the API, so a replayed or forged event can never carry a state of its own.
 */
export interface ProviderEvent {
  /** "evt_" and 24 random base64url characters. */
  id: string;
  type: EventType;
  created: Date;
  data: { object: EventObject; id: string };
}

export function objectOf(type: EventType): EventObject {
  return type.startsWith("payout.") ? "payout" : "checkout_session";
}

export function newEvent(type: EventType, objectId: string, context: { id: string; now: Date }): ProviderEvent {
  return { id: context.id, type, created: context.now, data: { object: objectOf(type), id: objectId } };
}

/**
 * The exact text that is sent as the request body and signed. Key order is fixed, no spaces. Anyone who verifies a
 * signature must use the raw bytes they received, not a re-serialized copy.
 */
export function eventBody(event: ProviderEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created: event.created.toISOString(),
    data: { object: event.data.object, id: event.data.id },
  });
}

/** How far the delivery of one event to the webhook URL has got. */
export interface Delivery {
  /** pending: still trying (or not started); delivered: a 2xx answer; failed: given up after the last attempt. */
  status: "pending" | "delivered" | "failed";
  attempts: number;
  /** The HTTP status of the last attempt; null when there was none or it ended without an answer. */
  lastStatus: number | null;
  /** What went wrong at the last attempt without an answer, as a short word such as "TimeoutError". */
  lastError: string | null;
  lastAttemptAt: Date | null;
  /** When the next attempt starts; null unless the delivery is pending and waiting. */
  nextAttemptAt: Date | null;
}

export function initialDelivery(): Delivery {
  return { status: "pending", attempts: 0, lastStatus: null, lastError: null, lastAttemptAt: null, nextAttemptAt: null };
}
