import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";
import { eventView, payoutView, sessionView } from "../views.js";

type IdParams = { Params: { id: string } };

/** The merchant API under /v1. The API key is checked for all of /v1 by the onRequest hook of app.ts, before any body is read. */
export function registerApiRoutes(app: FastifyInstance, useCases: UseCases, publicBaseUrl: string): void {
  const key = (request: FastifyRequest): unknown => request.headers["idempotency-key"];

  app.post("/v1/checkout-sessions", { schema: schemas.createSession }, async (request, reply) => {
    const { session, replayed } = await useCases.createCheckoutSession.execute({
      idempotencyKey: key(request),
      input: request.body as Parameters<UseCases["createCheckoutSession"]["execute"]>[0]["input"],
    });
    return reply.code(replayed ? 200 : 201).send(sessionView(session, publicBaseUrl));
  });

  app.get<IdParams>("/v1/checkout-sessions/:id", { schema: schemas.getSession }, async (request) =>
    sessionView(await useCases.getCheckoutSession.execute(request.params.id), publicBaseUrl),
  );

  app.post("/v1/payouts", { schema: schemas.createPayout }, async (request, reply) => {
    const { payout, replayed } = await useCases.createPayout.execute({
      idempotencyKey: key(request),
      input: request.body as Parameters<UseCases["createPayout"]["execute"]>[0]["input"],
    });
    return reply.code(replayed ? 200 : 201).send(payoutView(payout));
  });

  app.get<IdParams>("/v1/payouts/:id", { schema: schemas.getPayout }, async (request) =>
    payoutView(await useCases.getPayout.execute(request.params.id)),
  );

  app.get("/v1/test-mode", { schema: schemas.getTestMode }, () => useCases.getTestMode.execute());

  app.put("/v1/test-mode", { schema: schemas.setTestMode }, (request) =>
    useCases.setTestMode.execute(request.body as { declinePayouts: boolean }),
  );

  app.get<IdParams>("/v1/events/:id", { schema: schemas.getEvent }, async (request) =>
    eventView(await useCases.getEvent.execute(request.params.id)),
  );
}
