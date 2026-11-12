import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_BASE_URL, payoutBody, sessionBody } from "./support/harness.js";
import { closeServers, startPayments, startProvider } from "./support/live.js";

// The flows of the plan (FL-B deposit, FL-C withdrawal) from the side of the payments service, against the provider
// as main.ts wires it: real ids, the real webhook sender over HTTP to a stand-in receiver, real timers.

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await closeServers();
});

async function start(extra: Partial<Parameters<typeof startProvider>[0]> = {}, answer?: (index: number) => number, now?: () => number) {
  const payments = await startPayments(now, answer);
  const provider = await startProvider({ webhookUrl: payments.url, ...extra });
  stops.push(provider.stop);
  return { payments, provider };
}

const webhooksOf = (payments: { received: unknown[] }, count: number) => vi.waitFor(() => expect(payments.received).toHaveLength(count), { timeout: 5000, interval: 5 });

describe("FL-B: deposit", () => {
  it("creates a session, the buyer pays, payments gets the signed thin event and reads the object back", async () => {
    const { payments, provider } = await start();

    // 1. payments asks for a checkout session and gets the link.
    const created = await provider.api("POST", "/v1/checkout-sessions", sessionBody({ metadata: { depositId: "dep-7", tenantId: "t-1" } }), "deposit:dep-7");
    expect(created.statusCode).toBe(201);
    const session = created.json();
    expect(session.id).toMatch(/^cs_[A-Za-z0-9_-]{24}$/);
    expect(session.url).toBe(`${PUBLIC_BASE_URL}/checkout/${session.id}`);

    // 2. The buyer opens the page and pays.
    const page = await provider.call({ method: "GET", url: new URL(session.url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Pay 12.50 EUR");
    const paid = await provider.call({ method: "POST", url: `${new URL(session.url).pathname}/pay` });
    expect(paid.statusCode).toBe(303);
    expect(paid.headers["location"]).toBe(session.successUrl);

    // 3. The webhook arrives: thin, signed, once.
    await webhooksOf(payments, 1);
    const [hook] = payments.received;
    expect(hook?.verified).toBe(true);
    expect(hook?.body).toMatchObject({ type: "checkout.session.completed", data: { object: "checkout_session", id: session.id } });
    expect(hook?.body.id).toMatch(/^evt_[A-Za-z0-9_-]{24}$/);
    expect(Object.keys(hook?.body ?? {}).sort()).toEqual(["created", "data", "id", "type"]);
    expect(hook?.rawBody).not.toContain("1250");
    expect(hook?.rawBody).not.toContain("dep-7");

    // 4. payments reads the object back through the API: the metadata tells which deposit it is.
    const read = (await provider.api("GET", `/v1/checkout-sessions/${session.id}`)).json();
    expect(read).toMatchObject({ status: "completed", amount: 1250, metadata: { depositId: "dep-7", tenantId: "t-1" } });
    // The receiver has the event before the provider has seen its 200 answer: wait for the delivery record.
    await vi.waitFor(async () => {
      const event = (await provider.api("GET", `/v1/events/${hook?.body.id}`)).json();
      expect(event.delivery).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200 });
    }, { timeout: 5000, interval: 5 });
  });

  it("sends checkout.session.declined when the buyer declines, and the buyer is sent back to the shop", async () => {
    const { payments, provider } = await start();
    const session = (await provider.api("POST", "/v1/checkout-sessions", sessionBody(), "k")).json();
    const declined = await provider.call({ method: "POST", url: `/checkout/${session.id}/decline` });
    expect(declined.statusCode).toBe(303);
    expect(declined.headers["location"]).toBe(session.cancelUrl);
    await webhooksOf(payments, 1);
    expect(payments.received[0]?.body.type).toBe("checkout.session.declined");
    expect((await provider.api("GET", `/v1/checkout-sessions/${session.id}`)).json().status).toBe("declined");
  });

  it("expires a session nobody paid, with one event, and the buyer who comes late cannot pay", async () => {
    let offsetMs = 0;
    const clock = { now: () => new Date(Date.now() + offsetMs) };
    const { payments, provider } = await start({ clock }, undefined, () => Date.now() + offsetMs);
    const session = (await provider.api("POST", "/v1/checkout-sessions", sessionBody(), "k")).json();

    offsetMs = 31 * 60_000;
    expect(await provider.expireSessions.execute()).toBe(1);
    await webhooksOf(payments, 1);
    expect(payments.received[0]).toMatchObject({ verified: true, body: { type: "checkout.session.expired", data: { id: session.id } } });

    const late = await provider.call({ method: "POST", url: `/checkout/${session.id}/pay` });
    expect(late.statusCode).toBe(409);
    expect(late.body).toContain("expired");
    expect((await provider.api("GET", `/v1/checkout-sessions/${session.id}`)).json().status).toBe("expired");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(payments.received).toHaveLength(1);
  });

  it("makes payments' retry after a timeout harmless: the same key gives the same session, and one payment is one event", async () => {
    const { payments, provider } = await start();
    const first = await provider.api("POST", "/v1/checkout-sessions", sessionBody(), "deposit:dep-9");
    const retry = await provider.api("POST", "/v1/checkout-sessions", sessionBody(), "deposit:dep-9");
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    await provider.call({ method: "POST", url: `/checkout/${first.json().id}/pay` });
    await provider.call({ method: "POST", url: `/checkout/${first.json().id}/pay` });
    await webhooksOf(payments, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(payments.received).toHaveLength(1);
  });

  it("keeps trying while payments is down, and delivers the event when it is back: the same event id, a signature for every attempt", async () => {
    const { payments, provider } = await start({}, (index) => (index < 2 ? 503 : 200));
    const session = (await provider.api("POST", "/v1/checkout-sessions", sessionBody(), "k")).json();
    await provider.call({ method: "POST", url: `/checkout/${session.id}/pay` });

    await webhooksOf(payments, 3);
    expect(new Set(payments.received.map((hook) => hook.body.id)).size).toBe(1);
    expect(payments.received.every((hook) => hook.verified)).toBe(true);
    await vi.waitFor(async () => {
      const event = (await provider.api("GET", `/v1/events/${payments.received[0]?.body.id}`)).json();
      expect(event.delivery).toMatchObject({ status: "delivered", attempts: 3, lastStatus: 200 });
    });
  });
});

describe("FL-C: withdrawal", () => {
  it("pays the payout after the delay and tells payments", async () => {
    const { payments, provider } = await start({ payoutDelayMs: 30 });
    const created = await provider.api("POST", "/v1/payouts", payoutBody({ metadata: { withdrawalId: "wd-3" } }), "withdrawal:wd-3");
    expect(created.statusCode).toBe(201);
    const payout = created.json();
    expect(payout).toMatchObject({ status: "pending", failureReason: null });
    expect(payout.id).toMatch(/^po_[A-Za-z0-9_-]{24}$/);
    expect((await provider.api("GET", `/v1/payouts/${payout.id}`)).json().status).toBe("pending");

    await webhooksOf(payments, 1);
    expect(payments.received[0]).toMatchObject({ verified: true, body: { type: "payout.paid", data: { object: "payout", id: payout.id } } });
    expect((await provider.api("GET", `/v1/payouts/${payout.id}`)).json()).toMatchObject({ status: "paid", failureReason: null, metadata: { withdrawalId: "wd-3" } });
    // A repeated request, after the payout was paid, still returns that payout and sends nothing new.
    expect((await provider.api("POST", "/v1/payouts", payoutBody({ metadata: { withdrawalId: "wd-3" } }), "withdrawal:wd-3")).statusCode).toBe(200);
  });

  it("fails the payout with the reason declined when the test mode is on: the forced failure of the saga demo", async () => {
    const { payments, provider } = await start({ payoutDelayMs: 10 });
    expect((await provider.api("PUT", "/v1/test-mode", { declinePayouts: true })).json()).toEqual({ declinePayouts: true });
    const payout = (await provider.api("POST", "/v1/payouts", payoutBody(), "withdrawal:wd-4")).json();

    await webhooksOf(payments, 1);
    expect(payments.received[0]).toMatchObject({ verified: true, body: { type: "payout.failed", data: { id: payout.id } } });
    expect((await provider.api("GET", `/v1/payouts/${payout.id}`)).json()).toMatchObject({ status: "failed", failureReason: "declined" });

    // Switched off again, the next payout is paid.
    await provider.api("PUT", "/v1/test-mode", { declinePayouts: false });
    const next = (await provider.api("POST", "/v1/payouts", payoutBody(), "withdrawal:wd-5")).json();
    await webhooksOf(payments, 2);
    expect(payments.received[1]).toMatchObject({ body: { type: "payout.paid", data: { id: next.id } } });
  });

  it("delivers the events of a busy minute, each with its own id and a valid signature", async () => {
    const { payments, provider } = await start({ payoutDelayMs: 5 });
    for (let i = 0; i < 20; i += 1) await provider.api("POST", "/v1/payouts", payoutBody({ metadata: { withdrawalId: `wd-${i}` } }), `withdrawal:${i}`);
    await webhooksOf(payments, 20);
    expect(new Set(payments.received.map((hook) => hook.body.id)).size).toBe(20);
    expect(payments.received.every((hook) => hook.verified && hook.body.type === "payout.paid")).toBe(true);
  });
});

describe("a restart", () => {
  it("forgets everything: the session, its page and its key are gone, and the same key makes a new session", async () => {
    const first = await start();
    const session = (await first.provider.api("POST", "/v1/checkout-sessions", sessionBody(), "deposit:dep-1")).json();
    await first.provider.stop();
    stops.pop();

    const second = await start();
    expect((await second.provider.api("GET", `/v1/checkout-sessions/${session.id}`)).statusCode).toBe(404);
    const page = await second.provider.call({ method: "GET", url: `/checkout/${session.id}` });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("provider was restarted");
    const again = await second.provider.api("POST", "/v1/checkout-sessions", sessionBody(), "deposit:dep-1");
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(session.id);
  });
});
