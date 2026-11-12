import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { createHarness } from "../support/harness.js";

// Fastify answers a URL it cannot route (a malformed percent-encoding) through its frameworkErrors handler, on a
// request that carries none of the application's hooks. Those answers are still counted: a burst of them must show on
// the request-rate and status panels, as route "unmatched". This service has one API key for one merchant, so the
// tenant label is "none" for every answer, routed or not.

type Harness = Awaited<ReturnType<typeof createHarness>>;

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
});
afterAll(async () => {
  await h.app.close();
});

async function sampleSum(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name.replace(/_count$/, ""));
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => ((sample as { metricName?: string }).metricName ?? name) === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the answers Fastify gives before a route matches", () => {
  it("counts a malformed URL as a 400 on the route unmatched, for the tenant none, and observes its duration", async () => {
    const answer = await h.api("GET", "/v1/checkout-sessions/%E0%A4%A");
    expect(answer.statusCode).toBe(400);
    const labels = { method: "GET", route: "unmatched", status_code: "400", tenant: "none" };
    expect(await sampleSum("http_requests_total", labels)).toBe(1);
    expect(await sampleSum("http_request_duration_seconds_count", labels)).toBe(1);
  });

  it("does not count a framework error twice, and leaves the counting of routed requests alone", async () => {
    const routed = async () => sampleSum("http_requests_total", { method: "GET", route: "/v1/checkout-sessions/:id", status_code: "404", tenant: "none" });
    const unmatchedBefore = await sampleSum("http_requests_total", { method: "GET", route: "unmatched", status_code: "400", tenant: "none" });
    expect((await h.api("GET", "/v1/checkout-sessions/session-id-from-the-url")).statusCode).toBe(404);
    const routedBefore = (await routed()) - 1;
    expect((await h.api("GET", "/v1/checkout-sessions/%E0%A4%A")).statusCode).toBe(400);
    expect(await routed()).toBe(routedBefore + 1);
    expect(await sampleSum("http_requests_total", { method: "GET", route: "unmatched", status_code: "400", tenant: "none" })).toBe(unmatchedBefore + 1);
  });
});
