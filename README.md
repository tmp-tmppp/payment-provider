# payment-provider

The mock payment provider of **Chance**: a small app that stands in for an external payment provider (ADR-010,
requirement 9). The payments service calls it with an API key and receives its signed webhooks, as it would with a
real provider's test mode. It lives outside Chance's services: its own repository, its own Helm release, its own
state, and it knows nothing about tenants, users or credits.

| What the payments service does | What the provider offers |
|---|---|
| Deposit (FL-B): asks for a checkout session, sends the buyer to its page | `POST /v1/checkout-sessions`, the payment page `/checkout/{id}` with the buttons Pay and Decline |
| Withdrawal (FL-C): sends the payout | `POST /v1/payouts`, paid or failed after a short delay |
| Learns the result | A signed, thin webhook (`checkout.session.completed`, `.declined`, `.expired`, `payout.paid`, `payout.failed`), then it reads the object through the API |
| Shows the saga compensating | `PUT /v1/test-mode {"declinePayouts": true}` makes payouts fail on purpose |

## API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml) (OpenAPI 3.1), and for the authors of payments
[`contracts/README.md`](contracts/README.md): the rules of the API, the webhook signature scheme with a worked test
vector, delivery and retries. In short:

- Every `/v1` call needs `Authorization: Bearer <PROVIDER_API_KEY>` (one merchant; compared in constant time). The
  payment page is public.
- `POST /v1/checkout-sessions` and `POST /v1/payouts` need an `Idempotency-Key`: the same key and body return the same
  object (`200`), the same key with another body is `409`.
- Amounts are integer cents (1 to 1 000 000), currency `EUR`. Errors are RFC 9457 `application/problem+json`.
- Webhooks go to `WEBHOOK_URL` with `Provider-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
  A failed delivery is retried with exponential backoff (1 s, doubling, 8 attempts in all), then given up and logged as
  an error. Events about one session or payout are delivered in order.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message when a required one is
missing or invalid, and never prints a value. In Kubernetes the non-secret ones come from the chart's ConfigMap and the
secret ones from the Secret `payment-provider-env` (organization secret `PAYMENT_PROVIDER_ENV`).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | `local` lets the two secrets and `PUBLIC_BASE_URL` fall back to local-only values; every other value requires them |
| `PORT` | `8080` | no | HTTP port |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `PROVIDER_API_KEY` | required | **yes** | The key payments sends as a bearer token; at least 16 characters (outside `local`) |
| `WEBHOOK_SECRET` | required | **yes** | Signs the webhooks; at least 16 characters (outside `local`) |
| `WEBHOOK_URL` | `http://payments:8080/v1/webhooks/payment-provider` | no | Where the events are POSTed (http or https, no query, no user name or password) |
| `PUBLIC_BASE_URL` | required (`http://localhost:<PORT>` when `local`) | no | The address of the payment pages as the buyer's browser reaches it (through the gateway); the `url` of a session starts with it (http or https, no query, no user name or password) |
| `CHECKOUT_TTL_MINUTES` | `30` | no | Lifetime of an open session, 1 to 1440 |
| `PAYOUT_DELAY_MS` | `2000` | no | Time a payout stays pending before it is paid or declined, 0 to 3 600 000 |
| `STORE_CAP` | `10000` | no | How many sessions and how many payouts the in-memory store keeps at most, 10 to 1 000 000 |
| `SHUTDOWN_DELAY_MS` | `5000` (`0` when `local`) | no | Drain delay after SIGTERM, 0 to 15000 (see "Shutdown") |

The API key, the webhook secret and the signatures are never logged; the logger also redacts the `Authorization`
header and fields called `apiKey`, `secret` and `signature` as a second lock (`src/logger.ts`, tested).

## State is in memory

Decision of the team: the provider keeps sessions, payouts, idempotency keys and events in memory (a port with an
in-memory adapter, `src/adapters/memory`), because a stand-in for an external provider needs no database and no
migration. What follows from it:

- **A restart forgets everything.** An open payment page then shows "does not exist", `GET` answers `404`, a pending
  payout never settles, and events that waited for a retry are lost. The payments service expires its own pending
  deposits and treats a vanished payout as failed; this is written down for its authors in `contracts/README.md`.
- **Exactly one replica**, with the `Recreate` update strategy (the schema of the chart allows at most 1).
- **The store is bounded.** With `STORE_CAP` sessions (or payouts) stored, a new one drops the oldest *finished* one, with
  its idempotency key and its events. When all are still open or pending, the answer is `503 capacity_exceeded` with
  `Retry-After`. Events live and die with their session or payout, so memory is bounded by the same cap
  (measured: a full store of 10 000 sessions, 10 000 payouts and their 20 000 events takes about 23 MiB of heap).
- A session that nobody opens expires within a minute after its time is up (a sweep every minute); one that somebody
  opens or reads expires on the spot. Either way the event is sent once.

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module
is [`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). The default is the same in every service, so
  services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own
  address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/checkout-sessions/:id`), or `unmatched` for a request that matched no route
  (a 404, or the 401 of a path under `/v1` sent without the key), so a raw URL or an id never becomes a label value.
- **`tenant`** is always `none`: the service has one API key for one merchant and no verified tenant, and the
  `tenantId` in the metadata of a session is the caller's own claim, never a label value.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Shutdown

On SIGTERM (Kubernetes) or SIGINT the service first answers `503` on `/health/ready` and keeps serving for
`SHUTDOWN_DELAY_MS`, so the load balancer stops sending requests; then it stops accepting connections, finishes the
requests in flight, closes the metrics listener, stops the sweep and the payout timers and the webhook sender (waiting retries are dropped, an
attempt in flight finishes, and when it fails it is not repeated). A second signal changes nothing. A timer ends the process with exit code 1 when all that takes more than the delay plus
10 seconds. The sequence is in `src/shutdown.ts` and is tested with fake timers.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local PORT=8082 npm start     # local key and secret, webhooks to the payments service at its default address
```

A short session (the local values are `provider-local-api-key` and `provider-local-webhook-secret`; set `WEBHOOK_URL`
to a listener of yours to see the events):

```bash
KEY=provider-local-api-key; B=http://localhost:8082
curl -s -X POST $B/v1/checkout-sessions -H "Authorization: Bearer $KEY" -H "Idempotency-Key: demo-1" \
  -H "Content-Type: application/json" \
  -d '{"amount":1250,"currency":"EUR","metadata":{"depositId":"dep-1"},"successUrl":"http://localhost:5173/done","cancelUrl":"http://localhost:5173/cancel"}'
# open the "url" of the answer in a browser and press Pay, or:  curl -i -X POST $B/checkout/<id>/pay
curl -s $B/v1/checkout-sessions/<id> -H "Authorization: Bearer $KEY"       # status "completed"
curl -s -X PUT $B/v1/test-mode -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"declinePayouts":true}'
```

With Docker: `docker compose up -d --build` starts it at `http://localhost:8082` with the same local values
([`compose.yaml`](compose.yaml); change `WEBHOOK_URL` to the address of your payments service).

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # every test; npm test -- --coverage for the coverage report (80 % gate)
```

No test needs the network or Docker: the webhook tests talk to a receiver that the test starts on a free localhost
port. They cover, among others:

| File | What it checks |
|---|---|
| `tests/domain.test.ts` | Input rules, session and payout state changes, expiry, the signature against the documented test vector (and that `contracts/README.md` shows that very vector) |
| `tests/usecases` | Idempotency (same and different body, two requests at once), expiry on access and by the sweep, the caps |
| `tests/web` | `401`, `404`, `409`, validation `400`, `415`, `413`, `503`; the payment page escapes every value, its CSP, the `303` redirects, the expired page |
| `tests/adapters` | The webhook sender over HTTP (signature, retries, give-up, order, timeouts, no redirect) and with fake timers (the backoff steps 1, 2, 4 ... 64 s), the store caps, the timers |
| `tests/contracts` | Every route of `contracts/openapi.yaml` and back, every answer matches its schema, the documented limits equal the code's |
| `tests/flows.test.ts` | FL-B and FL-C from the side of payments, against the provider as `main.ts` wires it |
| `tests/logging.test.ts` | A whole payment leaves no key, secret, signature or full session id in the log (requests log `/checkout/:id`) |

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | Sessions, payouts, events, the signature function, input rules; no I/O | nothing outside the domain (the Node.js standard library for `crypto`) |
| `src/usecases` | One class per use case, the ports (interfaces) | the domain |
| `src/adapters` | The in-memory store, the webhook sender (with its fetch port), the timers, ids and clock, the metrics (`src/adapters/metrics/`) | use cases and domain |
| `src/web` | Fastify routes, API key check, the payment page, problem details | use cases and domain |
| `src/config.ts`, `src/main.ts` | Validated configuration; the composition root | everything |
| `src/shutdown.ts` | The shutdown sequence; its steps are passed in, so it is tested with fake timers | the logger port |
| `helm` | Chart with dev and prod values, a NetworkPolicy (off by default) and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one.

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds the
image once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test and an
automatic rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml). The gateway routes only the prefix `/checkout` to this
service; the API is for the payments pods alone (the NetworkPolicy, once enabled, admits the gateway and the payments
pods), and every API call needs the key.

`PUBLIC_BASE_URL` in `helm/values-prod.yaml` is empty on purpose: its value, `https://<public host>`, comes from the
pipeline's public host (plan INF-01). A deploy without it stops at start with "PUBLIC_BASE_URL is required" (the Pod
restarts and the deploy rolls back) instead of handing out checkout links that point at localhost.

## Known limitations

- Everything is forgotten on a restart (see "State is in memory").
- One merchant, one key, one currency; no refunds, no 3-D Secure, no real card data: the payment page is a button.
- The payment page is public: whoever has the link (an id of 144 random bits) can pay or decline that one session.
- Delivery is at least once and in order per object only; the receiver must deduplicate by event id.

## Implementation notes

Traps found while building this service; each is handled in the code named here.

- **Fastify's default Ajv coerces types and drops unknown fields** (`coerceTypes: "array"`, `removeAdditional: true`): for money set `coerceTypes: false` (else `"1250"` passes as an integer) and `removeAdditional: false` (unknown fields are a 400) (`src/web/app.ts`).
- **Fastify has a built-in `text/plain` parser**, so a `text/plain` POST to a JSON route is a 400, not a 415; test the 415 with `application/xml`.
- **Fastify decodes `%`-escapes before it matches a route** (`/%76%31/test-mode` reaches `/v1/test-mode`): the API-key hook checks the matched route, not the raw URL (`src/web/app.ts`, `src/web/auth.ts`).
- **A path segment over `maxParamLength` (100) is a 414 before any schema runs**; 65 to 100 characters is the schema's 400. Both are in the contract.
- **With `loggerInstance`, Fastify merges the logger's serializers over its own**: the `req` serializer in `src/logger.ts` replaces the default one (it redacts the page's session ids) and must accept a request without `url`.
- **pino redaction needs bracket paths for hyphenated keys** (`headers["provider-signature"]`); a dot path with a hyphen throws when the logger is created.
- **Chrome applies the CSP `form-action` to the redirect after a form post** (Firefox does not): the page also allows the origins of `successUrl` and `cancelUrl` (`src/web/checkout-page.ts`).
- **Vitest fake timers and `stop()`**: start `stop()` first, then `advanceTimersByTimeAsync`, then await it, or a faked sleep inside the in-flight run hangs the test.
- **A failed attempt after `stop()` must not sleep again**: the sender checks `stopped` before its backoff (`src/adapters/webhooks/webhook-sender.ts`).
- **Measured memory**: a full store (10 000 sessions, 10 000 payouts, 20 000 events and keys) is about 23 MiB of heap; the 192 Mi limit has room.
