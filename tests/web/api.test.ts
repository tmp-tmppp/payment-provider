import { describe, expect, it } from "vitest";
import { API_KEY, PUBLIC_BASE_URL, createHarness, payoutBody, sessionBody } from "../support/harness.js";

const ROUTES: Array<[string, string, unknown?]> = [
  ["POST", "/v1/checkout-sessions", sessionBody()],
  ["GET", "/v1/checkout-sessions/cs_000000000000000000000001"],
  ["POST", "/v1/payouts", payoutBody()],
  ["GET", "/v1/payouts/po_000000000000000000000001"],
  ["GET", "/v1/test-mode"],
  ["PUT", "/v1/test-mode", { declinePayouts: true }],
  ["GET", "/v1/events/evt_000000000000000000000001"],
];

describe("authentication", () => {
  it("answers 401 with a problem and a Bearer challenge on every /v1 route when there is no key", async () => {
    const h = await createHarness();
    for (const [method, url, payload] of ROUTES) {
      const response = await h.call({ method: method, url, headers: { "idempotency-key": "k" }, ...(payload ? { payload: payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["www-authenticate"]).toBe('Bearer realm="payment-provider"');
      expect(response.json()).toMatchObject({ status: 401, code: "unauthorized", title: "Unauthorized", instance: url });
    }
    // Nothing was created.
    expect(h.store.sizes()).toMatchObject({ sessions: 0, payouts: 0 });
  });

  it("needs the key for every path under /v1, also one that does not exist: 401 without it, 404 with it", async () => {
    const h = await createHarness();
    const unknown: Array<["GET" | "POST" | "DELETE", string]> = [
      ["GET", "/v1/nothing"],
      ["GET", "/v1/"],
      ["GET", "/v1/payouts/po_1/extra"],
      ["DELETE", "/v1/payouts/po_1"],
      ["GET", "/v1/checkout-sessions"],
      ["POST", "/v1/nothing"],
      ["GET", "/v1/nothing?a=1"],
    ];
    for (const [method, url] of unknown) {
      const refused = await h.call({ method, url });
      expect(refused.statusCode, `${method} ${url} without a key`).toBe(401);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.headers["www-authenticate"]).toBe('Bearer realm="payment-provider"');
      expect(refused.json()).toMatchObject({ status: 401, code: "unauthorized", instance: url.split("?")[0] });
      const known = await h.api(method, url);
      expect(known.statusCode, `${method} ${url} with a key`).toBe(404);
      expect(known.json()).toMatchObject({ status: 404, code: "not_found" });
    }
    // A method the route does not have is the same: HEAD has no body to read, so only the status is checked.
    expect((await h.call({ method: "HEAD", url: "/v1/test-mode" })).statusCode).toBe(401);
    expect((await h.call({ method: "HEAD", url: "/v1/test-mode", headers: h.auth })).statusCode).toBe(404);
    // A path that is not under /v1 stays a plain 404, and a wrong key on an unknown path is refused like any other.
    expect((await h.call({ method: "GET", url: "/nothing" })).statusCode).toBe(404);
    expect((await h.call({ method: "GET", url: "/v1/nothing", headers: { authorization: "Bearer wrong-key" } })).statusCode).toBe(401);
  });

  it("does not let an escaped path reach a /v1 route without the key", async () => {
    const h = await createHarness();
    // The router decodes %-escapes before it matches, so "/%76%31/..." is the route /v1/...: the key is still needed.
    for (const url of ["/%76%31/test-mode", "/v%31/test-mode", "/v1/test%2Dmode", "/%76%31/nothing"]) {
      expect((await h.call({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect((await h.api("GET", "/%76%31/test-mode")).statusCode).toBe(200);
  });

  it("refuses a wrong key, a key of another length, a prefix of the key, the key in another scheme and a malformed header", async () => {
    const h = await createHarness();
    for (const authorization of [
      "Bearer wrong-key",
      "Bearer ",
      "Bearer x",
      `Bearer ${API_KEY}x`,
      `Bearer ${API_KEY.slice(0, -1)}`,
      `Bearer ${API_KEY.toUpperCase()}`,
      `Basic ${API_KEY}`,
      API_KEY,
      `Bearer ${API_KEY} extra`,
      "Bearer",
    ]) {
      const response = await h.call({ method: "GET", url: "/v1/test-mode", headers: { authorization } });
      expect(response.statusCode, authorization).toBe(401);
    }
  });

  it("accepts the key, whatever the case of the scheme", async () => {
    const h = await createHarness();
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      expect((await h.call({ method: "GET", url: "/v1/test-mode", headers: { authorization: `${scheme} ${API_KEY}` } })).statusCode).toBe(200);
    }
  });

  it("does not put the key, or what a caller sent as a key, into the answer", async () => {
    const h = await createHarness();
    const response = await h.call({ method: "GET", url: "/v1/test-mode", headers: { authorization: "Bearer secret-guess-123" } });
    expect(response.body).not.toContain("secret-guess-123");
    expect(response.body).not.toContain(API_KEY);
  });

  it("needs no key for the health probes and the payment page", async () => {
    const h = await createHarness();
    for (const url of ["/health/startup", "/health/ready", "/health/live"]) expect((await h.call({ method: "GET", url })).statusCode).toBe(200);
    expect((await h.call({ method: "GET", url: "/checkout/cs_000000000000000000000001" })).statusCode).toBe(404);
  });
});

describe("POST /v1/checkout-sessions", () => {
  it("creates a session: 201 with the page url, the expiry and the metadata", async () => {
    const h = await createHarness();
    const response = await h.createSession();
    expect(response.statusCode).toBe(201);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      id: "cs_000000000000000000000001",
      object: "checkout_session",
      url: `${PUBLIC_BASE_URL}/checkout/cs_000000000000000000000001`,
      status: "open",
      amount: 1250,
      currency: "EUR",
      metadata: { depositId: "dep-1", tenantId: "tenant-1" },
      successUrl: "https://shop.example.test/deposit/done",
      cancelUrl: "https://shop.example.test/deposit/cancelled",
      createdAt: "2026-11-01T10:00:00.000Z",
      expiresAt: "2026-11-01T10:30:00.000Z",
    });
  });

  it("answers the same Idempotency-Key and body with 200 and the same session; another body with 409", async () => {
    const h = await createHarness();
    const first = await h.createSession("k1");
    const again = await h.createSession("k1");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());

    const other = await h.createSession("k1", sessionBody({ amount: 1251 }));
    expect(other.statusCode).toBe(409);
    expect(other.headers["content-type"]).toContain("application/problem+json");
    expect(other.json()).toMatchObject({ status: 409, code: "idempotency_key_reused", type: "urn:chance:payment-provider:problem:idempotency-key-reused" });
    expect(h.store.sizes().sessions).toBe(1);
  });

  it("answers 400 when the Idempotency-Key is missing or malformed", async () => {
    const h = await createHarness();
    for (const key of [undefined, "", "has space", "x".repeat(256), "semi;colon"]) {
      const response = await h.call({ method: "POST", url: "/v1/checkout-sessions", headers: { ...h.auth, ...(key === undefined ? {} : { "idempotency-key": key }) }, payload: sessionBody() });
      expect(response.statusCode, String(key)).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_failed", errors: [{ field: "Idempotency-Key" }] });
    }
    expect(h.store.sizes().sessions).toBe(0);
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["an amount of 0", { amount: 0 }, "amount"],
    ["a negative amount", { amount: -1 }, "amount"],
    ["an amount over 1 000 000", { amount: 1_000_001 }, "amount"],
    ["a fractional amount", { amount: 12.5 }, "amount"],
    ["an amount sent as text", { amount: "1250" }, "amount"],
    ["a currency other than EUR", { currency: "USD" }, "currency"],
    ["a currency in lower case", { currency: "eur" }, "currency"],
    ["more than 10 metadata keys", { metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) }, "metadata"],
    ["a metadata value over 200 characters", { metadata: { a: "v".repeat(201) } }, "metadata.a"],
    ["a metadata value that is not text", { metadata: { a: 5 } }, "metadata.a"],
    ["metadata that is not an object", { metadata: "text" }, "metadata"],
    ["a success URL that is not http", { successUrl: "ftp://shop.example.test" }, "successUrl"],
    ["a success URL with a script", { successUrl: "javascript:alert(1)" }, "successUrl"],
    ["a cancel URL with a space", { cancelUrl: "https://shop.example.test/a b" }, "cancelUrl"],
    ["a cancel URL with a login", { cancelUrl: "https://user:secret@shop.example.test/" }, "cancelUrl"],
    ["a URL that is not a URL", { cancelUrl: "not a url" }, "cancelUrl"],
    ["a URL over 2048 characters", { successUrl: `https://shop.example.test/${"a".repeat(2048)}` }, "successUrl"],
    ["a field nobody knows", { surprise: true }, "surprise"],
  ];
  it.each(bad)("answers 400 for %s and names the field", async (_name, change, field) => {
    const h = await createHarness();
    const response = await h.createSession("k", sessionBody(change));
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const body = response.json();
    expect(body).toMatchObject({ status: 400, code: "validation_failed", instance: "/v1/checkout-sessions" });
    expect(body.errors.map((error: { field: string }) => error.field)).toContain(field);
    expect(h.store.sizes().sessions).toBe(0);
  });

  it("answers 400 for a missing required field, and for a body that is not an object or not JSON", async () => {
    const h = await createHarness();
    for (const missing of ["amount", "currency", "successUrl", "cancelUrl"]) {
      const { [missing]: _gone, ...rest } = sessionBody();
      const response = await h.createSession("k", rest);
      expect(response.statusCode, missing).toBe(400);
      expect(response.json().errors[0]).toMatchObject({ field: missing });
    }
    const array = await h.call({ method: "POST", url: "/v1/checkout-sessions", headers: { ...h.auth, "idempotency-key": "k", "content-type": "application/json" }, payload: "[]" });
    expect(array.statusCode).toBe(400);
    const broken = await h.call({ method: "POST", url: "/v1/checkout-sessions", headers: { ...h.auth, "idempotency-key": "k", "content-type": "application/json" }, payload: "{nope" });
    expect(broken.statusCode).toBe(400);
    expect(broken.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers 415 to a body that is not JSON (the form parser of the payment page does not reach the API)", async () => {
    const h = await createHarness();
    for (const contentType of ["application/xml", "application/octet-stream", "application/x-www-form-urlencoded"]) {
      const response = await h.call({ method: "POST", url: "/v1/checkout-sessions", headers: { ...h.auth, "idempotency-key": "k", "content-type": contentType }, payload: "amount=5" });
      expect(response.statusCode, contentType).toBe(415);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    }
    // Plain text is parsed as text, and a string is not a body: 400.
    const text = await h.call({ method: "POST", url: "/v1/checkout-sessions", headers: { ...h.auth, "idempotency-key": "k", "content-type": "text/plain" }, payload: "amount=5" });
    expect(text.statusCode).toBe(400);
  });

  it("answers 413 to a body over 16 KiB", async () => {
    const h = await createHarness();
    const response = await h.call({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...h.auth, "idempotency-key": "k", "content-type": "application/json" },
      payload: JSON.stringify(sessionBody({ metadata: { a: "x".repeat(17_000) } })),
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers 503 with Retry-After when the store holds only open sessions", async () => {
    const h = await createHarness({ cap: 1 });
    expect((await h.createSession("k1")).statusCode).toBe(201);
    const full = await h.createSession("k2");
    expect(full.statusCode).toBe(503);
    expect(full.headers["retry-after"]).toBe("60");
    expect(full.json()).toMatchObject({ status: 503, code: "capacity_exceeded" });
  });
});

describe("GET /v1/checkout-sessions/{id}", () => {
  it("returns the session, in its state now", async () => {
    const h = await createHarness();
    const created = (await h.createSession()).json();
    expect((await h.api("GET", `/v1/checkout-sessions/${created.id}`)).json()).toEqual(created);

    await h.call({ method: "POST", url: `/checkout/${created.id}/pay` });
    expect((await h.api("GET", `/v1/checkout-sessions/${created.id}`)).json().status).toBe("completed");
  });

  it("turns a session whose time is up into expired when it is read", async () => {
    const h = await createHarness();
    const created = (await h.createSession()).json();
    h.clock.advanceMinutes(30);
    expect((await h.api("GET", `/v1/checkout-sessions/${created.id}`)).json().status).toBe("expired");
    expect(h.webhooks.types()).toEqual(["checkout.session.expired"]);
  });

  it("answers 404 for an unknown id, and 400 for an id that is absurdly long", async () => {
    const h = await createHarness();
    const missing = await h.api("GET", "/v1/checkout-sessions/cs_unknown");
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.json()).toMatchObject({ status: 404, code: "session_not_found", instance: "/v1/checkout-sessions/cs_unknown" });
    expect((await h.api("GET", `/v1/checkout-sessions/${"a".repeat(65)}`)).statusCode).toBe(400);
    expect((await h.api("GET", `/v1/checkout-sessions/${"a".repeat(200)}`)).statusCode).toBe(414);
  });
});

describe("payouts", () => {
  it("creates a pending payout: 201, then 200 for a repeat and 409 for another body", async () => {
    const h = await createHarness();
    const created = await h.createPayout("k1");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      id: "po_000000000000000000000001",
      object: "payout",
      status: "pending",
      amount: 800,
      currency: "EUR",
      destination: "acct-demo-1",
      metadata: { withdrawalId: "wd-1" },
      failureReason: null,
      createdAt: "2026-11-01T10:00:00.000Z",
      settledAt: null,
    });
    const again = await h.createPayout("k1");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(created.json());
    expect((await h.createPayout("k1", payoutBody({ destination: "acct-other" }))).statusCode).toBe(409);
    expect(h.scheduler.tasks).toHaveLength(1);
  });

  it("pays after the delay, or fails with the reason declined when the test mode is on", async () => {
    const h = await createHarness({ payoutDelayMs: 1500 });
    const paid = (await h.createPayout("k1")).json();
    expect(h.scheduler.tasks[0]?.delayMs).toBe(1500);
    h.clock.advanceMs(1500);
    await h.scheduler.runAll();
    expect((await h.api("GET", `/v1/payouts/${paid.id}`)).json()).toMatchObject({ status: "paid", failureReason: null, settledAt: "2026-11-01T10:00:01.500Z" });

    expect((await h.api("PUT", "/v1/test-mode", { declinePayouts: true })).statusCode).toBe(200);
    const declined = (await h.createPayout("k2")).json();
    await h.scheduler.runAll();
    expect((await h.api("GET", `/v1/payouts/${declined.id}`)).json()).toMatchObject({ status: "failed", failureReason: "declined" });
    expect(h.webhooks.types()).toEqual(["payout.paid", "payout.failed"]);
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["an amount of 0", { amount: 0 }, "amount"],
    ["a currency other than EUR", { currency: "GBP" }, "currency"],
    ["an empty destination", { destination: "" }, "destination"],
    ["a destination over 200 characters", { destination: "a".repeat(201) }, "destination"],
    ["a destination with a control character", { destination: "acct\u0007" }, "destination"],
    ["a destination that is not text", { destination: 42 }, "destination"],
    ["too much metadata", { metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) }, "metadata"],
    ["a field nobody knows", { surprise: 1 }, "surprise"],
  ];
  it.each(bad)("answers 400 for %s", async (_name, change, field) => {
    const h = await createHarness();
    const response = await h.createPayout("k", payoutBody(change));
    expect(response.statusCode).toBe(400);
    expect(response.json().errors.map((error: { field: string }) => error.field)).toContain(field);
    expect(h.scheduler.tasks).toEqual([]);
  });

  it("answers 404 for an unknown payout and 400 without an Idempotency-Key", async () => {
    const h = await createHarness();
    expect((await h.api("GET", "/v1/payouts/po_unknown")).json()).toMatchObject({ status: 404, code: "payout_not_found" });
    expect((await h.api("POST", "/v1/payouts", payoutBody())).statusCode).toBe(400);
  });

  it("answers 503 when every stored payout is still pending", async () => {
    const h = await createHarness({ cap: 1 });
    expect((await h.createPayout("k1")).statusCode).toBe(201);
    const full = await h.createPayout("k2");
    expect(full.statusCode).toBe(503);
    expect(full.json().code).toBe("capacity_exceeded");
  });
});

describe("test mode", () => {
  it("starts with payouts that succeed and switches both ways", async () => {
    const h = await createHarness();
    expect((await h.api("GET", "/v1/test-mode")).json()).toEqual({ declinePayouts: false });
    expect((await h.api("PUT", "/v1/test-mode", { declinePayouts: true })).json()).toEqual({ declinePayouts: true });
    expect((await h.api("GET", "/v1/test-mode")).json()).toEqual({ declinePayouts: true });
    expect((await h.api("PUT", "/v1/test-mode", { declinePayouts: false })).json()).toEqual({ declinePayouts: false });
  });

  it("answers 400 for a body that is not exactly a boolean switch", async () => {
    const h = await createHarness();
    for (const payload of [{}, { declinePayouts: "true" }, { declinePayouts: 1 }, { declinePayouts: true, extra: 1 }]) {
      const response = await h.api("PUT", "/v1/test-mode", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await h.api("GET", "/v1/test-mode")).json()).toEqual({ declinePayouts: false });
  });
});

describe("GET /v1/events/{id}", () => {
  it("returns the event with the state of its delivery", async () => {
    const h = await createHarness();
    const session = (await h.createSession()).json();
    await h.call({ method: "POST", url: `/checkout/${session.id}/pay` });
    const response = await h.api("GET", "/v1/events/evt_000000000000000000000001");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "evt_000000000000000000000001",
      type: "checkout.session.completed",
      created: "2026-11-01T10:00:00.000Z",
      data: { object: "checkout_session", id: session.id },
      delivery: { status: "pending", attempts: 0, lastStatus: null, lastError: null, lastAttemptAt: null, nextAttemptAt: null },
    });
  });

  it("answers 404 for an unknown event", async () => {
    const h = await createHarness();
    expect((await h.api("GET", "/v1/events/evt_unknown")).json()).toMatchObject({ status: 404, code: "event_not_found" });
  });
});

describe("every answer", () => {
  it("carries a correlation id: the caller's, or a new one", async () => {
    const h = await createHarness();
    const mine = await h.call({ method: "GET", url: "/health/live", headers: { "x-correlation-id": "payments-req-42" } });
    expect(mine.headers["x-correlation-id"]).toBe("payments-req-42");
    const given = await h.call({ method: "GET", url: "/health/live", headers: { "x-correlation-id": "bad id with spaces\t" } });
    expect(given.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((await h.call({ method: "GET", url: "/health/live" })).headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("must not be sniffed or cached", async () => {
    const h = await createHarness();
    const response = await h.api("GET", "/v1/test-mode");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("is a problem for a route that does not exist", async () => {
    const h = await createHarness();
    for (const [method, url] of [["GET", "/v1/nothing"], ["GET", "/"], ["DELETE", "/v1/payouts/po_1"], ["GET", "/checkout"], ["GET", "/v1/checkout-sessions"]] as const) {
      const response = await h.api(method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ status: 404, code: "not_found" });
    }
  });
});

describe("health", () => {
  it("is ready until the process drains, then 503 while the rest of the API still answers", async () => {
    const h = await createHarness();
    expect((await h.call({ method: "GET", url: "/health/ready" })).json()).toEqual({ status: "up" });
    h.setDraining(true);
    const draining = await h.call({ method: "GET", url: "/health/ready" });
    expect(draining.statusCode).toBe(503);
    expect(draining.json()).toMatchObject({ code: "shutting_down" });
    expect((await h.call({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await h.call({ method: "GET", url: "/health/startup" })).statusCode).toBe(200);
    expect((await h.api("GET", "/v1/test-mode")).statusCode).toBe(200);
  });
});
