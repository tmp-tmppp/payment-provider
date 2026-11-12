import { DomainError } from "./errors.js";
import { validateAmount, validateCurrency, validateDestination, validateMetadata } from "./input.js";
import type { Currency } from "./input.js";

/** pending -> paid | failed: the two last states are final. */
export type PayoutStatus = "pending" | "paid" | "failed";

/** The only reason a payout fails: the provider's test mode declines it. */
export type PayoutFailureReason = "declined";

export interface Payout {
  /** "po_" and 24 random base64url characters. */
  id: string;
  status: PayoutStatus;
  /** Integer cents. */
  amount: number;
  currency: Currency;
  /** The account the money goes to, as the caller named it. */
  destination: string;
  metadata: Readonly<Record<string, string>>;
  failureReason: PayoutFailureReason | null;
  createdAt: Date;
  /** When it became paid or failed. */
  settledAt: Date | null;
}

export interface NewPayoutInput {
  amount: unknown;
  currency: unknown;
  destination: unknown;
  metadata?: unknown;
}

export function newPayout(input: NewPayoutInput, context: { id: string; now: Date }): Payout {
  return {
    id: context.id,
    status: "pending",
    amount: validateAmount(input.amount),
    currency: validateCurrency(input.currency),
    destination: validateDestination(input.destination),
    metadata: validateMetadata(input.metadata),
    failureReason: null,
    createdAt: context.now,
    settledAt: null,
  };
}

/** The payout ends: paid, or failed with the reason "declined" when the test mode says so. */
export function settle(payout: Payout, declined: boolean, now: Date): Payout {
  if (payout.status !== "pending") {
    throw new DomainError("invalid_state", `The payout is ${payout.status}, so it cannot change any more`);
  }
  return declined
    ? { ...payout, status: "failed", failureReason: "declined", settledAt: now }
    : { ...payout, status: "paid", settledAt: now };
}
