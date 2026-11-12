import { describe, expect, it } from "vitest";
import { ConfigError, LOCAL_API_KEY, LOCAL_WEBHOOK_SECRET, MAX_SHUTDOWN_DELAY_MS, MIN_SECRET_LENGTH, loadConfig } from "../src/config.js";

const SECRET_A = "a-long-enough-api-key-1234";
const SECRET_B = "a-long-enough-webhook-secret-5678";
const production = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  PROVIDER_API_KEY: SECRET_A,
  WEBHOOK_SECRET: SECRET_B,
  PUBLIC_BASE_URL: "https://pay.example.test",
  ...extra,
});
const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
};

describe("loadConfig", () => {
  it("accepts a production setting with the two secrets and the public address, and has the documented defaults", () => {
    expect(loadConfig(production())).toEqual({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      metricsPort: 9464,
      logLevel: "info",
      providerApiKey: SECRET_A,
      webhookSecret: SECRET_B,
      usesLocalSecrets: false,
      webhookUrl: "http://payments:8080/v1/webhooks/payment-provider",
      publicBaseUrl: "https://pay.example.test",
      checkoutTtlMinutes: 30,
      payoutDelayMs: 2000,
      storeCap: 10_000,
      shutdownDelayMs: 5000,
    });
  });

  it("lets only APP_ENV=local leave out the secrets and the public address, and uses local-only values then", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({
      isLocal: true,
      usesLocalSecrets: true,
      providerApiKey: LOCAL_API_KEY,
      webhookSecret: LOCAL_WEBHOOK_SECRET,
      publicBaseUrl: "http://localhost:8080",
      shutdownDelayMs: 0,
    });
    expect(loadConfig({ APP_ENV: "local", PORT: "18082" }).publicBaseUrl).toBe("http://localhost:18082");
    expect(loadConfig({ APP_ENV: "local", PROVIDER_API_KEY: "x", WEBHOOK_SECRET: "y" })).toMatchObject({ usesLocalSecrets: false, providerApiKey: "x", webhookSecret: "y" });
  });

  it("requires every secret and the public address in every other APP_ENV, and says which one is missing", () => {
    for (const appEnv of [undefined, "production", "dev", "staging"]) {
      const problems = problemsOf({ ...(appEnv ? { APP_ENV: appEnv } : {}) });
      expect(problems.join("\n"), String(appEnv)).toMatch(/PROVIDER_API_KEY is required/);
      expect(problems.join("\n")).toMatch(/WEBHOOK_SECRET is required/);
      expect(problems.join("\n")).toMatch(/PUBLIC_BASE_URL is required/);
      expect(problems.every((problem) => problem.includes("only APP_ENV=local may leave it out"))).toBe(true);
    }
    expect(problemsOf(production({ PROVIDER_API_KEY: undefined }))).toEqual([expect.stringMatching(/^PROVIDER_API_KEY is required/)]);
    expect(problemsOf(production({ WEBHOOK_SECRET: "  " }))).toEqual([expect.stringMatching(/^WEBHOOK_SECRET is required/)]);
    expect(problemsOf(production({ PUBLIC_BASE_URL: undefined }))).toEqual([expect.stringMatching(/^PUBLIC_BASE_URL is required/)]);
  });

  it("refuses short secrets and the local development values outside APP_ENV=local", () => {
    expect(MIN_SECRET_LENGTH).toBe(16);
    expect(problemsOf(production({ PROVIDER_API_KEY: "short" }))).toEqual(["PROVIDER_API_KEY must have at least 16 characters"]);
    expect(problemsOf(production({ WEBHOOK_SECRET: "x".repeat(15) }))).toEqual(["WEBHOOK_SECRET must have at least 16 characters"]);
    expect(problemsOf(production({ PROVIDER_API_KEY: LOCAL_API_KEY }))).toEqual(["PROVIDER_API_KEY must not be the local development value"]);
    expect(problemsOf(production({ WEBHOOK_SECRET: LOCAL_WEBHOOK_SECRET }))).toEqual(["WEBHOOK_SECRET must not be the local development value"]);
    expect(problemsOf({ APP_ENV: "local", PROVIDER_API_KEY: LOCAL_API_KEY, WEBHOOK_SECRET: LOCAL_WEBHOOK_SECRET })).toEqual([]);
  });

  it("validates the URLs, and cuts the trailing slash of the public address", () => {
    expect(loadConfig(production({ PUBLIC_BASE_URL: "https://pay.example.test/provider/" })).publicBaseUrl).toBe("https://pay.example.test/provider");
    expect(loadConfig(production({ WEBHOOK_URL: "http://payments.other:9000/hook" })).webhookUrl).toBe("http://payments.other:9000/hook");
    for (const bad of ["ftp://x.example", "not a url", "javascript:alert(1)", "https://x.example/?a=1", "https://x.example/#top"]) {
      expect(problemsOf(production({ PUBLIC_BASE_URL: bad })), bad).toEqual(["PUBLIC_BASE_URL must be an http or https URL without a query or a fragment"]);
      expect(problemsOf(production({ WEBHOOK_URL: bad })), bad).toEqual(["WEBHOOK_URL must be an http or https URL without a query or a fragment"]);
    }
  });

  it("refuses a URL that carries a user name or a password, and never prints it", () => {
    for (const bad of ["https://user:pw-leaked@x.example/hook", "https://user@x.example/hook", "http://:pw-leaked@x.example", "http://payments:8080@evil.example/"]) {
      expect(problemsOf(production({ PUBLIC_BASE_URL: bad })), bad).toEqual(["PUBLIC_BASE_URL must not contain a user name or a password"]);
      expect(problemsOf(production({ WEBHOOK_URL: bad })), bad).toEqual(["WEBHOOK_URL must not contain a user name or a password"]);
    }
    let message = "";
    try {
      loadConfig(production({ WEBHOOK_URL: "https://hook-user:pw-leaked@x.example/hook" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("WEBHOOK_URL");
    expect(message).not.toMatch(/pw-leaked|hook-user/);
    // The local run may not smuggle one in either, and a plain address with a port still passes.
    expect(problemsOf({ APP_ENV: "local", WEBHOOK_URL: "http://user:pw@payments:8080/hook" })).toEqual(["WEBHOOK_URL must not contain a user name or a password"]);
    expect(problemsOf(production({ WEBHOOK_URL: "http://payments:8080/v1/webhooks/payment-provider", PUBLIC_BASE_URL: "https://pay.example.test:8443/p" }))).toEqual([]);
  });

  it("reads the numbers and rejects what is out of range or not a whole number", () => {
    const config = loadConfig(production({ PORT: "9090", CHECKOUT_TTL_MINUTES: "5", PAYOUT_DELAY_MS: "0", STORE_CAP: "50", SHUTDOWN_DELAY_MS: "1000", LOG_LEVEL: "debug" }));
    expect(config).toMatchObject({ port: 9090, checkoutTtlMinutes: 5, payoutDelayMs: 0, storeCap: 50, shutdownDelayMs: 1000, logLevel: "debug" });
    for (const [name, value] of [["PORT", "0"], ["PORT", "70000"], ["PORT", "80.5"], ["PORT", "abc"], ["CHECKOUT_TTL_MINUTES", "0"], ["CHECKOUT_TTL_MINUTES", "1441"], ["PAYOUT_DELAY_MS", "-1"], ["STORE_CAP", "9"], ["SHUTDOWN_DELAY_MS", String(MAX_SHUTDOWN_DELAY_MS + 1)]] as const) {
      expect(problemsOf(production({ [name]: value })), `${name}=${value}`).toEqual([expect.stringContaining(`${name} must be an integer`)]);
    }
  });

  describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
    it("defaults to 9464, also in local mode", () => {
      expect(loadConfig(production()).metricsPort).toBe(9464);
      expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    });

    it("takes a port from 1 to 65535", () => {
      expect(loadConfig(production({ METRICS_PORT: "9100" })).metricsPort).toBe(9100);
      expect(loadConfig(production({ METRICS_PORT: "1" })).metricsPort).toBe(1);
      expect(loadConfig(production({ METRICS_PORT: "65535" })).metricsPort).toBe(65_535);
    });

    it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
      expect(problemsOf(production({ METRICS_PORT: value }))).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
    });

    it("must differ from PORT: the API port never serves /metrics", () => {
      const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
      expect(problemsOf(production({ PORT: "9000", METRICS_PORT: "9000" }))).toEqual([problem]);
      expect(problemsOf(production({ PORT: "9464" }))).toEqual([problem]);
      expect(loadConfig(production({ PORT: "9464", METRICS_PORT: "9465" }))).toMatchObject({ port: 9464, metricsPort: 9465 });
    });
  });

  it("rejects an unknown log level and a malformed APP_ENV", () => {
    expect(problemsOf(production({ LOG_LEVEL: "loud" }))).toEqual([expect.stringContaining("LOG_LEVEL must be one of")]);
    expect(problemsOf(production({ APP_ENV: "Prod Env" }))).toEqual(["APP_ENV must be lowercase letters, digits and dashes"]);
  });

  it("names every problem at once and never prints a value", () => {
    const env = { APP_ENV: "production", PROVIDER_API_KEY: "tiny-secret-1", WEBHOOK_SECRET: "tiny-secret-2", PUBLIC_BASE_URL: "ftp://leaked.example", PORT: "nope" };
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid configuration:/);
    for (const name of ["PROVIDER_API_KEY", "WEBHOOK_SECRET", "PUBLIC_BASE_URL", "PORT"]) expect(message).toContain(name);
    for (const value of ["tiny-secret-1", "tiny-secret-2", "leaked.example", "nope"]) expect(message).not.toContain(value);
  });

  it("trims the values", () => {
    expect(loadConfig(production({ PROVIDER_API_KEY: `  ${SECRET_A}\n` })).providerApiKey).toBe(SECRET_A);
  });
});
