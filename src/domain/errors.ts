/** Rule violations of the domain. The use cases turn them into errors a caller can act on. */
export type DomainErrorCode =
  | "invalid_amount"
  | "invalid_currency"
  | "invalid_metadata"
  | "invalid_url"
  | "invalid_destination"
  | "invalid_idempotency_key"
  | "invalid_state";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** The request field the violation is about, when there is one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
