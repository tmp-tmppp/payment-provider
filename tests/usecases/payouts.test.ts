import { describe, expect, it } from "vitest";
import { Conflict, NotFound, Unavailable, ValidationFailed } from "../../src/usecases/errors.js";
import { createCore, payoutBody } from "../support/harness.js";

const create = (core: ReturnType<typeof createCore>, key = "key-1", body: Record<string, unknown> = payoutBody()) =>
  core.useCases.createPayout.execute({ idempotencyKey: key, input: body as never });

describe("CreatePayout", () => {
  it("creates a pending payout and schedules its settlement after the configured delay", async () => {
    const core = createCore({ payoutDelayMs: 1500 });
    const { payout, replayed } = await create(core);
    expect(replayed).toBe(false);
    expect(payout).toMatchObject({ id: "po_000000000000000000000001", status: "pending", amount: 800, destination: "acct-demo-1", failureReason: null, settledAt: null });
    expect(core.scheduler.tasks.map((task) => task.delayMs)).toEqual([1500]);
    expect(core.webhooks.events).toEqual([]);
  });

  it("pays the payout when the delay is over, and queues payout.paid", async () => {
    const core = createCore();
    const { payout } = await create(core);
    core.clock.advanceMs(2000);
    await core.scheduler.runAll();
    expect(await core.useCases.getPayout.execute(payout.id)).toMatchObject({ status: "paid", failureReason: null, settledAt: core.clock.now() });
    expect(core.webhooks.events).toHaveLength(1);
    expect(core.webhooks.events[0]).toMatchObject({ type: "payout.paid", data: { object: "payout", id: payout.id } });
  });

  it("fails the payout with the reason declined when the test mode asks for it, and queues payout.failed", async () => {
    const core = createCore();
    await core.useCases.setTestMode.execute({ declinePayouts: true });
    const { payout } = await create(core);
    await core.scheduler.runAll();
    expect(await core.useCases.getPayout.execute(payout.id)).toMatchObject({ status: "failed", failureReason: "declined" });
    expect(core.webhooks.types()).toEqual(["payout.failed"]);
  });

  it("reads the test mode when the payout settles, not when it is created", async () => {
    const core = createCore();
    const { payout } = await create(core);
    await core.useCases.setTestMode.execute({ declinePayouts: true });
    await core.scheduler.runAll();
    expect((await core.useCases.getPayout.execute(payout.id)).status).toBe("failed");

    const second = (await create(core, "key-2")).payout;
    await core.useCases.setTestMode.execute({ declinePayouts: false });
    await core.scheduler.runAll();
    expect((await core.useCases.getPayout.execute(second.id)).status).toBe("paid");
  });

  it("settles a payout once: a second run changes nothing and queues nothing", async () => {
    const core = createCore();
    const { payout } = await create(core);
    await core.settlePayout.execute(payout.id);
    await core.settlePayout.execute(payout.id);
    await core.settlePayout.execute("po_unknown");
    expect(core.webhooks.events).toHaveLength(1);
  });

  it("returns the same payout for the same key and body, without a second settlement", async () => {
    const core = createCore();
    const first = await create(core);
    const again = await create(core);
    expect(again.replayed).toBe(true);
    expect(again.payout.id).toBe(first.payout.id);
    expect(core.scheduler.tasks).toHaveLength(1);
    expect(core.store.sizes().payouts).toBe(1);
  });

  it("answers 409 for the same key with another body", async () => {
    const core = createCore();
    await create(core);
    for (const change of [{ amount: 801 }, { destination: "acct-other" }, { metadata: { withdrawalId: "wd-2" } }]) {
      const rejected = await create(core, "key-1", { ...payoutBody(), ...change }).catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(Conflict);
      expect(rejected).toMatchObject({ code: "idempotency_key_reused" });
    }
    expect(core.scheduler.tasks).toHaveLength(1);
  });

  it("refuses an invalid body and an invalid key", async () => {
    const core = createCore();
    await expect(create(core, "k", { ...payoutBody(), destination: "a".repeat(201) })).rejects.toMatchObject({ fields: [{ field: "destination" }] });
    await expect(create(core, "k", { ...payoutBody(), amount: 1.5 })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(create(core, "")).rejects.toMatchObject({ fields: [{ field: "Idempotency-Key" }] });
    expect(core.scheduler.tasks).toEqual([]);
  });

  it("is unavailable when every stored payout is still pending, and drops the oldest finished one otherwise", async () => {
    const core = createCore({ cap: 2 });
    const first = (await create(core, "k1")).payout;
    await create(core, "k2");
    await expect(create(core, "k3")).rejects.toBeInstanceOf(Unavailable);
    await core.settlePayout.execute(first.id);
    expect((await create(core, "k3")).replayed).toBe(false);
    await expect(core.useCases.getPayout.execute(first.id)).rejects.toBeInstanceOf(NotFound);
  });
});

describe("GetPayout, GetEvent and the test mode", () => {
  it("answers 404 for an unknown payout and an unknown event", async () => {
    const core = createCore();
    await expect(core.useCases.getPayout.execute("po_nope")).rejects.toMatchObject({ code: "payout_not_found" });
    await expect(core.useCases.getEvent.execute("evt_nope")).rejects.toMatchObject({ code: "event_not_found" });
  });

  it("starts with payouts that are paid, and changes with PUT", async () => {
    const core = createCore();
    expect(await core.useCases.getTestMode.execute()).toEqual({ declinePayouts: false });
    expect(await core.useCases.setTestMode.execute({ declinePayouts: true })).toEqual({ declinePayouts: true });
    expect(await core.useCases.getTestMode.execute()).toEqual({ declinePayouts: true });
    expect(core.logger.lines.at(-1)).toMatchObject({ level: "info", message: "The test mode was changed", fields: { declinePayouts: true } });
  });

  it("returns an event with its delivery", async () => {
    const core = createCore();
    const { payout } = await create(core);
    await core.settlePayout.execute(payout.id);
    const stored = await core.useCases.getEvent.execute("evt_000000000000000000000001");
    expect(stored.event).toMatchObject({ type: "payout.paid" });
    expect(stored.delivery).toMatchObject({ status: "pending", attempts: 0 });
  });
});
