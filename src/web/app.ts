import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { apiKeyAuth, isApiRequest } from "./auth.js";
import type { UseCases } from "./context.js";
import { frameworkErrorHandler, registerProblemHandlers } from "./problems.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerCheckoutRoutes } from "./routes/checkout.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";

export interface WebDeps {
  logger: PinoLogger;
  useCases: UseCases;
  /** The one API key of the one merchant. */
  apiKey: string;
  /** Where the payment pages are reachable from outside, without a trailing slash: the "url" of a session starts with it. */
  publicBaseUrl: string;
  health: HealthChecks;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every route that was registered (filled once the application is ready), for the contract tests. */
    registeredRoutes: RegisteredRoute[];
  }
  interface FastifyRequest {
    correlationId: string;
  }
}

// Letters, digits and a few separators, so a client cannot inject anything odd into logs and headers.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Builds the Fastify application (not started): tests call it with app.inject. */
export function buildApp(deps: WebDeps): FastifyInstance {
  const logger: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    exposeHeadRoutes: false,
    bodyLimit: 16 * 1024,
    frameworkErrors: frameworkErrorHandler,
    // Strict input: no coercion ("100" is not an amount), no silent removal of unknown fields (they are a 400).
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });

  app.decorateRequest("correlationId", "");

  // Correlation: take X-Correlation-Id from the caller or make one, return it and bind it to the request logger.
  app.addHook("onRequest", (request, reply, done) => {
    const sent = request.headers["x-correlation-id"];
    request.correlationId = typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : randomUUID();
    reply.header("x-correlation-id", request.correlationId);
    request.log = reply.log = request.log.child({ correlationId: request.correlationId });
    done();
  });

  // Before the routes and the key check, so that every response is counted: also the 401 of a missing key and the 404 of a path that matches no route.
  deps.metrics?.attach(app);

  // The API key, for every path under /v1 (also one that matches no route: it answers 401 without the key and 404 with
  // it). A body is read only after this hook, so a stranger gets 401 whatever the body is.
  const authenticate = apiKeyAuth(deps.apiKey);
  app.addHook("onRequest", async (request) => {
    if (isApiRequest(request)) await authenticate(request);
  });

  // Every answer: the browser must not guess a content type, and nothing here is worth caching.
  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    done(null, payload);
  });

  registerProblemHandlers(app);
  registerHealthRoutes(app, deps.health);
  registerApiRoutes(app, deps.useCases, deps.publicBaseUrl);
  registerCheckoutRoutes(app, deps.useCases);

  return app;
}
