import { DomainError } from "./errors.js";

// Validation of what a caller sends. The routes validate the JSON first (src/web/schemas.ts); the domain checks
// again, so that the rules hold for every caller of a use case, not only for the HTTP one.

/** Amounts are integer cents: 0.01 to 10 000.00 in the one supported currency. */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 1_000_000;
export const CURRENCIES = ["EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const MAX_METADATA_KEYS = 10;
export const MAX_METADATA_LENGTH = 200;
export const MAX_DESTINATION_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function validateAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
    throw new DomainError("invalid_amount", `amount must be an integer number of cents from ${MIN_AMOUNT} to ${MAX_AMOUNT}`, "amount");
  }
  return value;
}

export function validateCurrency(value: unknown): Currency {
  if (typeof value !== "string" || !(CURRENCIES as readonly string[]).includes(value)) {
    throw new DomainError("invalid_currency", `currency must be one of: ${CURRENCIES.join(", ")}`, "currency");
  }
  return value as Currency;
}

/** A map of text to text with at most 10 entries; keys and values have 1 to 200 and at most 200 characters. */
export function validateMetadata(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid_metadata", "metadata must be an object whose values are text", "metadata");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new DomainError("invalid_metadata", `metadata may have at most ${MAX_METADATA_KEYS} keys`, "metadata");
  }
  for (const [key, entry] of entries) {
    if (key.length < 1 || key.length > MAX_METADATA_LENGTH) {
      throw new DomainError("invalid_metadata", `a metadata key has 1 to ${MAX_METADATA_LENGTH} characters`, "metadata");
    }
    if (typeof entry !== "string" || entry.length > MAX_METADATA_LENGTH) {
      throw new DomainError("invalid_metadata", `the value of metadata key "${key.slice(0, 40)}" must be text of at most ${MAX_METADATA_LENGTH} characters`, "metadata");
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

/** Where the payment page sends the buyer back: an http or https URL in printable ASCII, without a login in it. */
export function validateReturnUrl(value: unknown, field: string): string {
  const reject = (reason: string): never => {
    throw new DomainError("invalid_url", `${field} ${reason}`, field);
  };
  if (typeof value !== "string" || value.length === 0) return reject("must be an http or https URL");
  if (value.length > MAX_URL_LENGTH) return reject(`must have at most ${MAX_URL_LENGTH} characters`);
  // No space, no control character and nothing outside ASCII: the value goes into a Location header unchanged.
  if (!/^[\x21-\x7E]+$/.test(value)) return reject("must be written in printable ASCII (percent-encode the rest)");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject("must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return reject("must be an http or https URL");
  if (url.username !== "" || url.password !== "") return reject("must not contain a user name or password");
  return value;
}

/** The account a payout goes to: any text of 1 to 200 characters without control characters. */
export function validateDestination(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_DESTINATION_LENGTH || /\p{Cc}/u.test(value)) {
    throw new DomainError("invalid_destination", `destination must be an account id of 1 to ${MAX_DESTINATION_LENGTH} characters`, "destination");
  }
  return value;
}

/** The Idempotency-Key header: 1 to 255 letters, digits and . _ : - */
export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_IDEMPOTENCY_KEY_LENGTH}}$`).test(value)) {
    throw new DomainError(
      "invalid_idempotency_key",
      `Idempotency-Key is required: 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} letters, digits and . _ : -`,
      "Idempotency-Key",
    );
  }
  return value;
}
