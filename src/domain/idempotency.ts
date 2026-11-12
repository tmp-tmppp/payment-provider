import { createHash } from "node:crypto";

/** JSON with the keys of every object sorted, so that two equal requests give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A short digest of a normalized request. The same Idempotency-Key with the same digest is a repeat of the same
 * request; with another digest it is a mistake of the caller (409).
 */
export function fingerprint(request: unknown): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}
