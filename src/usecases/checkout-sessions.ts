import { fingerprint } from "../domain/idempotency.js";
import { validateIdempotencyKey } from "../domain/input.js";
import { complete, decline, newSession } from "../domain/session.js";
import type { CheckoutSession, NewSessionInput } from "../domain/session.js";
import { Conflict, NotFound, SessionNotOpen, Unavailable, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { expireIfDue, recordEvent, sessionRef } from "./support.js";

export interface CreatedSession {
  session: CheckoutSession;
  /** True when the same Idempotency-Key and body came before: the session is the one made then. */
  replayed: boolean;
}

/** POST /v1/checkout-sessions */
export class CreateCheckoutSession {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly ttlMinutes: number,
  ) {}

  async execute(request: { idempotencyKey: unknown; input: NewSessionInput }): Promise<CreatedSession> {
    const { store, clock, ids, logger } = this.deps;
    const key = guardDomain(() => validateIdempotencyKey(request.idempotencyKey));
    const session = guardDomain(() => newSession(request.input, { id: ids.newSessionId(), now: clock.now(), ttlMinutes: this.ttlMinutes }));
    // What makes two requests "the same": every field that the caller chose, in a normal form.
    const digest = fingerprint({
      amount: session.amount,
      currency: session.currency,
      metadata: session.metadata,
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
    });
    const result = await store.createSession(key, digest, session);
    switch (result.kind) {
      case "created":
        logger.info({ session: sessionRef(session.id), amount: session.amount, currency: session.currency }, "A checkout session was created");
        return { session: result.value, replayed: false };
      case "replayed":
        return { session: await expireIfDue(this.deps, result.value), replayed: true };
      case "mismatch":
        throw new Conflict("idempotency_key_reused", "This Idempotency-Key was used for a request with another body");
      case "full":
        throw new Unavailable("capacity_exceeded", "The provider holds too many open payments; try again later");
    }
  }
}

/** GET /v1/checkout-sessions/{id} */
export class GetCheckoutSession {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(id: string): Promise<CheckoutSession> {
    const session = await this.deps.store.getSession(id);
    if (!session) throw new NotFound("session_not_found", "No such checkout session");
    return expireIfDue(this.deps, session);
  }
}

export type CheckoutOutcome = "completed" | "declined";

/** The buyer's two buttons: pay or decline. Only an open session changes; every other one answers SessionNotOpen. */
export class CompleteCheckout {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(request: { id: string; outcome: CheckoutOutcome }): Promise<CheckoutSession> {
    const { store, logger } = this.deps;
    const found = await store.getSession(request.id);
    if (!found) throw new NotFound("session_not_found", "No such checkout session");
    const session = await expireIfDue(this.deps, found);
    if (session.status !== "open") throw new SessionNotOpen(session);

    const next = request.outcome === "completed" ? complete(session) : decline(session);
    if (!(await store.saveSession(next, "open"))) {
      // Someone else changed it between the read and the write (two clicks at once): show what it is now.
      throw new SessionNotOpen((await store.getSession(request.id)) ?? session);
    }
    await recordEvent(this.deps, request.outcome === "completed" ? "checkout.session.completed" : "checkout.session.declined", next.id);
    logger.info({ session: sessionRef(next.id), outcome: request.outcome }, "A checkout session ended");
    return next;
  }
}

/** The sweep: turns every open session whose time is up into "expired" (with its event). Returns how many it did. */
export class ExpireSessions {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(): Promise<number> {
    const due = await this.deps.store.dueSessions(this.deps.clock.now());
    let expired = 0;
    for (const session of due) {
      if ((await expireIfDue(this.deps, session)).status === "expired") expired += 1;
    }
    return expired;
  }
}
