import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory/memory-store.js";
import { randomIds, systemClock } from "../src/adapters/system.js";
import { WebhookSender } from "../src/adapters/webhooks/webhook-sender.js";
import { createLogger } from "../src/logger.js";
import { CompleteCheckout, CreateCheckoutSession, GetCheckoutSession } from "../src/usecases/checkout-sessions.js";
import { CreatePayout, GetPayout, SettlePayout } from "../src/usecases/payouts.js";
import type { UseCaseDeps } from "../src/usecases/ports.js";
import { GetEvent, GetTestMode, SetTestMode } from "../src/usecases/test-mode.js";
import { buildApp } from "../src/web/app.js";
import { API_KEY, ManualScheduler, PUBLIC_BASE_URL, WEBHOOK_SECRET, captureStream, payoutBody, sessionBody } from "./support/harness.js";

describe("logging", () => {
  it("writes one JSON object per line, with the service name and an ISO time", () => {
    const { stream, text } = captureStream();
    createLogger("info", stream).info({ eventId: "evt_1" }, "hello");
    const line = JSON.parse(text().trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 30, service: "payment-provider", eventId: "evt_1", msg: "hello" });
    expect(String(line["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts the Authorization header, API keys, secrets and signatures wherever they could appear", () => {
    const { stream, text } = captureStream();
    createLogger("info", stream).info(
      {
        req: { headers: { authorization: "Bearer leaked-1", cookie: "session=leaked-2" } },
        headers: { authorization: "Bearer leaked-3", "provider-signature": "t=1,v1=leaked-4" },
        apiKey: "leaked-5",
        config: { apiKey: "leaked-6", secret: "leaked-7" },
        secret: "leaked-8",
        signature: "leaked-9",
        webhook: { signature: "leaked-10", authorization: "leaked-11", headers: { "provider-signature": "leaked-12" } },
      },
      "x",
    );
    const output = text();
    for (let i = 1; i <= 12; i += 1) expect(output).not.toContain(`leaked-${i}`);
    expect(output).toContain("[redacted]");
  });

  it("never writes the API key, a key that was tried, the webhook secret or a signature during a whole payment", async () => {
    const { stream, text } = captureStream();
    const logger = createLogger("trace", stream);
    const store = new MemoryStore(100);
    const signatures: string[] = [];
    const webhooks = new WebhookSender({
      url: "http://payments.example.test/v1/webhooks/payment-provider",
      secret: WEBHOOK_SECRET,
      post: ({ headers }) => {
        signatures.push(headers["Provider-Signature"] ?? "");
        return Promise.resolve({ status: signatures.length === 1 ? 500 : 200 });
      },
      clock: systemClock,
      logger,
      report: (eventId, delivery) => void store.setDelivery(eventId, delivery),
      baseDelayMs: 1,
    });
    const scheduler = new ManualScheduler();
    const deps: UseCaseDeps = { store, clock: systemClock, ids: randomIds, webhooks, logger };
    const settle = new SettlePayout(deps);
    const app = buildApp({
      logger,
      apiKey: API_KEY,
      publicBaseUrl: PUBLIC_BASE_URL,
      health: { isDraining: () => false },
      useCases: {
        createCheckoutSession: new CreateCheckoutSession(deps, 30),
        getCheckoutSession: new GetCheckoutSession(deps),
        completeCheckout: new CompleteCheckout(deps),
        createPayout: new CreatePayout(deps, scheduler, 0, settle),
        getPayout: new GetPayout(deps),
        getTestMode: new GetTestMode(deps),
        setTestMode: new SetTestMode(deps),
        getEvent: new GetEvent(deps),
      },
    });
    await app.ready();

    const auth = { authorization: `Bearer ${API_KEY}` };
    await app.inject({ method: "GET", url: "/v1/test-mode", headers: { authorization: "Bearer a-wrong-key-that-was-tried" } });
    const session = (await app.inject({ method: "POST", url: "/v1/checkout-sessions", headers: { ...auth, "idempotency-key": "k" }, payload: sessionBody() })).json();
    await app.inject({ method: "GET", url: `/checkout/${session.id}` });
    await app.inject({ method: "POST", url: `/checkout/${session.id}/pay` });
    await app.inject({ method: "POST", url: "/v1/payouts", headers: { ...auth, "idempotency-key": "p" }, payload: payoutBody() });
    await scheduler.runAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await webhooks.stop();
    await app.close();

    const output = text();
    expect(signatures.length).toBeGreaterThanOrEqual(2);
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain("a-wrong-key-that-was-tried");
    expect(output).not.toContain(WEBHOOK_SECRET);
    for (const signature of signatures) {
      expect(output).not.toContain(signature);
      expect(output).not.toContain(signature.split("v1=")[1] ?? "-");
    }
    expect(output).not.toMatch(/Bearer /);
    // The log does tell what happened, in JSON, without the amounts of money of a buyer's private data.
    const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const messages = lines.map((line) => line["msg"]);
    expect(messages).toContain("A checkout session was created");
    expect(messages).toContain("A checkout session ended");
    expect(messages).toContain("A request with a wrong API key was refused");
    expect(messages).toContain("A webhook attempt failed; it will be repeated");
    expect(messages).toContain("A webhook was delivered");
    expect(lines.every((line) => line["service"] === "payment-provider")).toBe(true);
    expect(output).not.toContain("tenant-1");
  });

  it("never writes a session id, which is the bearer capability of its payment page: requests log /checkout/:id, use cases a short prefix", async () => {
    const { stream, text } = captureStream();
    const logger = createLogger("trace", stream);
    const store = new MemoryStore(100);
    const webhooks = new WebhookSender({
      url: "http://payments.example.test/v1/webhooks/payment-provider",
      secret: WEBHOOK_SECRET,
      post: () => Promise.resolve({ status: 200 }),
      clock: systemClock,
      logger,
      report: (eventId, delivery) => void store.setDelivery(eventId, delivery),
    });
    const deps: UseCaseDeps = { store, clock: systemClock, ids: randomIds, webhooks, logger };
    const app = buildApp({
      logger,
      apiKey: API_KEY,
      publicBaseUrl: PUBLIC_BASE_URL,
      health: { isDraining: () => false },
      useCases: {
        createCheckoutSession: new CreateCheckoutSession(deps, 30),
        getCheckoutSession: new GetCheckoutSession(deps),
        completeCheckout: new CompleteCheckout(deps),
        createPayout: new CreatePayout(deps, new ManualScheduler(), 0, new SettlePayout(deps)),
        getPayout: new GetPayout(deps),
        getTestMode: new GetTestMode(deps),
        setTestMode: new SetTestMode(deps),
        getEvent: new GetEvent(deps),
      },
    });
    await app.ready();

    const auth = { authorization: `Bearer ${API_KEY}` };
    const pay = (await app.inject({ method: "POST", url: "/v1/checkout-sessions", headers: { ...auth, "idempotency-key": "a" }, payload: sessionBody() })).json<{ id: string }>();
    const decline = (await app.inject({ method: "POST", url: "/v1/checkout-sessions", headers: { ...auth, "idempotency-key": "b" }, payload: sessionBody() })).json<{ id: string }>();
    await app.inject({ method: "GET", url: `/checkout/${pay.id}` });
    await app.inject({ method: "POST", url: `/checkout/${pay.id}/pay` });
    await app.inject({ method: "POST", url: `/checkout/${pay.id}/pay` });
    await app.inject({ method: "POST", url: `/checkout/${decline.id}/decline` });
    await app.inject({ method: "GET", url: "/checkout/cs_nobody-has-this-one" });
    await app.inject({ method: "GET", url: `/v1/checkout-sessions/${pay.id}?x=1`, headers: auth });
    await app.inject({ method: "GET", url: "/v1/payouts/po_stays-readable", headers: auth });
    await webhooks.stop();
    await app.close();

    const output = text();
    const lines = output.trim().split("\n").map((line) => JSON.parse(line) as { msg: string; req?: { url: string }; session?: string });
    for (const id of [pay.id, decline.id, "cs_nobody-has-this-one"]) expect(output, id).not.toContain(id);
    // The request lines keep the method and the route, without the id (the query stays).
    const urls = lines.flatMap((line) => (line.req ? [line.req.url] : []));
    expect(urls).toEqual(expect.arrayContaining(["/checkout/:id", "/checkout/:id/pay", "/checkout/:id/decline", "/v1/checkout-sessions/:id?x=1", "/v1/payouts/po_stays-readable"]));
    expect(urls.filter((url) => url.startsWith("/checkout/"))).toHaveLength(5);
    // The use cases say which session it was with the first 6 characters of its id.
    const sessions = lines.filter((line) => /^A checkout session/.test(line.msg)).map((line) => line.session);
    expect(sessions).toHaveLength(4);
    for (const session of sessions) expect([pay.id.slice(0, 6), decline.id.slice(0, 6)]).toContain(session);
    expect(new Set(sessions.map((session) => session?.length))).toEqual(new Set([6]));
  });
});
