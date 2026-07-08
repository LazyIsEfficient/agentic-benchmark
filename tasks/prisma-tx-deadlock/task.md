# Charges fail and double-charge under concurrent load

You are working in the **checkout-service** (see `README.md`): an Express + Prisma
(SQLite) API that captures payment for an order and records the money movement in
an append-only ledger. The core flow is `POST /orders/:id/charge`, implemented in
`src/services/orderService.mjs`, which calls the external payment processor
(`src/paymentClient.mjs`, simulated locally) and writes the order state + ledger
entry.

Run it: `npm install` (its `postinstall` generates the Prisma client, applies the
migration, and seeds pending orders), then `npm start` (serves on
http://localhost:3000).

## The problem

Under normal one-at-a-time use the service works. But in production, traffic
arrives concurrently, and under load it misbehaves. Reproduce it with the
included load harness, which fires many charge requests simultaneously and prints
a success/failure breakdown:

```bash
npm run load-test              # 30 concurrent charges by default
CONCURRENCY=40 npm run load-test
```

You will see a mix of failures and/or the books going wrong — some charges error
out under contention, and an order can end up charged more than once (a duplicate
ledger entry / the card hit twice), which for a payments system is a correctness
and money-safety bug, not just a performance nit.

## Requirement

Diagnose why the charge path breaks under concurrency and fix it so that:

- Running the load harness at meaningful concurrency (e.g. `CONCURRENCY=40`)
  reports **all charges succeeding**, with **no errors** from lock contention or
  transaction timeouts.
- Each order is charged **at most once** no matter how many concurrent requests
  target it — exactly one `charge` ledger entry per order, and the card is never
  hit twice for the same order.
- The invariant the code documents is preserved: an order's `charged` state and
  its ledger entry are still committed **atomically** (you can never observe one
  without the other), even if the process dies mid-charge.

Keep the change idiomatic and consistent with the existing code. Explain the root
cause and why your fix resolves it.
