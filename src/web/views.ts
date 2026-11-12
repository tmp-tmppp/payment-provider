import type { Payout } from "../domain/payout.js";
import type { CheckoutSession } from "../domain/session.js";
import type { StoredEvent } from "../usecases/ports.js";

// What the API sends: the domain objects in their JSON form (dates as ISO text, an "object" field that names the kind).

export function checkoutUrl(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl}/checkout/${encodeURIComponent(sessionId)}`;
}

export function sessionView(session: CheckoutSession, publicBaseUrl: string) {
  return {
    id: session.id,
    object: "checkout_session" as const,
    url: checkoutUrl(publicBaseUrl, session.id),
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    metadata: session.metadata,
    successUrl: session.successUrl,
    cancelUrl: session.cancelUrl,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

export function payoutView(payout: Payout) {
  return {
    id: payout.id,
    object: "payout" as const,
    status: payout.status,
    amount: payout.amount,
    currency: payout.currency,
    destination: payout.destination,
    metadata: payout.metadata,
    failureReason: payout.failureReason,
    createdAt: payout.createdAt.toISOString(),
    settledAt: payout.settledAt?.toISOString() ?? null,
  };
}

export function eventView({ event, delivery }: StoredEvent) {
  return {
    id: event.id,
    type: event.type,
    created: event.created.toISOString(),
    data: { object: event.data.object, id: event.data.id },
    delivery: {
      status: delivery.status,
      attempts: delivery.attempts,
      lastStatus: delivery.lastStatus,
      lastError: delivery.lastError,
      lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
      nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    },
  };
}
