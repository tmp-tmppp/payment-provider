import { describe, expect, it } from "vitest";
import { Conflict, NotFound, SessionNotOpen, Unavailable, ValidationFailed } from "../../src/usecases/errors.js";
import { createCore, sessionBody } from "../support/harness.js";

const input = () => sessionBody();
const create = (core: ReturnType<typeof createCore>, key = "key-1", body: Record<string, unknown> = input()) =>
  core.useCases.createCheckoutSession.execute({ idempotencyKey: key, input: body as never });

describe("CreateCheckoutSession", () => {
  it("creates an open session that expires after the lifetime and writes no event yet", async () => {
    const core = createCore({ ttlMinutes: 45 });
    const { session, replayed } = await create(core);
    expect(replayed).toBe(false);
    expect(session).toMatchObject({ id: "cs_000000000000000000000001", status: "open", amount: 1250 });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(45 * 60_000);
    expect(core.webhooks.events).toEqual([]);
  });

  it("returns the same session for the same key and body, also when the keys of the body come in another order", async () => {
    const core = createCore();
    const first = await create(core);
    const again = await create(core, "key-1", { cancelUrl: input().cancelUrl, successUrl: input().successUrl, metadata: input().metadata, currency: "EUR", amount: 1250 });
    expect(again.replayed).toBe(true);
    expect(again.session.id).toBe(first.session.id);
    expect(core.store.sizes().sessions).toBe(1);
  });

  it("treats a missing metadata like an empty one", async () => {
    const core = createCore();
    const { metadata: _removed, ...withoutMetadata } = input();
    const first = await create(core, "k", withoutMetadata);
    const again = await create(core, "k", { ...withoutMetadata, metadata: {} });
    expect(again.replayed).toBe(true);
    expect(again.session.id).toBe(first.session.id);
  });

  it("answers 409 for the same key with another body, whichever field differs", async () => {
    const core = createCore();
    await create(core);
    for (const change of [{ amount: 1251 }, { metadata: { depositId: "dep-2" } }, { successUrl: "https://shop.example.test/other" }, { cancelUrl: "https://shop.example.test/other" }]) {
      const rejected = await create(core, "key-1", { ...input(), ...change }).catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(Conflict);
      expect(rejected).toMatchObject({ code: "idempotency_key_reused" });
    }
    expect(core.store.sizes().sessions).toBe(1);
  });

  it("keeps different keys apart, and the keys of sessions apart from the keys of payouts", async () => {
    const core = createCore();
    const a = await create(core, "key-a");
    const b = await create(core, "key-b");
    expect(a.session.id).not.toBe(b.session.id);
    const payout = await core.useCases.createPayout.execute({ idempotencyKey: "key-a", input: { amount: 5, currency: "EUR", destination: "acct" } });
    expect(payout.replayed).toBe(false);
  });

  it("makes only one session when two identical requests arrive at the same time", async () => {
    const core = createCore();
    const [first, second] = await Promise.all([create(core), create(core)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.session.id).toBe(second.session.id);
    expect(core.store.sizes().sessions).toBe(1);
  });

  it("refuses an invalid key and an invalid body with a validation error that names the field", async () => {
    const core = createCore();
    await expect(create(core, "bad key")).rejects.toMatchObject({ fields: [{ field: "Idempotency-Key" }] });
    await expect(create(core, null as never)).rejects.toBeInstanceOf(ValidationFailed);
    await expect(create(core, "k", { ...input(), amount: 0 })).rejects.toMatchObject({ fields: [{ field: "amount" }] });
    await expect(create(core, "k", { ...input(), successUrl: "ftp://x" })).rejects.toMatchObject({ fields: [{ field: "successUrl" }] });
    expect(core.store.sizes().sessions).toBe(0);
  });

  it("is unavailable when the store is full of open sessions, and makes room by dropping the oldest finished one", async () => {
    const core = createCore({ cap: 2 });
    const first = (await create(core, "k1")).session;
    const second = (await create(core, "k2")).session;
    await expect(create(core, "k3")).rejects.toBeInstanceOf(Unavailable);

    await core.useCases.completeCheckout.execute({ id: first.id, outcome: "completed" });
    const third = await create(core, "k3");
    expect(third.replayed).toBe(false);
    expect(core.store.sizes().sessions).toBe(2);
    await expect(core.useCases.getCheckoutSession.execute(first.id)).rejects.toBeInstanceOf(NotFound);
    // The key of the dropped session is free again (room is made by dropping the next finished session).
    await core.useCases.completeCheckout.execute({ id: second.id, outcome: "declined" });
    expect((await create(core, "k1")).replayed).toBe(false);
  });
});

describe("GetCheckoutSession", () => {
  it("returns the session, and 404 for one that does not exist", async () => {
    const core = createCore();
    const { session } = await create(core);
    expect(await core.useCases.getCheckoutSession.execute(session.id)).toEqual(session);
    await expect(core.useCases.getCheckoutSession.execute("cs_nope")).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("turns a session whose time is up into expired, with one event, however often it is read", async () => {
    const core = createCore({ ttlMinutes: 30 });
    const { session } = await create(core);
    core.clock.advanceMinutes(29);
    expect((await core.useCases.getCheckoutSession.execute(session.id)).status).toBe("open");
    expect(core.webhooks.events).toEqual([]);

    core.clock.advanceMinutes(1);
    expect((await core.useCases.getCheckoutSession.execute(session.id)).status).toBe("expired");
    expect((await core.useCases.getCheckoutSession.execute(session.id)).status).toBe("expired");
    expect(core.webhooks.events).toHaveLength(1);
    expect(core.webhooks.events[0]).toMatchObject({ type: "checkout.session.expired", data: { object: "checkout_session", id: session.id } });
  });

  it("expires a session once even when two readers find it due at the same time", async () => {
    const core = createCore();
    const { session } = await create(core);
    core.clock.advanceMinutes(31);
    const [a, b] = await Promise.all([core.useCases.getCheckoutSession.execute(session.id), core.useCases.getCheckoutSession.execute(session.id)]);
    expect([a.status, b.status]).toEqual(["expired", "expired"]);
    expect(core.webhooks.events).toHaveLength(1);
  });

  it("shows an expired session also on a replayed create", async () => {
    const core = createCore();
    await create(core);
    core.clock.advanceMinutes(31);
    const again = await create(core);
    expect(again.replayed).toBe(true);
    expect(again.session.status).toBe("expired");
  });
});

describe("CompleteCheckout", () => {
  it("completes an open session and queues checkout.session.completed", async () => {
    const core = createCore();
    const { session } = await create(core);
    const done = await core.useCases.completeCheckout.execute({ id: session.id, outcome: "completed" });
    expect(done.status).toBe("completed");
    expect((await core.useCases.getCheckoutSession.execute(session.id)).status).toBe("completed");
    expect(core.webhooks.events).toHaveLength(1);
    expect(core.webhooks.events[0]).toMatchObject({ id: "evt_000000000000000000000001", type: "checkout.session.completed", data: { object: "checkout_session", id: session.id } });
    expect((await core.store.getEvent("evt_000000000000000000000001"))?.delivery.status).toBe("pending");
  });

  it("declines an open session and queues checkout.session.declined", async () => {
    const core = createCore();
    const { session } = await create(core);
    expect((await core.useCases.completeCheckout.execute({ id: session.id, outcome: "declined" })).status).toBe("declined");
    expect(core.webhooks.types()).toEqual(["checkout.session.declined"]);
  });

  it("changes a session once: every later pay or decline answers SessionNotOpen with the final state and queues nothing", async () => {
    const core = createCore();
    const { session } = await create(core);
    await core.useCases.completeCheckout.execute({ id: session.id, outcome: "completed" });
    for (const outcome of ["completed", "declined"] as const) {
      const error = await core.useCases.completeCheckout.execute({ id: session.id, outcome }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SessionNotOpen);
      expect((error as SessionNotOpen).session.status).toBe("completed");
      expect(error).toMatchObject({ kind: "conflict", code: "session_not_open" });
    }
    expect(core.webhooks.events).toHaveLength(1);
  });

  it("lets only one of two clicks at the same time win", async () => {
    const core = createCore();
    const { session } = await create(core);
    const results = await Promise.allSettled([
      core.useCases.completeCheckout.execute({ id: session.id, outcome: "completed" }),
      core.useCases.completeCheckout.execute({ id: session.id, outcome: "declined" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(core.webhooks.events).toHaveLength(1);
  });

  it("does not pay a session whose time is up: it becomes expired and the buyer sees that", async () => {
    const core = createCore();
    const { session } = await create(core);
    core.clock.advanceMinutes(31);
    const error = await core.useCases.completeCheckout.execute({ id: session.id, outcome: "completed" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionNotOpen);
    expect((error as SessionNotOpen).session.status).toBe("expired");
    expect(core.webhooks.types()).toEqual(["checkout.session.expired"]);
  });

  it("answers 404 for an unknown session", async () => {
    await expect(createCore().useCases.completeCheckout.execute({ id: "cs_nope", outcome: "completed" })).rejects.toBeInstanceOf(NotFound);
  });
});

describe("ExpireSessions (the sweep)", () => {
  it("expires every open session whose time is up, with an event each, and leaves the others", async () => {
    const core = createCore({ ttlMinutes: 30 });
    const old1 = (await create(core, "k1")).session;
    const old2 = (await create(core, "k2")).session;
    const paid = (await create(core, "k3")).session;
    await core.useCases.completeCheckout.execute({ id: paid.id, outcome: "completed" });
    core.clock.advanceMinutes(20);
    const fresh = (await create(core, "k4")).session;
    core.clock.advanceMinutes(11);

    expect(await core.expireSessions.execute()).toBe(2);
    expect((await core.store.getSession(old1.id))?.status).toBe("expired");
    expect((await core.store.getSession(old2.id))?.status).toBe("expired");
    expect((await core.store.getSession(paid.id))?.status).toBe("completed");
    expect((await core.store.getSession(fresh.id))?.status).toBe("open");
    expect(core.webhooks.types().sort()).toEqual(["checkout.session.completed", "checkout.session.expired", "checkout.session.expired"]);
    // A second sweep finds nothing to do.
    expect(await core.expireSessions.execute()).toBe(0);
    expect(core.webhooks.events).toHaveLength(3);
  });
});
