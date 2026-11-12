import { fingerprint } from "../domain/idempotency.js";
import { validateIdempotencyKey } from "../domain/input.js";
import { newPayout, settle } from "../domain/payout.js";
import type { NewPayoutInput, Payout } from "../domain/payout.js";
import { Conflict, NotFound, Unavailable, guardDomain } from "./errors.js";
import type { Scheduler, UseCaseDeps } from "./ports.js";
import { recordEvent } from "./support.js";

/**
 * A pending payout ends: paid, or failed with the reason "declined" when the test mode asks for it at this moment.
 * Nothing happens to a payout that is not pending any more.
 */
export class SettlePayout {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(id: string): Promise<void> {
    const { store, clock, logger } = this.deps;
    const payout = await store.getPayout(id);
    if (payout?.status !== "pending") return;
    const declined = (await store.getTestMode()).declinePayouts;
    const next = settle(payout, declined, clock.now());
    if (!(await store.savePayout(next, "pending"))) return;
    await recordEvent(this.deps, next.status === "paid" ? "payout.paid" : "payout.failed", next.id);
    logger.info({ payoutId: next.id, status: next.status }, "A payout ended");
  }
}

export interface CreatedPayout {
  payout: Payout;
  /** True when the same Idempotency-Key and body came before: the payout is the one made then. */
  replayed: boolean;
}

/** POST /v1/payouts: stores a pending payout and settles it after the configured delay. */
export class CreatePayout {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly scheduler: Scheduler,
    private readonly settleAfterMs: number,
    private readonly settlement: SettlePayout,
  ) {}

  async execute(request: { idempotencyKey: unknown; input: NewPayoutInput }): Promise<CreatedPayout> {
    const { store, clock, ids, logger } = this.deps;
    const key = guardDomain(() => validateIdempotencyKey(request.idempotencyKey));
    const payout = guardDomain(() => newPayout(request.input, { id: ids.newPayoutId(), now: clock.now() }));
    const digest = fingerprint({
      amount: payout.amount,
      currency: payout.currency,
      destination: payout.destination,
      metadata: payout.metadata,
    });
    const result = await store.createPayout(key, digest, payout);
    switch (result.kind) {
      case "created":
        this.scheduler.after(this.settleAfterMs, () => this.settlement.execute(payout.id));
        logger.info({ payoutId: payout.id, amount: payout.amount, currency: payout.currency }, "A payout was created");
        return { payout: result.value, replayed: false };
      case "replayed":
        return { payout: result.value, replayed: true };
      case "mismatch":
        throw new Conflict("idempotency_key_reused", "This Idempotency-Key was used for a request with another body");
      case "full":
        throw new Unavailable("capacity_exceeded", "The provider holds too many pending payouts; try again later");
    }
  }
}

/** GET /v1/payouts/{id} */
export class GetPayout {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(id: string): Promise<Payout> {
    const payout = await this.deps.store.getPayout(id);
    if (!payout) throw new NotFound("payout_not_found", "No such payout");
    return payout;
  }
}
