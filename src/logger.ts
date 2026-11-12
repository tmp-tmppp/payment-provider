import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

// A session id is the bearer capability of its payment page (whoever has the link can pay or decline), so the logs do
// not carry it: the id after /checkout/ and after /v1/checkout-sessions/ is replaced by :id. The use cases log the
// first 6 characters of an id instead.
const SESSION_ID_IN_PATH = /^(\/checkout\/|\/v1\/checkout-sessions\/)[^/?#]+/;

/** The URL of a request as it is logged: the same, but without the session id. */
export function loggedUrl(url: string): string {
  return url.replace(SESSION_ID_IN_PATH, "$1:id");
}

interface LoggedRequest {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/** Fastify's own `req` serializer (method, url, version, host, remote address and port) with the URL cleaned up. */
function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: req.url === undefined ? undefined : loggedUrl(req.url),
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * JSON logs. The Authorization header, cookies, API keys, webhook secrets and signatures are redacted wherever they
 * could appear in a log line (the code never logs them in the first place; this is the second lock). Request ids and
 * correlation ids are bound by the web layer.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "payment-provider" },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { req: serializeRequest },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "authorization",
          "*.authorization",
          "apiKey",
          "*.apiKey",
          "secret",
          "*.secret",
          "signature",
          "*.signature",
          'headers["provider-signature"]',
          '*.headers["provider-signature"]',
          'req.headers["provider-signature"]',
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
