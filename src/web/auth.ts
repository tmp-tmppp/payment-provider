import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./problems.js";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function unauthorized(detail: string): HttpError {
  return new HttpError(401, "unauthorized", detail, { "www-authenticate": 'Bearer realm="payment-provider"' });
}

/**
 * The tenant label of the request metrics: always null ("none"). The provider is called with one API key for one
 * merchant, so no request carries a verified tenant; the tenantId in the metadata of a session is the caller's own
 * claim in a body, never a label value. src/main.ts and the tests use this one function.
 */
export function tenantOfRequest(): null {
  return null;
}

const API_PREFIX = "/v1/";

/** The path as the router sees it: without the query, %-escapes decoded ("/%76%31/x" is "/v1/x" to the router). */
function decodedPath(url: string): string {
  const path = url.split("?")[0] ?? url;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * True for every request under /v1, whether or not a route matches it: an unknown /v1 path must not answer a stranger
 * differently from a known one. Looks at the matched route and at the path as sent, so that neither an escaped path
 * nor an unmatched one gets round the key.
 */
export function isApiRequest(request: FastifyRequest): boolean {
  return [request.routeOptions.url, decodedPath(request.url)].some((path) => path !== undefined && (path === "/v1" || path.startsWith(API_PREFIX)));
}

/**
 * The key check of every request under /v1 (app.ts runs it from one global onRequest hook, for all of them, also for
 * a path that matches no route): the caller must send "Authorization: Bearer <PROVIDER_API_KEY>". There is one
 * merchant and one key. Both sides are hashed before they are compared, so the comparison takes the same time for
 * every wrong key, whatever its length and however many leading characters are right. The key is never logged.
 */
export function apiKeyAuth(apiKey: string) {
  const expected = digest(apiKey);
  return (request: FastifyRequest): Promise<void> =>
    Promise.resolve().then(() => {
      const header = request.headers.authorization;
      if (!header) throw unauthorized("An API key is required: Authorization: Bearer <key>");
      const [scheme, token, ...rest] = header.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
        throw unauthorized("The Authorization header must be: Bearer <key>");
      }
      if (!timingSafeEqual(digest(token), expected)) {
        request.log.info({}, "A request with a wrong API key was refused");
        throw unauthorized("The API key is not valid");
      }
    });
}
