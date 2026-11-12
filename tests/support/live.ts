import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance, InjectOptions } from "fastify";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { randomIds } from "../../src/adapters/system.js";
import { TimerScheduler } from "../../src/adapters/timers.js";
import { fetchPost } from "../../src/adapters/webhooks/fetch-post.js";
import { WebhookSender } from "../../src/adapters/webhooks/webhook-sender.js";
import { SIGNATURE_HEADER, verifySignature } from "../../src/domain/signature.js";
import { createLogger } from "../../src/logger.js";
import { CompleteCheckout, CreateCheckoutSession, ExpireSessions, GetCheckoutSession } from "../../src/usecases/checkout-sessions.js";
import { CreatePayout, GetPayout, SettlePayout } from "../../src/usecases/payouts.js";
import type { Clock, UseCaseDeps } from "../../src/usecases/ports.js";
import { GetEvent, GetTestMode, SetTestMode } from "../../src/usecases/test-mode.js";
import { buildApp } from "../../src/web/app.js";
import { API_KEY, PUBLIC_BASE_URL, WEBHOOK_SECRET } from "./harness.js";

/** What the stand-in for the payments service received at its webhook address. */
export interface Webhook {
  rawBody: string;
  body: { id: string; type: string; created: string; data: { object: string; id: string } };
  signature: string | undefined;
  /** The check payments would make, at the time the test says it is. */
  verified: boolean;
}

const servers: Server[] = [];

/** A stand-in for the webhook endpoint of payments, on a free localhost port. `answer` decides the status. */
export async function startPayments(now: () => number = () => Date.now(), answer: (index: number) => number = () => 200) {
  const received: Webhook[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers[SIGNATURE_HEADER.toLowerCase()] as string | undefined;
      received.push({ rawBody, body: JSON.parse(rawBody) as Webhook["body"], signature, verified: verifySignature({ secret: WEBHOOK_SECRET, header: signature, rawBody, nowSeconds: now() / 1000 }) });
      response.writeHead(answer(received.length - 1)).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}/v1/webhooks/payment-provider` };
}

export async function closeServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface LiveOptions {
  webhookUrl: string;
  clock?: Clock;
  payoutDelayMs?: number;
  ttlMinutes?: number;
  baseDelayMs?: number;
  maxAttempts?: number;
  cap?: number;
}

/**
 * The provider as main.ts wires it: the real webhook sender over HTTP, the timer scheduler and the real ids, on top
 * of the same web application. Only the configuration is the test's.
 */
export async function startProvider(options: LiveOptions) {
  const logger = createLogger("silent");
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const store = new MemoryStore(options.cap ?? 100);
  const webhooks = new WebhookSender({
    url: options.webhookUrl,
    secret: WEBHOOK_SECRET,
    post: fetchPost,
    clock,
    logger,
    report: (eventId, delivery) => void store.setDelivery(eventId, delivery),
    baseDelayMs: options.baseDelayMs ?? 5,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  const scheduler = new TimerScheduler(logger);
  const deps: UseCaseDeps = { store, clock, ids: randomIds, webhooks, logger };
  const settle = new SettlePayout(deps);
  const app: FastifyInstance = buildApp({
    logger,
    apiKey: API_KEY,
    publicBaseUrl: PUBLIC_BASE_URL,
    health: { isDraining: () => false },
    useCases: {
      createCheckoutSession: new CreateCheckoutSession(deps, options.ttlMinutes ?? 30),
      getCheckoutSession: new GetCheckoutSession(deps),
      completeCheckout: new CompleteCheckout(deps),
      createPayout: new CreatePayout(deps, scheduler, options.payoutDelayMs ?? 20, settle),
      getPayout: new GetPayout(deps),
      getTestMode: new GetTestMode(deps),
      setTestMode: new SetTestMode(deps),
      getEvent: new GetEvent(deps),
    },
  });
  await app.ready();

  const auth = { authorization: `Bearer ${API_KEY}` };
  const call = (opts: InjectOptions) => app.inject(opts);
  const api = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, key?: string) =>
    app.inject({ method, url, headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return {
    app,
    api,
    call,
    store,
    webhooks,
    expireSessions: new ExpireSessions(deps),
    stop: async () => {
      await webhooks.stop();
      await scheduler.stop();
      await app.close();
    },
  };
}
