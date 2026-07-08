# Harden payment webhook ingestion

You are working in the **webhook-ingress** service (see `README.md`): an
Express + Prisma (SQLite) API that receives payment-provider webhooks at
`POST /webhooks/payments` and records them as ledger events.

Today the endpoint is not safe to expose. It accepts any JSON body, applies
side effects immediately, and will double-apply the same delivery if the
provider retries.

## Requirement

Make `POST /webhooks/payments` safe for an untrusted network caller:

- Verify the request using the shared secret in `WEBHOOK_SECRET` and the
  `X-Webhook-Signature` / `X-Webhook-Timestamp` headers (see README for the
  signing scheme). Reject unauthenticated or tampered requests.
- Reject deliveries whose timestamp is outside the allowed skew window
  documented in the README (replay protection).
- Apply each provider event **at most once**. Retries with the same event id
  must not create a second ledger row or re-run side effects; they should
  acknowledge success without duplicating work.
- Preserve fail-closed behavior: when verification cannot be completed
  confidently, do not apply the event.

Keep the change idiomatic and consistent with the existing code. Update the
README where the public contract changes.
