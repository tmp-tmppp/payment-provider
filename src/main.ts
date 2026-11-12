import { MemoryStore } from "./adapters/memory/memory-store.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { PeriodicJob, TimerScheduler } from "./adapters/timers.js";
import { fetchPost } from "./adapters/webhooks/fetch-post.js";
import { WebhookSender } from "./adapters/webhooks/webhook-sender.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";
import { CompleteCheckout, CreateCheckoutSession, ExpireSessions, GetCheckoutSession } from "./usecases/checkout-sessions.js";
import { CreatePayout, GetPayout, SettlePayout } from "./usecases/payouts.js";
import { GetEvent, GetTestMode, SetTestMode } from "./usecases/test-mode.js";
import type { UseCaseDeps } from "./usecases/ports.js";
import { buildApp } from "./web/app.js";
import { tenantOfRequest } from "./web/auth.js";

// Composition root: configuration -> adapters -> use cases -> web application. Nothing else wires things together.

/** How often the sweep turns open sessions whose time is up into "expired". */
const SWEEP_EVERY_MS = 60_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting payment-provider");
  if (config.usesLocalSecrets) {
    logger.warn({}, "PROVIDER_API_KEY or WEBHOOK_SECRET is not set: using the local development values (APP_ENV=local)");
  }
  logger.warn({}, "All state is kept in memory: a restart forgets every session, payout and event");

  // Adapters.
  const store = new MemoryStore(config.storeCap);
  const webhooks = new WebhookSender({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    post: fetchPost,
    clock: systemClock,
    logger,
    report: (eventId, delivery) => {
      void store.setDelivery(eventId, delivery);
    },
  });
  const scheduler = new TimerScheduler(logger);

  // Use cases.
  const deps: UseCaseDeps = { store, clock: systemClock, ids: randomIds, webhooks, logger };
  const settlePayout = new SettlePayout(deps);
  const useCases = {
    createCheckoutSession: new CreateCheckoutSession(deps, config.checkoutTtlMinutes),
    getCheckoutSession: new GetCheckoutSession(deps),
    completeCheckout: new CompleteCheckout(deps),
    createPayout: new CreatePayout(deps, scheduler, config.payoutDelayMs, settlePayout),
    getPayout: new GetPayout(deps),
    getTestMode: new GetTestMode(deps),
    setTestMode: new SetTestMode(deps),
    getEvent: new GetEvent(deps),
  };

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // Request metrics; the tenant label is always "none" here (see tenantOfRequest in src/web/auth.js).
  const metrics = createMetrics({ tenantOf: tenantOfRequest });

  const app = buildApp({
    logger,
    useCases,
    apiKey: config.providerApiKey,
    publicBaseUrl: config.publicBaseUrl,
    health: { isDraining: () => shuttingDown },
    metrics,
  });
  const expireSessions = new ExpireSessions(deps);
  const sweeper = new PeriodicJob({ name: "expire-sessions", everyMs: SWEEP_EVERY_MS, run: () => expireSessions.execute(), logger });

  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");

  await app.listen({ host: "0.0.0.0", port: config.port });
  sweeper.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      stopSweeper: () => sweeper.stop(),
      stopPayouts: () => scheduler.stop(),
      stopWebhooks: () => webhooks.stop(),
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  registerShutdownSignals(process, shutdown);
}

main().catch((error: unknown) => {
  console.error("payment-provider failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
