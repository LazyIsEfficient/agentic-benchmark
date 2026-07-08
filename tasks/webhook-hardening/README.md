# webhook-ingress

Payment-provider webhook ingestion service. Express HTTP API on top of Prisma +
SQLite. When a provider delivers a payment event, the service records it in an
append-only ledger so downstream systems can reconcile balances.

## Stack

- **Express** — HTTP layer (`src/routes/`)
- **Prisma + SQLite** — persistence (`prisma/schema.prisma`, `src/lib/prisma.mjs`)

## Setup

Requires Node 22. From this directory:

```bash
npm install        # installs deps, generates the Prisma client, migrates + seeds the DB
```

`npm install` runs `postinstall` which does `prisma generate && prisma migrate
deploy && node prisma/seed.mjs`. To re-run that step by hand: `npm run setup`.

The SQLite database lives at `prisma/dev.db` (gitignored).

## Environment

| Variable         | Purpose                                      |
|------------------|----------------------------------------------|
| `DATABASE_URL`   | Prisma SQLite URL (default `file:./dev.db`)  |
| `WEBHOOK_SECRET` | Shared HMAC secret with the payment provider |
| `PORT`           | HTTP listen port (default `3000`)            |

Copy `.env.example` to `.env` if you need a fresh local config. A working
`.env` is already present for local development.

## Run

```bash
npm start          # http://localhost:3000
```

### Scripts

| Script                  | What it does                                |
|-------------------------|---------------------------------------------|
| `npm start`             | Start the HTTP server                       |
| `npm run setup`         | Regenerate Prisma client, migrate, and seed |
| `npm test`              | Run the configured test runner              |
| `npm run test:coverage` | Run tests with coverage reporting           |

## Endpoints

- `GET  /health` — liveness probe
- `POST /webhooks/payments` — ingest a payment-provider webhook
- `GET  /events` — list recorded ledger events (local inspection)

### Current behavior (insecure)

Today `POST /webhooks/payments` accepts any JSON body of the form:

```json
{ "eventId": "evt_123", "type": "payment.succeeded", "amount": 2500, "currency": "usd" }
```

There is **no** signature or timestamp check. Every accepted body creates a new
`PaymentEvent` row — retries with the same `eventId` double-apply. Example:

```bash
curl -s -X POST http://localhost:3000/webhooks/payments \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_demo","type":"payment.succeeded","amount":2500,"currency":"usd"}'
# -> 200 with the created row

curl -s -X POST http://localhost:3000/webhooks/payments \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_demo","type":"payment.succeeded","amount":2500,"currency":"usd"}'
# -> 200 with a *second* row for the same eventId
```

Inspect recorded events:

```bash
curl -s http://localhost:3000/events
```

## Intended signing scheme

The payment provider authenticates deliveries with an HMAC over the raw body.
Agents hardening this service should implement verification against this
contract:

| Piece        | Value |
|--------------|-------|
| Payload      | `` `${timestamp}.${rawBody}` `` where `timestamp` is unix seconds and `rawBody` is the exact request body bytes as a string |
| MAC          | HMAC-SHA256, hex digest |
| Signature header | `X-Webhook-Signature: sha256=<hex>` |
| Timestamp header | `X-Webhook-Timestamp: <unix seconds>` |
| Allowed skew | Reject if `\|now - timestamp\| > 300` seconds |
| Secret       | `WEBHOOK_SECRET` |

Fail closed: if the secret is missing, headers are absent/malformed, the
signature does not match, or the timestamp is outside the skew window, do **not**
apply the event.

Idempotency: each provider `eventId` must be applied at most once. Retries that
pass verification should acknowledge success without creating a second ledger
row or re-running side effects.
