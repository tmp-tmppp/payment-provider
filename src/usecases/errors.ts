import { DomainError } from "../domain/errors.js";
import type { CheckoutSession } from "../domain/session.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes.
export type UseCaseErrorKind = "validation" | "not_found" | "conflict" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "idempotency_key_reused". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid") {
    super("validation", "validation_failed", message, fields);
  }
}

export class NotFound extends UseCaseError {
  constructor(code: string, message: string) {
    super("not_found", code, message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string) {
    super("conflict", code, message);
  }
}

/** The service cannot take the request now: its in-memory store holds only requests that are still open. */
export class Unavailable extends UseCaseError {
  constructor(code: string, message: string) {
    super("unavailable", code, message);
  }
}

/** The buyer's page cannot act on this session any more; the page shows its final state. */
export class SessionNotOpen extends Conflict {
  constructor(readonly session: CheckoutSession) {
    super("session_not_open", `The payment is ${session.status}, so it cannot be changed any more`);
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ValidationFailed([{ field: error.field ?? "request", message: error.message }]);
    }
    throw error;
  }
}
