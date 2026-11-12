import { createHmac, timingSafeEqual } from "node:crypto";

/** The header that carries the signature of a webhook. */
export const SIGNATURE_HEADER = "Provider-Signature";

/** How far the time in a signature may be from the receiver's clock before the receiver should refuse it. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret. */
export function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The value of the Provider-Signature header: "t=<unix seconds>,v1=<hex HMAC>". */
export function signatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, rawBody)}`;
}

export interface VerifyOptions {
  secret: string;
  /** The Provider-Signature header as received. */
  header: string | undefined;
  /** The request body exactly as received. */
  rawBody: string;
  /** The receiver's clock, in unix seconds. */
  nowSeconds: number;
  /** Default DEFAULT_TOLERANCE_SECONDS. */
  toleranceSeconds?: number;
}

/**
 * The check a receiver performs; the payments service has its own copy, this one documents the scheme and tests
 * the sender. It accepts the header only when it is well formed, the time is within the tolerance, and at least one
 * v1 value equals the expected HMAC (a rotated secret may be sent twice). Every comparison takes the same time.
 */
export function verifySignature(options: VerifyOptions): boolean {
  if (!options.header) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of options.header.split(",")) {
    const separator = part.indexOf("=");
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (separator < 0) return false;
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;
  if (Math.abs(options.nowSeconds - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(sign(options.secret, timestamp, options.rawBody), "hex");
  return candidates.map((candidate) => timingSafeEqual(Buffer.from(candidate, "hex"), expected)).some(Boolean);
}
