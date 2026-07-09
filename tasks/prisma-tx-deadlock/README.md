# checkout-service

Order checkout & payment-capture service. Express HTTP API on top of Prisma +
SQLite. When an order is charged, the service calls the external payment
processor and records the money movement in an append-only ledger.

## Stack

- **Express** — HTTP layer (`src/routes/`)
- **Prisma + SQLite** — persistence (`prisma/schema.prisma`, `src/lib/prisma.mjs`)
- **paymentClient** — wrapper around the external payment processor
  (`src/paymentClient.mjs`); the network call is simulated locally so the
  service runs offline

## Setup

Requires Node 22. From this directory:

```bash
npm install        # installs deps, generates the Prisma client, migrates + seeds the DB
```

`npm install` runs `postinstall` which does `prisma generate && prisma migrate
deploy && node prisma/seed.mjs`. To re-run that step by hand: `npm run setup`.

The SQLite database lives at `prisma/dev.db` (gitignored).

## Run

```bash
npm start          # http://localhost:3000
```

Charge an order:

```bash
curl -X POST http://localhost:3000/orders/seed-order-0001/charge
# -> { "orderId": "...", "status": "charged", "receiptId": "...", "ledgerId": "..." }
```

Endpoints:

- `GET  /health`
- `POST /orders/:id/charge` — capture payment for an order

### Scripts

| Script                  | What it does                                |
|-------------------------|---------------------------------------------|
| `npm start`             | Start the HTTP server                       |
| `npm run setup`         | Regenerate Prisma client, migrate, and seed |
| `npm run load-test`     | Fire concurrent charges (load/concurrency check) |
| `npm test`              | Run the configured test runner              |
| `npm run test:coverage` | Run tests with coverage reporting           |

## Load / concurrency check

`scripts/load-test.mjs` boots the app in-process, seeds a fresh batch of pending
orders, and fires many charge requests **simultaneously** — the way a traffic
spike hits the service — then prints a success/failure breakdown:

```bash
npm run load-test              # default: 30 concurrent charges
CONCURRENCY=40 npm run load-test
```
