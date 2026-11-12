import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tenantOfRequest } from "../../src/web/auth.js";

// src/main.ts is the composition root and is excluded from coverage, so no other test runs it. These checks pin the
// lines of the metrics convention that only it holds: the tenant label does not come from the request, the listener
// has its own port, and it closes with the service.

const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

describe("tenantOfRequest, the tenant label of the metrics", () => {
  it('is always null ("none"): the provider has one API key for one merchant and no verified tenant', () => {
    expect(tenantOfRequest()).toBeNull();
  });
});

describe("the metrics wiring of src/main.ts", () => {
  it("takes the tenant label from tenantOfRequest", () => {
    expect(main).toContain("createMetrics({ tenantOf: tenantOfRequest })");
  });

  it("serves the metrics on their own port and closes that listener on shutdown", () => {
    expect(main).toContain("startMetricsServer(metrics.registry, { port: config.metricsPort })");
    expect(main).toContain("await metricsServer.close()");
  });
});
