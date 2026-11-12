import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { NotFound, SessionNotOpen } from "../../usecases/errors.js";
import type { CheckoutOutcome } from "../../usecases/checkout-sessions.js";
import type { UseCases } from "../context.js";
import { pageHeaders, renderCheckoutPage, renderFinalPage, renderNotFoundPage } from "../checkout-page.js";
import { schemas } from "../schemas.js";

type IdParams = { Params: { id: string } };

function html(reply: FastifyReply, status: number, body: string, session?: Parameters<typeof pageHeaders>[0]): FastifyReply {
  return reply.code(status).headers(pageHeaders(session)).type("text/html; charset=utf-8").send(body);
}

/**
 * The payment page, public like a real provider's: whoever has the link (an id of 144 random bits) can pay or decline.
 * These routes answer HTML pages, also for an unknown id (404) and for a session that cannot change any more (409).
 */
export function registerCheckoutRoutes(app: FastifyInstance, useCases: UseCases): void {
  // Its own context, so that the form parser below belongs to these routes only: the JSON API keeps answering
  // 415 to a form.
  app.register((page, _options, done) => {
    // The two buttons are forms without fields; a browser still sends them as application/x-www-form-urlencoded.
    // The content is ignored: nothing in it can change what happens.
    page.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_request, _body, parsed) => {
      parsed(null, {});
    });

    page.get<IdParams>("/checkout/:id", { schema: schemas.page }, async (request, reply) => {
      try {
        const session = await useCases.getCheckoutSession.execute(request.params.id);
        return session.status === "open" ? html(reply, 200, renderCheckoutPage(session), session) : html(reply, 409, renderFinalPage(session));
      } catch (error) {
        if (error instanceof NotFound) return html(reply, 404, renderNotFoundPage());
        throw error;
      }
    });

    const answer = (outcome: CheckoutOutcome) => async (request: FastifyRequest<IdParams>, reply: FastifyReply): Promise<FastifyReply> => {
      try {
        const session = await useCases.completeCheckout.execute({ id: request.params.id, outcome });
        // 303: the browser follows the redirect to the shop with a GET, whatever the method of the form was.
        return reply
          .code(303)
          .header("location", outcome === "completed" ? session.successUrl : session.cancelUrl)
          .header("cache-control", "no-store")
          .send();
      } catch (error) {
        if (error instanceof NotFound) return html(reply, 404, renderNotFoundPage());
        if (error instanceof SessionNotOpen) return html(reply, 409, renderFinalPage(error.session));
        throw error;
      }
    };
    page.post<IdParams>("/checkout/:id/pay", { schema: schemas.page }, answer("completed"));
    page.post<IdParams>("/checkout/:id/decline", { schema: schemas.page }, answer("declined"));
    done();
  });
}
