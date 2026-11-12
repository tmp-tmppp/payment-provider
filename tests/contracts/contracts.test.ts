import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from "../../src/adapters/webhooks/webhook-sender.js";
import { EVENT_TYPES, eventBody } from "../../src/domain/event.js";
import { CURRENCIES, MAX_AMOUNT, MAX_DESTINATION_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_METADATA_KEYS, MAX_METADATA_LENGTH, MAX_URL_LENGTH, MIN_AMOUNT } from "../../src/domain/input.js";
import { createHarness, payoutBody, sessionBody } from "../support/harness.js";
import { openapi, readContract, requestErrors, responseErrors, schemaErrors } from "../support/contracts.js";

const METHODS = ["get", "post", "put", "patch", "delete"];
type Operation = { operationId?: string; security?: unknown[]; responses: Record<string, any>; parameters?: unknown[] };
const operations = (): Array<{ path: string; method: string; operation: Operation }> =>
  Object.entries(openapi["paths"] as Record<string, Record<string, Operation>>).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );

describe("contracts/openapi.yaml", () => {
  it("lists exactly the routes the application registers", async () => {
    const h = await createHarness();
    const registered = h.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    const documented = operations().map(({ path, method }) => `${method.toUpperCase()} ${path}`).sort();
    await h.app.close();

    expect(registered.length).toBe(13);
    expect(registered).toEqual(documented);
  });

  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(openapi["components"].securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
    expect(openapi["security"]).toEqual([{ apiKey: [] }]);

    const ids = [
      ...operations().map(({ operation }) => operation.operationId ?? ""),
      ...Object.values(openapi["webhooks"] as Record<string, { post: Operation }>).map((hook) => hook.post.operationId ?? ""),
    ];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], openapi);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("leaves only the payment page and the health probes without a security requirement", () => {
    const open = operations()
      .filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0)
      .map(({ path }) => path)
      .sort();
    expect(open).toEqual(["/checkout/{id}", "/checkout/{id}/decline", "/checkout/{id}/pay", "/health/live", "/health/ready", "/health/startup"]);
    const secured = operations().filter(({ path }) => path.startsWith("/v1/"));
    expect(secured).toHaveLength(7);
    for (const { path, method, operation } of secured) {
      expect(operation.responses["401"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/Unauthorized" });
    }
  });

  it("requires an Idempotency-Key exactly where creating is not naturally repeatable", () => {
    const withKey = operations()
      .filter(({ operation }) => JSON.stringify(operation.parameters ?? []).includes("IdempotencyKey"))
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(withKey).toEqual(["POST /v1/checkout-sessions", "POST /v1/payouts"]);
    const key = openapi["components"].parameters.IdempotencyKey;
    expect(key).toMatchObject({ in: "header", required: true, name: "Idempotency-Key" });
    expect(new RegExp(key.schema.pattern).test("k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).toBe(true);
    expect(new RegExp(key.schema.pattern).test("k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toBe(false);
  });

  it("documents the problem+json answer of every error status of the API, and a page for the payment page", () => {
    for (const { path, method, operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status[0]) < 4) continue;
        const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
        // The payment page answers HTML when it has a page to show (404, 409); a problem comes before it (an id over the limit).
        const expected = path.startsWith("/checkout") && ["404", "409"].includes(status) ? ["text/html"] : ["application/problem+json"];
        expect(Object.keys(resolved.content), `${method} ${path} ${status}`).toEqual(expected);
      }
    }
  });

  it("documents what the application answers before a route runs: a long id (400, then 414), a body over 16 KiB (413) and a body that is not JSON (415)", () => {
    const answers = (path: string, method: string): Record<string, any> => openapi["paths"][path][method].responses;
    const problem = (response: any): string[] => Object.keys((response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response).content);
    const withId = operations().filter(({ path }) => path.endsWith("{id}") || path.includes("{id}/"));
    expect(withId.map(({ path, method }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      "GET /checkout/{id}",
      "GET /v1/checkout-sessions/{id}",
      "GET /v1/events/{id}",
      "GET /v1/payouts/{id}",
      "POST /checkout/{id}/decline",
      "POST /checkout/{id}/pay",
    ]);
    for (const { path, method, operation } of withId) {
      expect(Object.keys(operation.responses), `${method} ${path}`).toEqual(expect.arrayContaining(["400", "414"]));
      expect(problem(operation.responses["400"]), `${method} ${path} 400`).toEqual(["application/problem+json"]);
      expect(problem(operation.responses["414"]), `${method} ${path} 414`).toEqual(["application/problem+json"]);
    }
    expect(openapi["components"].parameters.ObjectId.schema.maxLength).toBe(64);
    for (const [path, method] of [["/v1/checkout-sessions", "post"], ["/v1/payouts", "post"], ["/v1/test-mode", "put"]] as const) {
      expect(Object.keys(answers(path, method)), `${method} ${path}`).toEqual(expect.arrayContaining(["413", "415"]));
      expect(problem(answers(path, method)["413"]), `${method} ${path} 413`).toEqual(["application/problem+json"]);
      expect(problem(answers(path, method)["415"]), `${method} ${path} 415`).toEqual(["application/problem+json"]);
    }
  });

  it("states the same limits as the code", () => {
    const schemas = openapi["components"].schemas;
    expect(schemas.Amount).toMatchObject({ type: "integer", minimum: MIN_AMOUNT, maximum: MAX_AMOUNT });
    expect(schemas.Currency.enum).toEqual([...CURRENCIES]);
    expect(schemas.Metadata).toMatchObject({ maxProperties: MAX_METADATA_KEYS, propertyNames: { maxLength: MAX_METADATA_LENGTH }, additionalProperties: { maxLength: MAX_METADATA_LENGTH } });
    expect(schemas.CreateCheckoutSessionRequest.properties.successUrl.maxLength).toBe(MAX_URL_LENGTH);
    expect(schemas.CreateCheckoutSessionRequest.properties.cancelUrl.maxLength).toBe(MAX_URL_LENGTH);
    expect(schemas.CreatePayoutRequest.properties.destination.maxLength).toBe(MAX_DESTINATION_LENGTH);
    expect(schemas.WebhookEvent.properties.type.enum).toEqual([...EVENT_TYPES]);
  });

  it("says in contracts/README.md what the sender does", () => {
    const page = readContract("README.md");
    expect(page).toContain(`**${DEFAULT_MAX_ATTEMPTS} attempts**`);
    expect(page).toContain("1, 2, 4, 8, 16, 32, 64 seconds");
    expect(page).toContain(`provider waits ${DEFAULT_TIMEOUT_MS / 1000} seconds`);
    expect(page).toContain("Provider-Signature: t=<unix seconds>,v1=<hex>");
    for (const type of EVENT_TYPES) expect(page, type).toContain(type);
  });

  it("says in contracts/README.md what the errors are and which return URLs payments may send", () => {
    const page = readContract("README.md");
    // Errors: the statuses that come before a route runs.
    for (const text of ["`413`", "`415`", "`414`", "16 KiB", "`Content-Type: application/json`", "longer than 64 characters", "`/checkout/{id}`"]) expect(page, text).toContain(text);
    // Return URLs: the provider redirects the buyer's browser to them.
    expect(page).toContain("only its own fixed return URLs");
    expect(page).toContain("never a URL that a user supplied");
    expect(page).toContain("redirects the buyer's browser");
  });
});

describe("requests", () => {
  it("are accepted by the contract and by the application alike", async () => {
    expect(requestErrors("/v1/checkout-sessions", "post", sessionBody())).toEqual([]);
    expect(requestErrors("/v1/payouts", "post", payoutBody())).toEqual([]);
    expect(requestErrors("/v1/test-mode", "put", { declinePayouts: true })).toEqual([]);
    const h = await createHarness();
    expect((await h.createSession()).statusCode).toBe(201);
    expect((await h.createPayout()).statusCode).toBe(201);
  });

  it("are refused by the contract and by the application alike", async () => {
    const h = await createHarness();
    const sessions: Array<Record<string, unknown>> = [
      { amount: 0 },
      { amount: MAX_AMOUNT + 1 },
      { amount: 12.5 },
      { amount: "1250" },
      { currency: "USD" },
      { surprise: 1 },
      { metadata: Object.fromEntries(Array.from({ length: MAX_METADATA_KEYS + 1 }, (_, i) => [`k${i}`, "v"])) },
      { metadata: { a: "v".repeat(MAX_METADATA_LENGTH + 1) } },
      { cancelUrl: "not a url" },
    ];
    for (const change of sessions) {
      expect(requestErrors("/v1/checkout-sessions", "post", sessionBody(change)).length, JSON.stringify(change)).toBeGreaterThan(0);
      expect((await h.createSession("k", sessionBody(change))).statusCode, JSON.stringify(change)).toBe(400);
    }
    const payouts: Array<Record<string, unknown>> = [{ amount: 0 }, { destination: "" }, { destination: "a".repeat(MAX_DESTINATION_LENGTH + 1) }, { currency: "GBP" }, { surprise: 1 }];
    for (const change of payouts) {
      expect(requestErrors("/v1/payouts", "post", payoutBody(change)).length, JSON.stringify(change)).toBeGreaterThan(0);
      expect((await h.createPayout("k", payoutBody(change))).statusCode, JSON.stringify(change)).toBe(400);
    }
    expect(requestErrors("/v1/test-mode", "put", { declinePayouts: "yes" }).length).toBeGreaterThan(0);
  });
});

describe("answers", () => {
  /** The documented key for a status: the exact one, or the class ("5XX"). */
  const documented = (path: string, method: string, status: number): string | undefined => {
    const responses = openapi["paths"][path]?.[method.toLowerCase()]?.responses ?? {};
    return [String(status), `${String(status)[0]}XX`].find((key) => key in responses);
  };

  /** Checks that the answer is documented and, for a JSON body, that it has the documented shape. */
  const conforms = (response: LightMyRequestResponse, method: string, path: string): void => {
    const key = documented(path, method, response.statusCode);
    expect(key, `${method} ${path} answered ${response.statusCode}, which the contract does not document`).toBeDefined();
    const resolvedRef = openapi["paths"][path][method.toLowerCase()].responses[key as string];
    const resolved = resolvedRef.$ref ? openapi["components"].responses[String(resolvedRef.$ref).split("/").pop() ?? ""] : resolvedRef;
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0] ?? "";
    for (const header of Object.keys(resolved.headers ?? {})) {
      expect(response.headers[header.toLowerCase()], `${method} ${path} ${response.statusCode}: header ${header}`).toBeDefined();
    }
    if (resolved.content) {
      expect(Object.keys(resolved.content), `${method} ${path} ${response.statusCode} content type`).toContain(contentType);
      if (contentType.includes("json")) {
        expect(responseErrors(path, method, key as string, response.json()), `${method} ${path} ${response.statusCode}`).toEqual([]);
      }
    } else {
      expect(response.body, `${method} ${path} ${response.statusCode} has no body in the contract`).toBe("");
    }
  };

  it("match the contract in every state the application can answer in", async () => {
    const h = await createHarness({ cap: 3, payoutDelayMs: 500 });
    const noKey = { method: "GET" as const, url: "/v1/test-mode" };

    // Sessions: 201, 200, 400, 401, 409, 404, 400 on an id that is too long.
    const created = await h.createSession("s1");
    conforms(created, "POST", "/v1/checkout-sessions");
    const id = created.json().id as string;
    conforms(await h.createSession("s1"), "POST", "/v1/checkout-sessions");
    conforms(await h.createSession("s2", sessionBody({ amount: 0 })), "POST", "/v1/checkout-sessions");
    conforms(await h.call({ method: "POST", url: "/v1/checkout-sessions", payload: sessionBody() }), "POST", "/v1/checkout-sessions");
    conforms(await h.createSession("s1", sessionBody({ amount: 99 })), "POST", "/v1/checkout-sessions");
    conforms(await h.api("GET", `/v1/checkout-sessions/${id}`), "GET", "/v1/checkout-sessions/{id}");
    conforms(await h.api("GET", "/v1/checkout-sessions/cs_none"), "GET", "/v1/checkout-sessions/{id}");
    conforms(await h.api("GET", `/v1/checkout-sessions/${"a".repeat(65)}`), "GET", "/v1/checkout-sessions/{id}");
    conforms(await h.call({ method: "GET", url: "/v1/checkout-sessions/cs_x" }), "GET", "/v1/checkout-sessions/{id}");
    conforms(await h.api("GET", `/v1/checkout-sessions/${"a".repeat(200)}`), "GET", "/v1/checkout-sessions/{id}");

    // The body of a request that the JSON API refuses before it reads it: 413 over 16 KiB, 415 for another type.
    const json = { ...h.auth, "content-type": "application/json" };
    const big = JSON.stringify({ filler: "x".repeat(17_000) });
    for (const [method, url, path] of [["POST", "/v1/checkout-sessions", "/v1/checkout-sessions"], ["POST", "/v1/payouts", "/v1/payouts"], ["PUT", "/v1/test-mode", "/v1/test-mode"]] as const) {
      const tooBig = await h.call({ method, url, headers: { ...json, "idempotency-key": "big" }, payload: big });
      expect(tooBig.statusCode, `${method} ${url}`).toBe(413);
      conforms(tooBig, method, path);
      const notJson = await h.call({ method, url, headers: { ...h.auth, "content-type": "application/xml", "idempotency-key": "xml" }, payload: "<a/>" });
      expect(notJson.statusCode, `${method} ${url}`).toBe(415);
      conforms(notJson, method, path);
    }

    // The payment page: 200, 303 on both buttons, 409 and 404; 400 and 414 for an id that is too long.
    for (const [method, prefix, suffix, path] of [["GET", "/checkout/", "", "/checkout/{id}"], ["POST", "/checkout/", "/pay", "/checkout/{id}/pay"], ["POST", "/checkout/", "/decline", "/checkout/{id}/decline"]] as const) {
      const long = await h.call({ method, url: `${prefix}${"a".repeat(65)}${suffix}` });
      expect(long.statusCode, `${method} ${path} with 65 characters`).toBe(400);
      expect(long.headers["content-type"]).toContain("application/problem+json");
      conforms(long, method, path);
      const longer = await h.call({ method, url: `${prefix}${"a".repeat(200)}${suffix}` });
      expect(longer.statusCode, `${method} ${path} with 200 characters`).toBe(414);
      conforms(longer, method, path);
    }
    const page = await h.call({ method: "GET", url: `/checkout/${id}` });
    conforms(page, "GET", "/checkout/{id}");
    const paid = await h.call({ method: "POST", url: `/checkout/${id}/pay` });
    conforms(paid, "POST", "/checkout/{id}/pay");
    expect(paid.statusCode).toBe(303);
    conforms(await h.call({ method: "POST", url: `/checkout/${id}/pay` }), "POST", "/checkout/{id}/pay");
    conforms(await h.call({ method: "POST", url: `/checkout/${id}/decline` }), "POST", "/checkout/{id}/decline");
    conforms(await h.call({ method: "GET", url: `/checkout/${id}` }), "GET", "/checkout/{id}");
    conforms(await h.call({ method: "GET", url: "/checkout/cs_none" }), "GET", "/checkout/{id}");
    conforms(await h.call({ method: "POST", url: "/checkout/cs_none/pay" }), "POST", "/checkout/{id}/pay");
    conforms(await h.call({ method: "POST", url: "/checkout/cs_none/decline" }), "POST", "/checkout/{id}/decline");
    const second = (await h.createSession("s3")).json().id as string;
    const declined = await h.call({ method: "POST", url: `/checkout/${second}/decline` });
    conforms(declined, "POST", "/checkout/{id}/decline");
    expect(declined.statusCode).toBe(303);
    const expiring = (await h.createSession("s4")).json().id as string;
    h.clock.advanceMinutes(31);
    conforms(await h.api("GET", `/v1/checkout-sessions/${expiring}`), "GET", "/v1/checkout-sessions/{id}");

    // Payouts: pending, paid, failed; 200, 400, 401, 409, 404.
    const payout = await h.createPayout("p1");
    conforms(payout, "POST", "/v1/payouts");
    conforms(await h.createPayout("p1"), "POST", "/v1/payouts");
    conforms(await h.createPayout("p2", payoutBody({ destination: "" })), "POST", "/v1/payouts");
    conforms(await h.call({ method: "POST", url: "/v1/payouts", payload: payoutBody() }), "POST", "/v1/payouts");
    conforms(await h.createPayout("p1", payoutBody({ amount: 1 })), "POST", "/v1/payouts");
    const payoutId = payout.json().id as string;
    conforms(await h.api("GET", `/v1/payouts/${payoutId}`), "GET", "/v1/payouts/{id}");
    await h.scheduler.runAll();
    conforms(await h.api("GET", `/v1/payouts/${payoutId}`), "GET", "/v1/payouts/{id}");
    await h.api("PUT", "/v1/test-mode", { declinePayouts: true });
    const failing = (await h.createPayout("p3")).json().id as string;
    await h.scheduler.runAll();
    const failed = await h.api("GET", `/v1/payouts/${failing}`);
    expect(failed.json().status).toBe("failed");
    conforms(failed, "GET", "/v1/payouts/{id}");
    conforms(await h.api("GET", "/v1/payouts/po_none"), "GET", "/v1/payouts/{id}");
    conforms(await h.api("GET", `/v1/payouts/${"a".repeat(65)}`), "GET", "/v1/payouts/{id}");
    conforms(await h.api("GET", `/v1/payouts/${"a".repeat(200)}`), "GET", "/v1/payouts/{id}");
    conforms(await h.call({ method: "GET", url: `/v1/payouts/${payoutId}` }), "GET", "/v1/payouts/{id}");

    // Test mode and events (the event of the first session is still stored).
    conforms(await h.api("GET", "/v1/test-mode"), "GET", "/v1/test-mode");
    conforms(await h.api("PUT", "/v1/test-mode", { declinePayouts: false }), "PUT", "/v1/test-mode");
    conforms(await h.api("PUT", "/v1/test-mode", { declinePayouts: "no" }), "PUT", "/v1/test-mode");
    conforms(await h.call({ method: "PUT", url: "/v1/test-mode", payload: { declinePayouts: true } }), "PUT", "/v1/test-mode");
    conforms(await h.call(noKey), "GET", "/v1/test-mode");
    const event = await h.api("GET", `/v1/events/${h.webhooks.events[0]?.id}`);
    expect(event.statusCode).toBe(200);
    conforms(event, "GET", "/v1/events/{id}");
    conforms(await h.api("GET", "/v1/events/evt_none"), "GET", "/v1/events/{id}");
    conforms(await h.api("GET", `/v1/events/${"a".repeat(65)}`), "GET", "/v1/events/{id}");
    conforms(await h.api("GET", `/v1/events/${"a".repeat(200)}`), "GET", "/v1/events/{id}");
    conforms(await h.call({ method: "GET", url: "/v1/events/evt_x" }), "GET", "/v1/events/{id}");

    // 503 of a full store (cap 3). Two payouts are finished, so three new ones fit by dropping them; the fourth
    // finds only pending ones. The same for the three finished sessions.
    for (const key of ["p4", "p5", "p6"]) expect((await h.createPayout(key)).statusCode).toBe(201);
    const full = await h.createPayout("p7");
    expect(full.statusCode).toBe(503);
    conforms(full, "POST", "/v1/payouts");
    for (const key of ["s5", "s6", "s7"]) expect((await h.createSession(key)).statusCode).toBe(201);
    const fullSessions = await h.createSession("s8");
    expect(fullSessions.statusCode).toBe(503);
    conforms(fullSessions, "POST", "/v1/checkout-sessions");

    // Health.
    for (const path of ["/health/startup", "/health/ready", "/health/live"]) conforms(await h.call({ method: "GET", url: path }), "GET", path);
    h.setDraining(true);
    conforms(await h.call({ method: "GET", url: "/health/ready" }), "GET", "/health/ready");
  });

  it("have the webhook shape for every event the application writes, and for the event read back", async () => {
    const h = await createHarness();
    const a = (await h.createSession("a")).json().id as string;
    const b = (await h.createSession("b")).json().id as string;
    const c = (await h.createSession("c")).json().id as string;
    await h.call({ method: "POST", url: `/checkout/${a}/pay` });
    await h.call({ method: "POST", url: `/checkout/${b}/decline` });
    h.clock.advanceMinutes(31);
    await h.api("GET", `/v1/checkout-sessions/${c}`);
    await h.createPayout("p1");
    await h.scheduler.runAll();
    await h.api("PUT", "/v1/test-mode", { declinePayouts: true });
    await h.createPayout("p2");
    await h.scheduler.runAll();

    expect(h.webhooks.events.map((event) => event.type).sort()).toEqual([...EVENT_TYPES].sort());
    for (const event of h.webhooks.events) {
      expect(schemaErrors("WebhookEvent", JSON.parse(eventBody(event))), event.type).toEqual([]);
      expect(Object.keys(JSON.parse(eventBody(event)))).toEqual(["id", "type", "created", "data"]);
      const read = await h.api("GET", `/v1/events/${event.id}`);
      expect(schemaErrors("EventDetails", read.json()), event.type).toEqual([]);
    }
  });

  it("are rejected by the contract when they break it", () => {
    const good = { id: "cs_000000000000000000000001", object: "checkout_session", url: "https://x.example/checkout/cs_1", status: "open", amount: 1, currency: "EUR", metadata: {}, successUrl: "https://a.example", cancelUrl: "https://b.example", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-11-01T10:30:00.000Z" };
    expect(schemaErrors("CheckoutSession", good)).toEqual([]);
    expect(schemaErrors("CheckoutSession", { ...good, status: "paid" })).not.toEqual([]);
    expect(schemaErrors("CheckoutSession", { ...good, id: "x_1" })).not.toEqual([]);
    expect(schemaErrors("CheckoutSession", { ...good, expiresAt: "tomorrow" })).not.toEqual([]);
    const { url: _url, ...withoutUrl } = good;
    expect(schemaErrors("CheckoutSession", withoutUrl)).not.toEqual([]);
    expect(schemaErrors("WebhookEvent", { id: "evt_000000000000000000000001", type: "payout.exploded", created: "2026-11-01T10:00:00.000Z", data: { object: "payout", id: "po_1" } })).not.toEqual([]);
  });
});
