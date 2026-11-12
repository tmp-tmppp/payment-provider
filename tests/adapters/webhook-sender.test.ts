import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_ATTEMPTS, WebhookSender } from "../../src/adapters/webhooks/webhook-sender.js";
import type { PostFn, WebhookSenderOptions } from "../../src/adapters/webhooks/webhook-sender.js";
import type { Delivery, EventType } from "../../src/domain/event.js";
import { eventBody, newEvent } from "../../src/domain/event.js";
import { verifySignature } from "../../src/domain/signature.js";
import { RecordingLogger, WEBHOOK_SECRET } from "../support/harness.js";

// The backoff, the give-up, the order and the stop are tested here with a scripted POST and fake timers: the clock
// moves only when the test moves it. The real HTTP path is in webhook-sender-http.test.ts.

const START = new Date("2026-11-01T10:00:00.000Z");
const event = (id: string, objectId: string, type: EventType = "checkout.session.completed") => newEvent(type, objectId, { id, now: START });

type Call = { at: number; url: string; headers: Record<string, string>; body: string; timeoutMs: number };

/** A POST that answers with the given results in turn (the last one repeats): a status, or an error to throw. */
function scripted(results: Array<number | Error>) {
  const calls: Call[] = [];
  const post: PostFn = (request) => {
    calls.push({ at: Date.now() - START.getTime(), ...request });
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ status: next ?? 200 });
  };
  return { calls, post };
}

function makeSender(post: PostFn, extra: Partial<WebhookSenderOptions> = {}) {
  const logger = new RecordingLogger();
  const reports: Array<{ eventId: string; delivery: Delivery }> = [];
  const sender = new WebhookSender({
    url: "http://payments.example.test/v1/webhooks/payment-provider",
    secret: WEBHOOK_SECRET,
    post,
    clock: { now: () => new Date() },
    logger,
    report: (eventId, delivery) => reports.push({ eventId, delivery }),
    ...extra,
  });
  return { sender, logger, reports };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("WebhookSender", () => {
  it("has the documented defaults: 8 attempts, 1 second to start with", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
    expect(DEFAULT_BASE_DELAY_MS).toBe(1000);
  });

  it("sends the event as its exact body with a valid signature, and reports it delivered", async () => {
    const { calls, post } = scripted([200]);
    const { sender, logger, reports } = makeSender(post);
    const e = event("evt_1", "cs_1");

    sender.enqueue(e);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://payments.example.test/v1/webhooks/payment-provider", body: eventBody(e), timeoutMs: 5000 });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(
      verifySignature({ secret: WEBHOOK_SECRET, header: calls[0]?.headers["Provider-Signature"], rawBody: calls[0]?.body ?? "", nowSeconds: Date.now() / 1000 }),
    ).toBe(true);
    expect(reports.at(-1)).toMatchObject({ eventId: "evt_1", delivery: { status: "delivered", attempts: 1, lastStatus: 200, lastError: null, nextAttemptAt: null } });
    expect(logger.lines.at(-1)).toMatchObject({ level: "info", message: "A webhook was delivered" });
    expect(sender.pending()).toBe(0);
  });

  it("treats every 2xx as delivered, and a redirect, a 4xx and a 5xx as failures", async () => {
    for (const [status, delivered] of [[200, true], [201, true], [204, true], [299, true], [301, false], [302, false], [400, false], [404, false], [410, false], [500, false], [503, false]] as const) {
      const { calls, post } = scripted([status]);
      const { sender, reports } = makeSender(post, { maxAttempts: 1 });
      sender.enqueue(event("evt_1", "cs_1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls, String(status)).toHaveLength(1);
      expect(reports.at(-1)?.delivery.status, String(status)).toBe(delivered ? "delivered" : "failed");
    }
  });

  it("retries with exponential backoff: 1 s, then 2 s, and signs every attempt with its own time", async () => {
    const { calls, post } = scripted([500, 503, 200]);
    const { sender, logger, reports } = makeSender(post);

    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(reports.at(-1)?.delivery).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500, nextAttemptAt: new Date(START.getTime() + 1000) });
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", message: "A webhook attempt failed; it will be repeated", fields: { retryInMs: 1000 } });

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(reports.at(-1)?.delivery).toMatchObject({ status: "pending", attempts: 2, lastStatus: 503, nextAttemptAt: new Date(START.getTime() + 3000) });

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(reports.at(-1)?.delivery).toMatchObject({ status: "delivered", attempts: 3, lastStatus: 200 });

    expect(calls.map((call) => call.at)).toEqual([0, 1000, 3000]);
    // The body is the same bytes every time; the signed time is that of the attempt.
    expect(new Set(calls.map((call) => call.body)).size).toBe(1);
    const times = calls.map((call) => Number(/t=(\d+),/.exec(call.headers["Provider-Signature"] ?? "")?.[1]));
    expect(times).toEqual([0, 1, 3].map((offset) => START.getTime() / 1000 + offset));
    for (const call of calls) {
      expect(verifySignature({ secret: WEBHOOK_SECRET, header: call.headers["Provider-Signature"], rawBody: call.body, nowSeconds: (START.getTime() + call.at) / 1000 })).toBe(true);
    }
    expect(sender.pending()).toBe(0);
  });

  it("gives up after 8 attempts, with waits of 1, 2, 4, 8, 16, 32 and 64 seconds, and logs an error", async () => {
    const { calls, post } = scripted([500]);
    const { sender, logger, reports } = makeSender(post);

    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(127_000);

    expect(calls.map((call) => call.at)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 63_000, 127_000]);
    expect(reports.at(-1)).toMatchObject({ eventId: "evt_1", delivery: { status: "failed", attempts: 8, lastStatus: 500, nextAttemptAt: null } });
    const error = logger.lines.filter((line) => line.level === "error");
    expect(error).toHaveLength(1);
    expect(error[0]).toMatchObject({ message: "A webhook was given up after the last attempt", fields: { eventId: "evt_1", type: "checkout.session.completed", attempts: 8, lastStatus: 500 } });
    expect(sender.pending()).toBe(0);

    // Nothing is sent after that, however long it takes.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(8);
  });

  it("never writes the secret or a signature into a log line", async () => {
    const { calls, post } = scripted([500]);
    const { sender, logger } = makeSender(post, { maxAttempts: 3 });
    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(3000);

    const logged = JSON.stringify(logger.lines);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toMatch(/v1=|[0-9a-f]{64}/);
    for (const call of calls) expect(logged).not.toContain(call.headers["Provider-Signature"] ?? "-");
  });

  it("repeats an attempt that got no answer, and says why in a short word", async () => {
    const refused = new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8080"), { code: "ECONNREFUSED" }) });
    const { calls, post } = scripted([refused, new Error("boom"), 200]);
    const { sender, reports } = makeSender(post);

    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reports.at(-1)?.delivery).toMatchObject({ status: "pending", attempts: 1, lastStatus: null, lastError: "ECONNREFUSED" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.at(-1)?.delivery).toMatchObject({ attempts: 2, lastStatus: null, lastError: "Error" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    expect(reports.at(-1)?.delivery).toMatchObject({ status: "delivered", attempts: 3, lastStatus: 200, lastError: null });
  });

  it("delivers the events of one object one after the other, in order, and the events of other objects without waiting", async () => {
    const first = event("evt_1", "cs_1", "checkout.session.declined");
    const second = event("evt_2", "cs_1", "checkout.session.expired");
    const other = event("evt_3", "cs_2");
    const seen: string[] = [];
    const answers = new Map<string, number[]>([["evt_1", [500, 200]], ["evt_2", [200]], ["evt_3", [200]]]);
    const post: PostFn = ({ body }) => {
      const id = (JSON.parse(body) as { id: string }).id;
      seen.push(id);
      return Promise.resolve({ status: answers.get(id)?.shift() ?? 200 });
    };
    const { sender } = makeSender(post);

    sender.enqueue(first);
    sender.enqueue(second);
    sender.enqueue(other);
    expect(sender.pending()).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    // evt_1 failed and waits; evt_2 is behind it; evt_3 is about another object and went out at once.
    expect(seen).toEqual(["evt_1", "evt_3"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["evt_1", "evt_3", "evt_1", "evt_2"]);
    expect(sender.pending()).toBe(0);
  });

  it("lets the next event of an object go once the one before was given up", async () => {
    const seen: string[] = [];
    const post: PostFn = ({ body }) => {
      const id = (JSON.parse(body) as { id: string }).id;
      seen.push(id);
      return Promise.resolve({ status: id === "evt_1" ? 500 : 200 });
    };
    const { sender } = makeSender(post, { maxAttempts: 2 });
    sender.enqueue(event("evt_1", "cs_1"));
    sender.enqueue(event("evt_2", "cs_1"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["evt_1", "evt_1", "evt_2"]);
  });

  it("stops: waiting retries are dropped, an attempt in flight finishes, nothing new is accepted", async () => {
    const { calls, post } = scripted([500]);
    const { sender, logger } = makeSender(post);
    sender.enqueue(event("evt_1", "cs_1"));
    sender.enqueue(event("evt_2", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(sender.pending()).toBe(1);

    await sender.stop();
    expect(sender.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(logger.lines.filter((line) => line.message === "A webhook was not delivered: the service is stopping")).toHaveLength(2);

    sender.enqueue(event("evt_3", "cs_3"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", message: "The webhook sender is stopped; the event is not sent", fields: { eventId: "evt_3" } });
  });

  it("waits for the attempt that is in flight when it stops", async () => {
    let answer: (value: { status: number }) => void = () => undefined;
    const post: PostFn = () => new Promise((resolve) => (answer = resolve));
    const { sender, reports } = makeSender(post);
    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = sender.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    answer({ status: 200 });
    await stopping;
    expect(reports.at(-1)?.delivery.status).toBe("delivered");
  });

  it("does not start a backoff when the attempt that was in flight fails after stop(): stop() ends at once", async () => {
    let answer: (value: { status: number }) => void = () => undefined;
    const post: PostFn = () => new Promise((resolve) => (answer = resolve));
    const { sender, logger, reports } = makeSender(post);
    sender.enqueue(event("evt_1", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = sender.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    // The attempt answers 500: no wait of 1 s (or 64 s, further on) may follow, because the process has seconds left.
    answer({ status: 500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.lines.filter((line) => line.message === "A webhook was not delivered: the service is stopping")).toEqual([
      { level: "warn", message: "A webhook was not delivered: the service is stopping", fields: { eventId: "evt_1", type: "checkout.session.completed", attempts: 1 } },
    ]);
    // No retry was announced, and nothing is sent however long it takes.
    expect(logger.lines.some((line) => line.message === "A webhook attempt failed; it will be repeated")).toBe(false);
    expect(reports.some((entry) => entry.delivery.nextAttemptAt !== null)).toBe(false);
    expect(sender.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(logger.lines.filter((line) => line.message === "A webhook was not delivered: the service is stopping")).toHaveLength(1);
  });

  it("logs a crash of its own bookkeeping and goes on with the next event", async () => {
    const { calls, post } = scripted([200]);
    const { sender, logger } = makeSender(post, {
      report: () => {
        throw new Error("the store is gone");
      },
    });
    sender.enqueue(event("evt_1", "cs_1"));
    sender.enqueue(event("evt_2", "cs_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(logger.lines.filter((line) => line.message === "Delivering a webhook crashed")).toHaveLength(2);
    expect(sender.pending()).toBe(0);
  });
});
