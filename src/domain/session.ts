import { DomainError } from "./errors.js";
import { validateAmount, validateCurrency, validateMetadata, validateReturnUrl } from "./input.js";
import type { Currency } from "./input.js";

/** open -> completed | declined | expired: the three last states are final. */
export type SessionStatus = "open" | "completed" | "declined" | "expired";

export interface CheckoutSession {
  /** "cs_" and 24 random base64url characters. */
  id: string;
  status: SessionStatus;
  /** Integer cents. */
  amount: number;
  currency: Currency;
  metadata: Readonly<Record<string, string>>;
  successUrl: string;
  cancelUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

/** What a caller sends; every field is checked by newSession. */
export interface NewSessionInput {
  amount: unknown;
  currency: unknown;
  metadata?: unknown;
  successUrl: unknown;
  cancelUrl: unknown;
}

export interface NewSessionContext {
  id: string;
  now: Date;
  ttlMinutes: number;
}

export function newSession(input: NewSessionInput, context: NewSessionContext): CheckoutSession {
  return {
    id: context.id,
    status: "open",
    amount: validateAmount(input.amount),
    currency: validateCurrency(input.currency),
    metadata: validateMetadata(input.metadata),
    successUrl: validateReturnUrl(input.successUrl, "successUrl"),
    cancelUrl: validateReturnUrl(input.cancelUrl, "cancelUrl"),
    createdAt: context.now,
    expiresAt: new Date(context.now.getTime() + context.ttlMinutes * 60_000),
  };
}

/** True for an open session whose time is up: it has to be turned into "expired". */
export function isDue(session: CheckoutSession, now: Date): boolean {
  return session.status === "open" && now.getTime() >= session.expiresAt.getTime();
}

function assertOpen(session: CheckoutSession): void {
  if (session.status !== "open") {
    throw new DomainError("invalid_state", `The session is ${session.status}, so it cannot change any more`);
  }
}

/** The buyer paid. */
export function complete(session: CheckoutSession): CheckoutSession {
  assertOpen(session);
  return { ...session, status: "completed" };
}

/** The buyer declined. */
export function decline(session: CheckoutSession): CheckoutSession {
  assertOpen(session);
  return { ...session, status: "declined" };
}

/** Nobody paid before expiresAt. */
export function expire(session: CheckoutSession): CheckoutSession {
  assertOpen(session);
  return { ...session, status: "expired" };
}
