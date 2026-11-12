import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPost } from "../../src/adapters/webhooks/fetch-post.js";
import { WebhookSender } from "../../src/adapters/webhooks/webhook-sender.js";
import type { Delivery } from "../../src/domain/event.js";
import { eventBody, newEvent } from "../../src/domain/event.js";
import { SIGNATURE_HEADER, verifySignature } from "../../src/domain/signature.js";
import { RecordingLogger, WEBHOOK_SECRET } from "../support/harness.js";

// The real HTTP path: fetch against a server that this test starts on a free localhost port (port 0). The server
// verifies what a receiver would verify.

interface Received {
  method: string | undefined;
  path: string | undefined;
  contentType: string | undefined;
  signature: string | undefined;
  rawBody: string;
  verified: boolean;
}

const servers: Server[] = [];

async function receiver(answer: (request: Received, response: ServerResponse, index: number) => void) {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers[SIGNATURE_HEADER.toLowerCase()] as string | undefined;
      const entry: Received = {
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        signature,
        rawBody,
        verified: verifySignature({ secret: WEBHOOK_SECRET, header: signature, rawBody, nowSeconds: Date.now() / 1000 }),
      };
      received.push(entry);
      answer(entry, response, received.length - 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}/v1/webhooks/payment-provider`, port };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function senderFor(url: string, extra: { maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number } = {}) {
  const logger = new RecordingLogger();
  const reports: Delivery[] = [];
  const sender = new WebhookSender({
    url,
    secret: WEBHOOK_SECRET,
    post: fetchPost,
    clock: { now: () => new Date() },
    logger,
    report: (_id, delivery) => reports.push(delivery),
    baseDelayMs: 5,
    ...extra,
  });
  return { sender, logger, reports };
}

const idle = (sender: WebhookSender) => vi.waitFor(() => expect(sender.pending()).toBe(0), { timeout: 5000, interval: 5 });
const event = (id: string, objectId: string) => newEvent("payout.paid", objectId, { id, now: new Date("2026-11-01T10:00:00.000Z") });

describe("WebhookSender over HTTP", () => {
  it("POSTs the raw body of the event with a signature that a receiver can verify", async () => {
    const { received, url } = await receiver((_request, response) => void response.writeHead(200).end("ok"));
    const { sender, reports } = senderFor(url);
    const e = event("evt_http1", "po_1");

    sender.enqueue(e);
    await idle(sender);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", path: "/v1/webhooks/payment-provider", contentType: "application/json", rawBody: eventBody(e), verified: true });
    expect(received[0]?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(reports.at(-1)).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200 });
  });

  it("repeats the request until the receiver answers 2xx, with the same body every time", async () => {
    const { received, url } = await receiver((_request, response, index) => void response.writeHead(index < 2 ? 500 : 204).end());
    const { sender, reports } = senderFor(url);

    sender.enqueue(event("evt_http2", "po_1"));
    await idle(sender);

    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.rawBody)).size).toBe(1);
    expect(received.every((r) => r.verified)).toBe(true);
    expect(reports.at(-1)).toMatchObject({ status: "delivered", attempts: 3, lastStatus: 204 });
  });

  it("does not follow a redirect: the signed body goes only where the operator pointed it", async () => {
    const { received, url } = await receiver((request, response) => void response.writeHead(302, { location: "/elsewhere" }).end());
    const { sender, reports } = senderFor(url, { maxAttempts: 2, baseDelayMs: 1 });

    sender.enqueue(event("evt_http3", "po_1"));
    await idle(sender);

    expect(received.map((r) => r.path)).toEqual(["/v1/webhooks/payment-provider", "/v1/webhooks/payment-provider"]);
    expect(reports.at(-1)).toMatchObject({ status: "failed", attempts: 2, lastStatus: 302 });
  });

  it("gives up an attempt after the timeout and reports a TimeoutError", async () => {
    const { received, url } = await receiver(() => undefined); // never answers
    const { sender, reports, logger } = senderFor(url, { maxAttempts: 2, baseDelayMs: 1, timeoutMs: 40 });

    sender.enqueue(event("evt_http4", "po_1"));
    await idle(sender);

    expect(received).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({ status: "failed", attempts: 2, lastStatus: null, lastError: "TimeoutError" });
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "A webhook was given up after the last attempt" });
  });

  it("reports a refused connection by its code", async () => {
    const { url, port } = await receiver(() => undefined);
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(port).toBeGreaterThan(0);
    const { sender, reports } = senderFor(url, { maxAttempts: 1 });

    sender.enqueue(event("evt_http5", "po_1"));
    await idle(sender);

    expect(reports.at(-1)).toMatchObject({ status: "failed", attempts: 1, lastStatus: null, lastError: "ECONNREFUSED" });
  });

  it("delivers the events of one object in the order they were created, also when the first one needs a retry", async () => {
    const { received, url } = await receiver((_request, response, index) => void response.writeHead(index === 0 ? 503 : 200).end());
    const { sender } = senderFor(url);

    sender.enqueue(event("evt_a", "po_1"));
    sender.enqueue(event("evt_b", "po_1"));
    await idle(sender);

    expect(received.map((r) => (JSON.parse(r.rawBody) as { id: string }).id)).toEqual(["evt_a", "evt_a", "evt_b"]);
  });
});
