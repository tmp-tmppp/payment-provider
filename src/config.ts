// Typed configuration from environment variables, validated once at startup. A bad or missing setting stops the
// start with a message that names every problem; values are never printed (they may be secrets).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export interface Config {
  /** "local" allows local-only values for the secrets; any other value (default "production") requires them. */
  appEnv: string;
  isLocal: boolean;
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the API port. */
  metricsPort: number;
  logLevel: string;
  /** Every /v1 call must carry it as "Authorization: Bearer <key>". */
  providerApiKey: string;
  /** Signs the webhooks. */
  webhookSecret: string;
  /** True when a local-only value was used for the API key or the webhook secret (APP_ENV=local only). */
  usesLocalSecrets: boolean;
  /** Where the events are POSTed. */
  webhookUrl: string;
  /** Where the payment pages are reachable from outside, without a trailing slash. */
  publicBaseUrl: string;
  checkoutTtlMinutes: number;
  /** How long a payout stays pending before it is paid (or declined). */
  payoutDelayMs: number;
  /** How many sessions and how many payouts the in-memory store keeps at most. */
  storeCap: number;
  /**
   * After SIGTERM the service first answers 503 on the readiness probe and keeps serving for this long, so that the
   * load balancer and the endpoints stop sending requests; only then does it close the server and the background jobs.
   */
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;

/** The shortest secret that a setting other than APP_ENV=local accepts. */
export const MIN_SECRET_LENGTH = 16;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// Values for APP_ENV=local only; every other APP_ENV refuses them. They match compose.yaml and the README.
export const LOCAL_API_KEY = "provider-local-api-key"; // hooks:allow local development only
export const LOCAL_WEBHOOK_SECRET = "provider-local-webhook-secret"; // hooks:allow local development only

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const url = (name: string, value: string): string => {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.search === "" && parsed.hash === "") {
        // A user name or password in a URL would end up in logs, in the "url" of every session and in a redirect.
        if (parsed.username !== "" || parsed.password !== "") problems.push(`${name} must not contain a user name or a password`);
        return value;
      }
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be an http or https URL without a query or a fragment`);
    return value;
  };

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";

  const logLevel = text("LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The API port never serves /metrics (so the gateway can never route it): the two listeners need two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  let usesLocalSecrets = false;
  const secret = (name: string, local: string, hint: string): string => {
    const value = text(name);
    if (value === undefined) {
      if (isLocal) {
        usesLocalSecrets = true;
        return local;
      }
      problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
      return local;
    }
    if (!isLocal && value.length < MIN_SECRET_LENGTH) problems.push(`${name} must have at least ${MIN_SECRET_LENGTH} characters`);
    if (!isLocal && value === local) problems.push(`${name} must not be the local development value`);
    return value;
  };
  const providerApiKey = secret("PROVIDER_API_KEY", LOCAL_API_KEY, "the key the payments service sends as a bearer token");
  const webhookSecret = secret("WEBHOOK_SECRET", LOCAL_WEBHOOK_SECRET, "the secret that signs the webhooks");

  const webhookUrl = url("WEBHOOK_URL", text("WEBHOOK_URL") ?? "http://payments:8080/v1/webhooks/payment-provider");

  let publicBaseUrl = text("PUBLIC_BASE_URL");
  if (publicBaseUrl === undefined) {
    if (!isLocal) problems.push("PUBLIC_BASE_URL is required (where the payment pages are reachable from outside); only APP_ENV=local may leave it out");
    publicBaseUrl = `http://localhost:${port}`;
  } else {
    publicBaseUrl = url("PUBLIC_BASE_URL", publicBaseUrl).replace(/\/+$/, "");
  }

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel,
    providerApiKey,
    webhookSecret,
    usesLocalSecrets,
    webhookUrl,
    publicBaseUrl,
    checkoutTtlMinutes: integer("CHECKOUT_TTL_MINUTES", 30, 1, 1440),
    payoutDelayMs: integer("PAYOUT_DELAY_MS", 2000, 0, 3_600_000),
    storeCap: integer("STORE_CAP", 10_000, 10, 1_000_000),
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
