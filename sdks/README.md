# WhitePay SDKs

The six primary SDKs from the project doc, each built on the same contract, [`public/openapi.json`](../public/openapi.json) (served at `/openapi.json`). None of them has runtime dependencies.

| Language | Path | Runtime | Tested here |
|---|---|---|---|
| TypeScript / Node | [`typescript/`](typescript/) | Node 18+ (fetch) | ✅ webhook vectors + live API |
| Python | [`python/`](python/) | 3.8+ (stdlib) | ✅ webhook vectors + live API |
| Go | [`go/`](go/) | 1.21+ (stdlib) | ✅ `go vet`, webhook vectors + live API |
| Ruby | [`ruby/`](ruby/) | 2.6+ (stdlib) | ✅ webhook vectors + live API |
| Java | [`java/`](java/) | 17+ (`java.net.http`) | ✅ `javac -Werror`, webhook vectors + live API |
| PHP | [`php/`](php/) | 8.1+ (curl, json) | ⚠️ **written, not run**: PHP isn't installed on the build machine. Run `php tests/run.php`. |

Every SDK provides:

- **Payments:** `create` (with optional Idempotency-Key), `get`, `list` with cursor pagination, and `requote`.
- **Invoices:** `create`, `get`, `list`, `pay` (full or partial), `void`, `remind` and `aging`.
- **Operations:** refund requests, subscriptions, exceptions, webhook deliveries and replay, ledger, `reconcile` and `status`.
- **Webhook verification:** checks the raw body and a ±5-minute timestamp window, uses a constant-time compare, and accepts any matching `v1` signature, so you can rotate secrets.
- **Safe retries:** network errors, 429 and 5xx are retried with backoff. Every POST carries an Idempotency-Key, so a retry can never create a second payment.
- **Typed errors:** each SDK has an error type with `status` and a stable `code`, such as `unauthorized`, `not_found`, `invalid_amount` or `invalid_signature`.

## Run all SDK tests

```bash
npm run demo                                         # in one terminal (local chain + API)
WHITEPAY_BASE_URL=http://localhost:3000/api/v1 sdks/test-all.sh
```

All SDKs verify webhooks against the shared cases in [`testdata/webhook-vectors.json`](testdata/webhook-vectors.json): valid, rotated secret, tampered body, wrong secret, too old, from the future, missing timestamp and garbage header. This keeps the six languages behaving identically.

## Quick start

```ts
// TypeScript
import { WhitePay, verifyWebhook } from "@whitepay/sdk";
const wp = new WhitePay(process.env.WHITEPAY_API_KEY!, { baseUrl: "https://pay.example.com/api/v1" });
const p = await wp.payments.create({ amount: 49, currency: "INR", orderRef: "order_123", policy: "auto" });
// redirect the customer to p.checkoutUrl; fulfil on the payment.fulfillable webhook:
const event = verifyWebhook(rawBody, req.headers["x-whitepay-signature"], process.env.WHITEPAY_WEBHOOK_SECRET!);
```

```python
# Python
from whitepay import WhitePay, verify_webhook
wp = WhitePay(os.environ["WHITEPAY_API_KEY"], base_url="https://pay.example.com/api/v1")
inv = wp.invoices.create("Acme Pvt Ltd", [{"description": "Design sprint", "unitPrice": 1200, "taxPercent": 18}], currency="INR", terms="net_15")
```

```go
// Go
wp := whitepay.New(os.Getenv("WHITEPAY_API_KEY"))
p, err := wp.CreatePayment(ctx, whitepay.CreatePaymentParams{Amount: 49, Currency: "USD", OrderRef: "order_123"}, "")
```

## Not built yet (from the doc's language list)

- **Additional SDKs:** C#/.NET, Rust and Elixir. `cargo` is available here, so Rust is the easiest to add next.
- **Mobile SDKs:** Swift, Kotlin, React Native and Flutter.
- **Other interfaces:** GraphQL, and a CLI with local webhook forwarding.
- **Packages:** none of these SDKs is published to npm, PyPI, crates.io, RubyGems, Maven Central or Packagist yet.

## Newer endpoints
Every SDK also wraps: credit notes, recurring invoices (create, list, pause, resume, cancel), JSON statements, accounting periods (list, close, reopen), the read-only auditor key, seat and usage meters (`get`, `reportUsage` with an idempotent report id), agent spending-policy lookups, and the local-chain test clock. Excel, PDF, CSV and Xero/QuickBooks files are downloaded from `GET /statements?format=…` (use the CLI or plain HTTP); the SDKs return the JSON statement.
Live tests for these run with the rest (`WHITEPAY_BASE_URL=… sdks/test-all.sh`). The PHP additions mirror the others but have not been executed (no PHP runtime here).
