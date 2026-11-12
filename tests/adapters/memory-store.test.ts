import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { newEvent } from "../../src/domain/event.js";
import { newPayout, settle } from "../../src/domain/payout.js";
import { complete, newSession } from "../../src/domain/session.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const session = (id: string) =>
  newSession({ amount: 100, currency: "EUR", successUrl: "https://s.example.test/ok", cancelUrl: "https://s.example.test/no" }, { id, now: NOW, ttlMinutes: 30 });
const payout = (id: string) => newPayout({ amount: 100, currency: "EUR", destination: "acct" }, { id, now: NOW });

describe("MemoryStore", () => {
  it("stores, reads and replaces a session only while it still has the expected status", async () => {
    const store = new MemoryStore(10);
    const s = session("cs_1");
    expect(await store.createSession("k", "f", s)).toEqual({ kind: "created", value: s });
    expect(await store.getSession("cs_1")).toEqual(s);
    expect(await store.getSession("cs_none")).toBeNull();

    expect(await store.saveSession(complete(s), "open")).toBe(true);
    expect((await store.getSession("cs_1"))?.status).toBe("completed");
    expect(await store.saveSession(complete(s), "open")).toBe(false);
    expect(await store.saveSession(session("cs_gone"), "open")).toBe(false);
  });

  it("answers replayed or mismatch for a key that is known, and keeps the keys of sessions and payouts apart", async () => {
    const store = new MemoryStore(10);
    const s = session("cs_1");
    await store.createSession("k", "f1", s);
    expect(await store.createSession("k", "f1", session("cs_2"))).toEqual({ kind: "replayed", value: s });
    expect(await store.createSession("k", "f2", session("cs_3"))).toEqual({ kind: "mismatch" });
    expect((await store.createPayout("k", "f1", payout("po_1"))).kind).toBe("created");
    expect(store.sizes()).toMatchObject({ sessions: 1, payouts: 1, keys: 2 });
  });

  it("lists the open sessions that are due", async () => {
    const store = new MemoryStore(10);
    const a = session("cs_a");
    const b = session("cs_b");
    await store.createSession("a", "f", a);
    await store.createSession("b", "f", b);
    await store.saveSession(complete(b), "open");
    expect(await store.dueSessions(new Date(a.expiresAt.getTime() - 1))).toEqual([]);
    expect((await store.dueSessions(a.expiresAt)).map((s) => s.id)).toEqual(["cs_a"]);
  });

  it("is full when every session is open, and drops the oldest finished session with its key and its events", async () => {
    const store = new MemoryStore(3);
    const [a, b, c] = [session("cs_a"), session("cs_b"), session("cs_c")] as const;
    for (const [i, s] of [a, b, c].entries()) await store.createSession(`k${i}`, "f", s);
    expect((await store.createSession("k9", "f", session("cs_d"))).kind).toBe("full");

    // b finishes first, then a: the oldest finished one is a (insertion order), whichever finished first.
    await store.saveSession(complete(b), "open");
    await store.saveSession(complete(a), "open");
    const event = newEvent("checkout.session.completed", "cs_a", { id: "evt_a", now: NOW });
    await store.saveEvent(event);
    await store.saveEvent(newEvent("checkout.session.completed", "cs_b", { id: "evt_b", now: NOW }));

    expect((await store.createSession("k9", "f", session("cs_d"))).kind).toBe("created");
    expect(await store.getSession("cs_a")).toBeNull();
    expect(await store.getSession("cs_b")).not.toBeNull();
    expect(await store.getEvent("evt_a")).toBeNull();
    expect(await store.getEvent("evt_b")).not.toBeNull();
    // The dropped session's key can be used again, for another request (it makes room by dropping b, the next finished one).
    expect((await store.createSession("k0", "other", session("cs_e"))).kind).toBe("created");
    expect(await store.getSession("cs_b")).toBeNull();
    expect(store.sizes()).toEqual({ sessions: 3, payouts: 0, events: 0, keys: 3 });
  });

  it("applies the same cap to payouts, on its own", async () => {
    const store = new MemoryStore(2);
    await store.createSession("s1", "f", session("cs_1"));
    await store.createSession("s2", "f", session("cs_2"));
    const p1 = payout("po_1");
    await store.createPayout("p1", "f", p1);
    await store.createPayout("p2", "f", payout("po_2"));
    expect((await store.createPayout("p3", "f", payout("po_3"))).kind).toBe("full");
    await store.savePayout(settle(p1, false, NOW), "pending");
    expect((await store.createPayout("p3", "f", payout("po_3"))).kind).toBe("created");
    expect(await store.getPayout("po_1")).toBeNull();
    expect(await store.savePayout(settle(payout("po_x"), false, NOW), "pending")).toBe(false);
  });

  it("keeps memory bounded however many requests come", async () => {
    const store = new MemoryStore(50);
    for (let i = 0; i < 500; i += 1) {
      const s = session(`cs_${i}`);
      const created = await store.createSession(`k${i}`, "f", s);
      if (created.kind === "full") {
        // Everything stored is open: finish the oldest, as a buyer or the sweep would.
        const oldest = (await store.dueSessions(new Date(NOW.getTime() + 31 * 60_000)))[0];
        if (oldest) await store.saveSession({ ...oldest, status: "expired" }, "open");
        expect((await store.createSession(`k${i}`, "f", s)).kind).toBe("created");
      }
      await store.saveEvent(newEvent("checkout.session.expired", s.id, { id: `evt_${i}`, now: NOW }));
    }
    const sizes = store.sizes();
    expect(sizes.sessions).toBeLessThanOrEqual(50);
    expect(sizes.keys).toBeLessThanOrEqual(50);
    expect(sizes.events).toBeLessThanOrEqual(50);
  });

  it("records the delivery of an event, and ignores an event that is gone", async () => {
    const store = new MemoryStore(10);
    await store.saveEvent(newEvent("payout.paid", "po_1", { id: "evt_1", now: NOW }));
    const delivery = { status: "delivered" as const, attempts: 2, lastStatus: 200, lastError: null, lastAttemptAt: NOW, nextAttemptAt: null };
    await store.setDelivery("evt_1", delivery);
    await store.setDelivery("evt_gone", delivery);
    expect((await store.getEvent("evt_1"))?.delivery).toEqual(delivery);
    expect(await store.getEvent("evt_gone")).toBeNull();
  });

  it("keeps the test mode as a copy", async () => {
    const store = new MemoryStore(10);
    expect(await store.getTestMode()).toEqual({ declinePayouts: false });
    await store.setTestMode({ declinePayouts: true });
    const mode = await store.getTestMode();
    mode.declinePayouts = false;
    expect(await store.getTestMode()).toEqual({ declinePayouts: true });
  });
});
