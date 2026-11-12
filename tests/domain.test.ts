import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { eventBody, initialDelivery, newEvent, objectOf } from "../src/domain/event.js";
import { fingerprint } from "../src/domain/idempotency.js";
import { validateAmount, validateCurrency, validateDestination, validateIdempotencyKey, validateMetadata, validateReturnUrl } from "../src/domain/input.js";
import { newPayout, settle } from "../src/domain/payout.js";
import { complete, decline, expire, isDue, newSession } from "../src/domain/session.js";
import { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER, sign, signatureHeader, verifySignature } from "../src/domain/signature.js";
import { readContract } from "./support/contracts.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const sessionInput = { amount: 1250, currency: "EUR", metadata: { a: "b" }, successUrl: "https://shop.example.test/ok", cancelUrl: "https://shop.example.test/no" };
const rejects = (fn: () => unknown, code: string, field?: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (field) expect((error as DomainError).field).toBe(field);
    return;
  }
  throw new Error("expected a DomainError");
};

describe("input rules", () => {
  it("accepts an amount from 1 to 1 000 000 cents and nothing else", () => {
    expect(validateAmount(1)).toBe(1);
    expect(validateAmount(1_000_000)).toBe(1_000_000);
    for (const bad of [0, -5, 1_000_001, 12.5, "100", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(() => validateAmount(bad), "invalid_amount", "amount");
    }
  });

  it("accepts the currency EUR and nothing else", () => {
    expect(validateCurrency("EUR")).toBe("EUR");
    for (const bad of ["USD", "eur", "", 3, undefined]) rejects(() => validateCurrency(bad), "invalid_currency", "currency");
  });

  it("limits metadata to 10 entries and 200 characters, as text", () => {
    expect(validateMetadata(undefined)).toEqual({});
    expect(validateMetadata({ a: "b" })).toEqual({ a: "b" });
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(validateMetadata(ten))).toHaveLength(10);
    expect(validateMetadata({ ["k".repeat(200)]: "v".repeat(200) })).toBeDefined();
    rejects(() => validateMetadata({ ...ten, extra: "v" }), "invalid_metadata", "metadata");
    rejects(() => validateMetadata({ a: "v".repeat(201) }), "invalid_metadata");
    rejects(() => validateMetadata({ ["k".repeat(201)]: "v" }), "invalid_metadata");
    rejects(() => validateMetadata({ "": "v" }), "invalid_metadata");
    rejects(() => validateMetadata({ a: 1 }), "invalid_metadata");
    rejects(() => validateMetadata({ a: null }), "invalid_metadata");
    rejects(() => validateMetadata(["a"]), "invalid_metadata");
    rejects(() => validateMetadata("text"), "invalid_metadata");
    rejects(() => validateMetadata(null), "invalid_metadata");
  });

  it("keeps a key called __proto__ as data and does not touch the prototype", () => {
    const metadata = validateMetadata(JSON.parse('{"__proto__": "x"}'));
    expect(Object.keys(metadata)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("accepts http and https return URLs in printable ASCII, without a login", () => {
    expect(validateReturnUrl("https://shop.example.test/ok?x=1", "successUrl")).toBe("https://shop.example.test/ok?x=1");
    expect(validateReturnUrl("http://localhost:5173/done", "cancelUrl")).toBe("http://localhost:5173/done");
    for (const bad of [
      "ftp://shop.example.test/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/relative/path",
      "https://",
      "",
      "https://shop.example.test/a b",
      "https://shop.example.test/a\r\nSet-Cookie: x=1",
      "https://shop.example.test/é",
      "https://user:pass@shop.example.test/",
      `https://shop.example.test/${"a".repeat(2048)}`,
      42,
      undefined,
    ]) {
      rejects(() => validateReturnUrl(bad, "successUrl"), "invalid_url", "successUrl");
    }
  });

  it("accepts a destination of 1 to 200 characters without control characters", () => {
    expect(validateDestination("acct-1")).toBe("acct-1");
    expect(validateDestination("x".repeat(200))).toHaveLength(200);
    for (const bad of ["", "x".repeat(201), "a\u0007b", "a\nb", 5, undefined]) rejects(() => validateDestination(bad), "invalid_destination", "destination");
  });

  it("accepts an idempotency key of 1 to 255 safe characters", () => {
    expect(validateIdempotencyKey("dep_018f3c1e:attempt.1-a")).toBe("dep_018f3c1e:attempt.1-a");
    expect(validateIdempotencyKey("k".repeat(255))).toHaveLength(255);
    for (const bad of ["", "k".repeat(256), "has space", "semi;colon", "slash/", undefined, 7]) {
      rejects(() => validateIdempotencyKey(bad), "invalid_idempotency_key", "Idempotency-Key");
    }
  });
});

describe("checkout session", () => {
  const make = () => newSession(sessionInput, { id: "cs_1", now: NOW, ttlMinutes: 30 });

  it("starts open and expires at creation time plus the lifetime", () => {
    const session = make();
    expect(session).toMatchObject({ id: "cs_1", status: "open", amount: 1250, currency: "EUR", metadata: { a: "b" } });
    expect(session.createdAt).toEqual(NOW);
    expect(session.expiresAt).toEqual(new Date("2026-11-01T10:30:00.000Z"));
  });

  it("validates every field when it is created", () => {
    rejects(() => newSession({ ...sessionInput, amount: 0 }, { id: "x", now: NOW, ttlMinutes: 30 }), "invalid_amount");
    rejects(() => newSession({ ...sessionInput, currency: "USD" }, { id: "x", now: NOW, ttlMinutes: 30 }), "invalid_currency");
    rejects(() => newSession({ ...sessionInput, successUrl: "ftp://x" }, { id: "x", now: NOW, ttlMinutes: 30 }), "invalid_url", "successUrl");
    rejects(() => newSession({ ...sessionInput, cancelUrl: "nope" }, { id: "x", now: NOW, ttlMinutes: 30 }), "invalid_url", "cancelUrl");
  });

  it("is due only when it is open and its time is up", () => {
    const session = make();
    expect(isDue(session, new Date(session.expiresAt.getTime() - 1))).toBe(false);
    expect(isDue(session, session.expiresAt)).toBe(true);
    expect(isDue({ ...session, status: "completed" }, new Date(session.expiresAt.getTime() + 1))).toBe(false);
  });

  it("changes from open to exactly one final state, and a final state never changes", () => {
    const session = make();
    expect(complete(session).status).toBe("completed");
    expect(decline(session).status).toBe("declined");
    expect(expire(session).status).toBe("expired");
    expect(session.status).toBe("open");
    for (const final of [complete(session), decline(session), expire(session)]) {
      for (const change of [complete, decline, expire]) rejects(() => change(final), "invalid_state");
    }
  });
});

describe("payout", () => {
  const make = () => newPayout({ amount: 800, currency: "EUR", destination: "acct-1", metadata: { w: "1" } }, { id: "po_1", now: NOW });

  it("starts pending", () => {
    expect(make()).toMatchObject({ id: "po_1", status: "pending", amount: 800, destination: "acct-1", failureReason: null, settledAt: null });
  });

  it("validates its fields", () => {
    rejects(() => newPayout({ amount: 0, currency: "EUR", destination: "a" }, { id: "x", now: NOW }), "invalid_amount");
    rejects(() => newPayout({ amount: 5, currency: "EUR", destination: "" }, { id: "x", now: NOW }), "invalid_destination");
  });

  it("settles as paid, or as failed with the reason declined, and only once", () => {
    const later = new Date(NOW.getTime() + 2000);
    expect(settle(make(), false, later)).toMatchObject({ status: "paid", failureReason: null, settledAt: later });
    expect(settle(make(), true, later)).toMatchObject({ status: "failed", failureReason: "declined", settledAt: later });
    rejects(() => settle(settle(make(), false, later), true, later), "invalid_state");
  });
});

describe("event", () => {
  it("is thin: its type, the kind and id of the object, and when", () => {
    const event = newEvent("payout.paid", "po_1", { id: "evt_1", now: NOW });
    expect(event).toEqual({ id: "evt_1", type: "payout.paid", created: NOW, data: { object: "payout", id: "po_1" } });
    expect(objectOf("checkout.session.expired")).toBe("checkout_session");
    expect(objectOf("payout.failed")).toBe("payout");
  });

  it("has a body of fixed key order and no spaces", () => {
    const event = newEvent("checkout.session.completed", "cs_1", { id: "evt_1", now: NOW });
    expect(eventBody(event)).toBe(
      '{"id":"evt_1","type":"checkout.session.completed","created":"2026-11-01T10:00:00.000Z","data":{"object":"checkout_session","id":"cs_1"}}',
    );
  });

  it("starts with a delivery that has not been tried", () => {
    expect(initialDelivery()).toEqual({ status: "pending", attempts: 0, lastStatus: null, lastError: null, lastAttemptAt: null, nextAttemptAt: null });
  });
});

describe("signature", () => {
  // The worked test vector of contracts/README.md. The payments authors check their code against it, so it is
  // computed here from the same inputs, and the page is checked to show these very values.
  const VECTOR = {
    secret: "test-vector-webhook-secret",
    timestamp: 1767225600,
    body: '{"id":"evt_Zm9vYmFyZm9vYmFyZm9vYmFy","type":"checkout.session.completed","created":"2026-01-01T00:00:00.000Z","data":{"object":"checkout_session","id":"cs_YmF6cXV4YmF6cXV4YmF6cXV4"}}',
    v1: "9af47717a62148755f24884229bfac1ff872ad81e86e154946e61eb071c37ba9",
  };

  it("matches the documented test vector", () => {
    expect(VECTOR.body).toHaveLength(182);
    expect(sign(VECTOR.secret, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.v1);
    expect(signatureHeader(VECTOR.secret, VECTOR.timestamp, VECTOR.body)).toBe(`t=1767225600,v1=${VECTOR.v1}`);
    expect(SIGNATURE_HEADER).toBe("Provider-Signature");
  });

  it("is the vector that contracts/README.md shows", () => {
    const page = readContract("README.md");
    for (const value of [VECTOR.secret, String(VECTOR.timestamp), VECTOR.body, VECTOR.v1, `t=1767225600,v1=${VECTOR.v1}`, "(182 bytes"]) {
      expect(page, value).toContain(value);
    }
  });

  it("is the event of the vector when the event builder makes it", () => {
    const event = newEvent("checkout.session.completed", "cs_YmF6cXV4YmF6cXV4YmF6cXV4", { id: "evt_Zm9vYmFyZm9vYmFyZm9vYmFy", now: new Date("2026-01-01T00:00:00.000Z") });
    expect(eventBody(event)).toBe(VECTOR.body);
  });

  const header = signatureHeader(VECTOR.secret, VECTOR.timestamp, VECTOR.body);
  const verify = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
    verifySignature({ secret: VECTOR.secret, header, rawBody: VECTOR.body, nowSeconds: VECTOR.timestamp + 5, ...overrides });

  it("verifies a good signature within the tolerance", () => {
    expect(verify()).toBe(true);
    expect(verify({ nowSeconds: VECTOR.timestamp + DEFAULT_TOLERANCE_SECONDS })).toBe(true);
    expect(verify({ nowSeconds: VECTOR.timestamp - DEFAULT_TOLERANCE_SECONDS })).toBe(true);
  });

  it("refuses a changed body, a wrong secret, a changed time and an old or future capture", () => {
    expect(verify({ rawBody: `${VECTOR.body} ` })).toBe(false);
    expect(verify({ rawBody: VECTOR.body.replace("completed", "declined") })).toBe(false);
    expect(verify({ secret: "another-secret" })).toBe(false);
    expect(verify({ header: header.replace("t=1767225600", "t=1767225601") })).toBe(false);
    expect(verify({ nowSeconds: VECTOR.timestamp + DEFAULT_TOLERANCE_SECONDS + 1 })).toBe(false);
    expect(verify({ nowSeconds: VECTOR.timestamp - DEFAULT_TOLERANCE_SECONDS - 1 })).toBe(false);
    expect(verify({ nowSeconds: VECTOR.timestamp + 10, toleranceSeconds: 5 })).toBe(false);
  });

  it("refuses a header that is missing or malformed", () => {
    for (const bad of [undefined, "", "garbage", `t=1767225600`, `v1=${VECTOR.v1}`, `t=abc,v1=${VECTOR.v1}`, `t=1767225600,v1=${VECTOR.v1.slice(2)}`, `t=1767225600,v1=${"g".repeat(64)}`, `t=1767225600,v1`]) {
      expect(verify({ header: bad }), String(bad)).toBe(false);
    }
  });

  it("accepts the event when any one of several v1 values matches (a rotated secret is signed twice)", () => {
    const rotated = `t=1767225600,v1=${"0".repeat(64)},v1=${VECTOR.v1}`;
    expect(verify({ header: rotated })).toBe(true);
    expect(verify({ header: `t=1767225600,v1=${"0".repeat(64)},v1=${"1".repeat(64)}` })).toBe(false);
  });
});

describe("idempotency fingerprint", () => {
  it("is the same for equal requests whatever the order of the keys", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(fingerprint({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });

  it("differs for any change", () => {
    const base = { amount: 100, metadata: { a: "b" } };
    expect(fingerprint({ ...base, amount: 101 })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, metadata: { a: "c" } })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, metadata: {} })).not.toBe(fingerprint(base));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint(undefined)).toBe(fingerprint(null));
  });
});
