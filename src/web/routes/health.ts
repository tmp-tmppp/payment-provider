import type { FastifyInstance } from "fastify";
import { HttpError } from "../problems.js";
import { schemas } from "../schemas.js";

export interface HealthChecks {
  /** True from the moment the process got SIGTERM: readiness then answers 503 while requests in flight finish. */
  isDraining(): boolean;
}

/** Kubernetes probes. No API key needed; the gateway does not route them. */
export function registerHealthRoutes(app: FastifyInstance, checks: HealthChecks): void {
  // Probes run every few seconds: log only their problems.
  const options = { schema: schemas.health, logLevel: "warn" } as const;

  // Answers once the service listens.
  app.get("/health/startup", options, () => ({ status: "up" }));

  // Ready = the process runs and is not shutting down. The state is in memory, so there is nothing else to ask; the
  // payments service is not asked either, because its outage must not stop this pod. Not ready once the process is
  // shutting down, so that the load balancer stops sending new requests before the server closes.
  app.get("/health/ready", options, () => {
    if (checks.isDraining()) throw new HttpError(503, "shutting_down", "The service is shutting down");
    return { status: "up" };
  });

  // Live = the process runs and the event loop answers.
  app.get("/health/live", options, () => ({ status: "up" }));
}
