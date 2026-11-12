import { Writable } from "node:stream";
import type { FastifyInstance, InjectOptions } from "fastify";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { ProviderEvent } from "../../src/domain/event.js";
import { createLogger } from "../../src/logger.js";
import { CompleteCheckout, CreateCheckoutSession, ExpireSessions, GetCheckoutSession } from "../../src/usecases/checkout-sessions.js";
import { CreatePayout, GetPayout, SettlePayout } from "../../src/usecases/payouts.js";
import type { Clock, IdGenerator, Logger, Scheduler, UseCaseDeps, WebhookQueue } from "../../src/usecases/ports.js";
import { GetEvent, GetTestMode, SetTestMode } from "../../src/usecases/test-mode.js";
import { buildApp } from "../../src/web/app.js";
import type { WebDeps } from "../../src/web/app.js";

export const API_KEY = "test-api-key-0123456789";
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789";
export const PUBLIC_BASE_URL = "https://pay.example.test";
export const SUCCESS_URL = "https://shop.example.test/deposit/done";
export const CANCEL_URL = "https://shop.example.test/deposit/cancelled";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }
}

/** Ids that are predictable and have the real shape: prefix and 24 characters. */
export class SequentialIds implements IdGenerator {
  private sessions = 0;
  private payouts = 0;
  private events = 0;
  private pad = (n: number): string => String(n).padStart(24, "0");
  newSessionId(): string {
    this.sessions += 1;
    return `cs_${this.pad(this.sessions)}`;
  }
  newPayoutId(): string {
    this.payouts += 1;
    return `po_${this.pad(this.payouts)}`;
  }
  newEventId(): string {
    this.events += 1;
    return `evt_${this.pad(this.events)}`;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
}

/** Takes the events that the use cases queue, so that a test sees them without any HTTP. */
export class RecordingWebhooks implements WebhookQueue {
  readonly events: ProviderEvent[] = [];
  enqueue(event: ProviderEvent): void {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

/** Holds the tasks that the use cases schedule; a test runs them when it wants. */
export class ManualScheduler implements Scheduler {
  readonly tasks: Array<{ delayMs: number; task: () => Promise<void> | void }> = [];
  after(delayMs: number, task: () => Promise<void> | void): void {
    this.tasks.push({ delayMs, task });
  }
  /** Runs every task that was scheduled so far, in order, and forgets them. */
  async runAll(): Promise<void> {
    const due = this.tasks.splice(0);
    for (const { task } of due) await task();
  }
}

export interface CoreOptions {
  cap?: number;
  ttlMinutes?: number;
  payoutDelayMs?: number;
}

/** The use cases wired to an in-memory store and fakes, without the web layer. */
export function createCore(options: CoreOptions = {}) {
  const store = new MemoryStore(options.cap ?? 100);
  const clock = new TestClock();
  const ids = new SequentialIds();
  const webhooks = new RecordingWebhooks();
  const scheduler = new ManualScheduler();
  const logger = new RecordingLogger();
  const deps: UseCaseDeps = { store, clock, ids, webhooks, logger };
  const settlePayout = new SettlePayout(deps);
  const useCases = {
    createCheckoutSession: new CreateCheckoutSession(deps, options.ttlMinutes ?? 30),
    getCheckoutSession: new GetCheckoutSession(deps),
    completeCheckout: new CompleteCheckout(deps),
    createPayout: new CreatePayout(deps, scheduler, options.payoutDelayMs ?? 2000, settlePayout),
    getPayout: new GetPayout(deps),
    getTestMode: new GetTestMode(deps),
    setTestMode: new SetTestMode(deps),
    getEvent: new GetEvent(deps),
  };
  const expireSessions = new ExpireSessions(deps);
  return { store, clock, ids, webhooks, scheduler, logger, deps, useCases, settlePayout, expireSessions };
}

export const sessionBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  amount: 1250,
  currency: "EUR",
  metadata: { depositId: "dep-1", tenantId: "tenant-1" },
  successUrl: SUCCESS_URL,
  cancelUrl: CANCEL_URL,
  ...overrides,
});

export const payoutBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  amount: 800,
  currency: "EUR",
  destination: "acct-demo-1",
  metadata: { withdrawalId: "wd-1" },
  ...overrides,
});

/** The whole application on top of createCore, driven with app.inject. */
export async function createHarness(options: CoreOptions & { metrics?: WebDeps["metrics"] } = {}) {
  const core = createCore(options);
  const draining = { value: false };
  const app: FastifyInstance = buildApp({
    logger: createLogger("silent"),
    useCases: core.useCases,
    apiKey: API_KEY,
    publicBaseUrl: PUBLIC_BASE_URL,
    health: { isDraining: () => draining.value },
    metrics: options.metrics,
  });
  await app.ready();

  const auth = { authorization: `Bearer ${API_KEY}` };
  const call = (opts: InjectOptions) => app.inject(opts);
  /** An API call with the key. `key` is the Idempotency-Key. */
  const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, key?: string) =>
    app.inject({
      method,
      url,
      headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const createSession = (key = "key-1", body: Record<string, unknown> = sessionBody()) => api("POST", "/v1/checkout-sessions", body, key);
  const createPayout = (key = "key-1", body: Record<string, unknown> = payoutBody()) => api("POST", "/v1/payouts", body, key);

  return { ...core, app, auth, call, api, createSession, createPayout, setDraining: (value: boolean) => (draining.value = value) };
}

/** A stream that keeps what is written to it, to read a logger's output. */
export function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}
