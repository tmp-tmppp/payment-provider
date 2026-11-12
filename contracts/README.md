# Contract of the mock payment provider

The contract is written first and the code follows it. `openapi.yaml` (OpenAPI 3.1) describes every HTTP route, the
webhook the provider sends and the error format; the tests fail when the routes and the file differ. This page is for
the authors of the **payments** service, the only caller.

| File | What it says |
|---|---|
| `openapi.yaml` | Every route of the provider (`/v1/...`, the payment page, the probes) and the webhook it sends |
| this page | How to call it, how to check a webhook, a worked test vector |

## What the provider does

A real provider's test mode, reduced to what Chance needs:

- **Deposit (FL-B).** payments creates a *checkout session* and gets the `url` of a payment page. The buyer opens it
  and presses **Pay** or **Decline**. The provider sends the webhook `checkout.session.completed` (or
  `.declined`, or `.expired` when nobody answered in time).
- **Withdrawal (FL-C).** payments creates a *payout*. After a short delay it is `paid`, or `failed` when the test mode
  asks for declined payouts. The provider sends `payout.paid` or `payout.failed`.
- **Failure on demand.** `PUT /v1/test-mode {"declinePayouts": true}` makes every payout that settles from then on
  fail, so the saga can be shown compensating.

## Calling the API

| Rule | Detail |
|---|---|
| Authentication | `Authorization: Bearer <API key>` on every `/v1` call; one merchant, one key (Secret `payment-provider-env`, key `PROVIDER_API_KEY`). A missing or wrong key is `401` with `WWW-Authenticate: Bearer`, also on a `/v1` path that does not exist (which is `404` with the key). |
| Idempotency | `POST /v1/checkout-sessions` and `POST /v1/payouts` need an `Idempotency-Key` (1 to 255 of `A-Z a-z 0-9 . _ : -`). The same key with the same body answers **`200`** with the object made the first time (in its state now); the same key with another body is **`409`** `idempotency_key_reused`; a missing or malformed key is `400`. Use the id of the deposit or withdrawal as the key, so a retry after a timeout can never pay twice. A key is remembered as long as its session or payout is kept. |
| Amounts | Integer cents, 1 to 1 000 000; currency `EUR`. |
| Metadata | Optional map of text, at most 10 entries, keys and values up to 200 characters. It comes back unchanged and is shown on the payment page. Put the ids you need to find your own record again in it (for example the deposit id and the tenant id), but nothing secret: the page shows it. |
| Return URLs | `successUrl` and `cancelUrl`: http or https, printable ASCII, no user name. After Pay the browser is sent to `successUrl`, after Decline to `cancelUrl`, both with status `303`. Neither URL is changed or extended. **payments must pass only its own fixed return URLs as `successUrl` and `cancelUrl`, never a URL that a user supplied**: the provider redirects the buyer's browser to them, so a URL taken from a request would be an open redirect. |
| Errors | `application/problem+json` (RFC 9457) with `type`, `title`, `status`, `detail`, `instance`, `code` and, for `400`, `errors: [{field, message}]`. Also problems: `413` for a JSON body over 16 KiB, `415` for a body that does not come with `Content-Type: application/json`, `400` for an id longer than 64 characters (on every route with an `{id}`, the payment page included: `/checkout/{id}`, `/checkout/{id}/pay` and `/checkout/{id}/decline` answer a problem for it, not the HTML page) and `414` for a path segment longer than 100 characters. The payment page answers HTML only for an unknown id (`404`) and a session that is not open (`409`). |
| Timeouts | Every route answers within milliseconds; the provider does no slow work while a request waits. Use a short timeout and retry with the same `Idempotency-Key`. |
| `503` | `capacity_exceeded` with `Retry-After: 60`: the provider holds as many sessions (or payouts) as it may and all are still open or pending. A real outage looks like a refused connection or a `503` from the gateway. |

### Session states

```
open --pay--> completed        open --decline--> declined        open --time is up--> expired
```

The three last states are final. `GET /v1/checkout-sessions/{id}` returns the state. A session whose `expiresAt` has
passed becomes `expired` the first time anyone reads it or opens its page, and in any case within a minute (a
sweep runs every minute); the event is sent then. `completed` and `declined` are decided by the buyer only.

### Payout states

```
pending --after PAYOUT_DELAY_MS--> paid       pending --after PAYOUT_DELAY_MS, test mode on--> failed (failureReason "declined")
```

The test mode is read when the payout settles, not when it is created.

### State is in memory

The provider forgets everything when it restarts: sessions, payouts, idempotency keys and events. A payment page of
a forgotten session shows "does not exist". That was decided on purpose (a stand-in for an external provider needs no
database), and it has consequences for payments:

- A deposit that stays `pending` for longer than the session lifetime (`CHECKOUT_TTL_MINUTES`, default 30) must be
  expired by payments itself; do not wait for an `expired` event that may never come.
- A payout whose `GET /v1/payouts/{id}` answers `404` after it was created is lost: treat it like a failed payout.
- The store is capped (10 000 sessions and 10 000 payouts by default). When it is full, the oldest *finished* one is
  dropped to make room; if none is finished the answer is `503 capacity_exceeded`.

## Webhooks

The provider POSTs every event to its setting `WEBHOOK_URL` (default
`http://payments:8080/v1/webhooks/payment-provider`). The path is public on payments (no user token); the signature is
the only proof of origin.

### The body is thin

```json
{"id":"evt_Zm9vYmFyZm9vYmFyZm9vYmFy","type":"checkout.session.completed","created":"2026-01-01T00:00:00.000Z","data":{"object":"checkout_session","id":"cs_YmF6cXV4YmF6cXV4YmF6cXV4"}}
```

| Field | Meaning |
|---|---|
| `id` | Event id, `evt_` and 24 characters. The same for every attempt to deliver the event. **Deduplicate by it.** |
| `type` | `checkout.session.completed`, `checkout.session.declined`, `checkout.session.expired`, `payout.paid`, `payout.failed` |
| `created` | When the event was made (ISO 8601, UTC) |
| `data.object` | `checkout_session` or `payout` |
| `data.id` | The id of that session or payout |

It says what happened and to which object, nothing more. Read the object back with `GET /v1/checkout-sessions/{id}`
or `GET /v1/payouts/{id}` and act on **that** state, never on the type of the event alone: this way a replayed,
reordered or forged event cannot change anything, and a forged one fails the signature anyway. The `metadata` you sent
when you created the object is in what you read back.

### The signature

Header: `Provider-Signature: t=<unix seconds>,v1=<hex>`

1. `t` is the time of the attempt in whole seconds since 1970 (UTC). Every retry has a fresh `t`.
2. `v1` is the lower-case hex of `HMAC-SHA256(key = WEBHOOK_SECRET, message = "<t>.<raw body>")`, where the message is `t`
   as decimal digits, a full stop, and the request body **exactly as received** (the bytes, not a parsed and
   re-serialized copy).
3. To verify: read the raw body, parse the header (`t` and every `v1`), compute the HMAC over `"<t>.<raw body>"`, compare it
   with each `v1` in constant time (`crypto.timingSafeEqual`), and refuse when none is equal. Also refuse when `|now - t|`
   is more than 300 seconds, so that an old capture cannot be replayed later. Answer `401` or `400`, not `2xx`.
4. The header may later carry more than one `v1` (a rotated secret is signed twice); accept the event if any matches.

#### Worked test vector

Use it to check your implementation before you connect to the provider. The secret is a made-up test value.

| Input | Value |
|---|---|
| `WEBHOOK_SECRET` | `test-vector-webhook-secret` |
| `t` | `1767225600` (2026-01-01T00:00:00Z) |
| raw body (182 bytes, no trailing newline) | `{"id":"evt_Zm9vYmFyZm9vYmFyZm9vYmFy","type":"checkout.session.completed","created":"2026-01-01T00:00:00.000Z","data":{"object":"checkout_session","id":"cs_YmF6cXV4YmF6cXV4YmF6cXV4"}}` |
| message that is signed | `1767225600.` followed by the raw body |
| `v1` | `9af47717a62148755f24884229bfac1ff872ad81e86e154946e61eb071c37ba9` |
| header | `t=1767225600,v1=9af47717a62148755f24884229bfac1ff872ad81e86e154946e61eb071c37ba9` |

Check it in a shell (the body is passed as it is, no trailing newline):

```bash
printf '%s' '1767225600.{"id":"evt_Zm9vYmFyZm9vYmFyZm9vYmFy","type":"checkout.session.completed","created":"2026-01-01T00:00:00.000Z","data":{"object":"checkout_session","id":"cs_YmF6cXV4YmF6cXV4YmF6cXV4"}}' \
  | openssl dgst -sha256 -hmac 'test-vector-webhook-secret' -hex
```

A receiver in TypeScript (`src/domain/signature.ts` of the provider has the same function, with a test against this table):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, header: string, rawBody: string, nowSeconds: number, tolerance = 300): boolean {
  const parts = header.split(",").map((part) => part.split("=", 2) as [string, string]);
  const t = parts.find(([key]) => key === "t")?.[1];
  if (!t || !/^\d{1,12}$/.test(t) || Math.abs(nowSeconds - Number(t)) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return parts.some(([key, value]) => key === "v1" && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, "hex"), expected));
}
```

### Delivery

| Rule | Detail |
|---|---|
| Success | Any `2xx` answer. Answer quickly (the provider waits 5 seconds); do the work after you have stored the event id. |
| Failure | Any other status, a network error, a timeout. Redirects are not followed and count as failures. |
| Retries | At most **8 attempts** in all, with a wait of 1 s after the first failure, then doubled each time: 1, 2, 4, 8, 16, 32, 64 seconds (about 2 minutes in all). After the last failed attempt the event is **given up** and an error is logged; it is not sent again. |
| Order | Events about the same session or payout are delivered one after the other, in the order they were created. Events about different objects may arrive in any order. |
| Duplicates | Delivery is at least once. Deduplicate by `id` (store it in the same transaction as your change). |
| Lost events | A restart of the provider drops events that were waiting for a retry. Reconcile pending deposits and withdrawals by reading the objects (`GET`), not by waiting for events only. |
| Debugging | `GET /v1/events/{id}` returns the event with `delivery: {status, attempts, lastStatus, lastError, lastAttemptAt, nextAttemptAt}`. |

## The payment page

`GET {url}` (the `url` of the session) is public: no API key. It shows the amount, the metadata and two buttons, and it
loads nothing from outside. The buttons are forms that post to `/checkout/{id}/pay` and `/checkout/{id}/decline`; the
answer is `303` to your `successUrl` or `cancelUrl`. A session that is not open (already completed, declined or
expired) shows a page that says so, with status `409`. `PUBLIC_BASE_URL` decides the host in `url`; set it to the
address the buyer's browser reaches the provider by (through the gateway, only the prefix `/checkout` is public).

## Settings

| Variable | Secret | Default | Meaning |
|---|---|---|---|
| `PROVIDER_API_KEY` | **yes** | none (`local` only: a local value) | The API key of the one merchant; at least 16 characters |
| `WEBHOOK_SECRET` | **yes** | none (`local` only: a local value) | Signs the webhooks; at least 16 characters |
| `WEBHOOK_URL` | no | `http://payments:8080/v1/webhooks/payment-provider` | Where events are POSTed (http or https, no query, no user name or password) |
| `PUBLIC_BASE_URL` | no | none (`local` only: `http://localhost:<PORT>`) | Public address of the payment pages (same rules as `WEBHOOK_URL`) |
| `CHECKOUT_TTL_MINUTES` | no | `30` | Lifetime of an open session |
| `PAYOUT_DELAY_MS` | no | `2000` | Time a payout stays pending |

The complete list is in the [README](../README.md#configuration).
