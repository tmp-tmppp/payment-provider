import { newEvent } from "../domain/event.js";
import type { EventType, ProviderEvent } from "../domain/event.js";
import { expire, isDue } from "../domain/session.js";
import type { CheckoutSession } from "../domain/session.js";
import type { UseCaseDeps } from "./ports.js";

/**
 * What a log line says about a session: the first 6 characters of its id. The full id is the bearer capability of the
 * session's payment page, so no log line holds it.
 */
export const sessionRef = (id: string): string => id.slice(0, 6);

/** Keeps a new event and hands it to the webhook sender. */
export async function recordEvent(deps: UseCaseDeps, type: EventType, objectId: string): Promise<ProviderEvent> {
  const event = newEvent(type, objectId, { id: deps.ids.newEventId(), now: deps.clock.now() });
  await deps.store.saveEvent(event);
  deps.webhooks.enqueue(event);
  return event;
}

/**
 * A session whose time is up becomes "expired" the first time anyone looks at it (and the sweep catches the ones
 * nobody looks at). Only the caller that wins the status change writes the event, so it is sent once.
 */
export async function expireIfDue(deps: UseCaseDeps, session: CheckoutSession): Promise<CheckoutSession> {
  if (!isDue(session, deps.clock.now())) return session;
  const expired = expire(session);
  if (!(await deps.store.saveSession(expired, "open"))) return (await deps.store.getSession(session.id)) ?? expired;
  await recordEvent(deps, "checkout.session.expired", session.id);
  deps.logger.info({ session: sessionRef(session.id) }, "A checkout session expired");
  return expired;
}
