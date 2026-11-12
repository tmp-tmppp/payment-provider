import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { createHarness, payoutBody, sessionBody } from "../support/harness.js";

// The metrics wired into the real application the way src/main.ts wires them. This service has one API key for one
// merchant: the tenant label is always "none", whatever tenantId a body names in its metadata. The convention itself
// is tested in tests/adapters/metrics.test.ts.

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

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the real application", () => {
  it('counts a call with the API key under the template of its route and the tenant "none", never the tenantId of its metadata', async () => {
    const created = await h.createSession("metrics-1", sessionBody({ metadata: { depositId: "dep-9", tenantId: "tenant-from-the-body" } }));
    expect(created.statusCode).toBe(201);
    expect(await counter({ method: "POST", route: "/v1/checkout-sessions", status_code: "201", tenant: "none" })).toBe(1);
    expect(await counter({ tenant: "tenant-from-the-body" })).toBe(0);
    expect(await metrics.registry.metrics()).not.toContain("tenant-from-the-body");
  });

  it("uses the template of a route with an id, never the id", async () => {
    const created = await h.createSession("metrics-2");
    const id = created.json<{ id: string }>().id;
    const found = await h.api("GET", `/v1/checkout-sessions/${id}`);
    expect(found.statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/checkout-sessions/:id", status_code: "200", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(id);

    const payout = await h.createPayout("metrics-3");
    const payoutId = payout.json<{ id: string }>().id;
    expect((await h.api("GET", `/v1/payouts/${payoutId}`)).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/payouts/:id", status_code: "200", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(payoutId);
  });

  it("counts a wrong or missing API key as 401 on the route that was asked", async () => {
    const wrong = await h.call({ method: "POST", url: "/v1/payouts", headers: { authorization: "Bearer not-the-key" }, payload: payoutBody() });
    const missing = await h.call({ method: "GET", url: "/v1/test-mode" });
    expect([wrong.statusCode, missing.statusCode]).toEqual([401, 401]);
    expect(await counter({ method: "POST", route: "/v1/payouts", status_code: "401", tenant: "none" })).toBe(1);
    expect(await counter({ method: "GET", route: "/v1/test-mode", status_code: "401", tenant: "none" })).toBe(1);
  });

  it('counts a path under /v1 that matches no route as "unmatched": 404 with the key, 401 without it', async () => {
    expect((await h.api("GET", "/v1/no/such/secret-path-1")).statusCode).toBe(404);
    expect((await h.call({ method: "GET", url: "/v1/no/such/secret-path-2?query=secret-path-3" })).statusCode).toBe(401);
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
    expect(await counter({ method: "GET", route: "unmatched", status_code: "401", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toMatch(/secret-path/);
  });

  it("counts the probes under their own routes", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/health/live", status_code: "200", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the answer is a 404 counted as "unmatched"', async () => {
    const before = await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" });
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(before + 1);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await plain.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await plain.app.close();
  });
});
