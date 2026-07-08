import { prisma } from "../lib/prisma.mjs";

/**
 * Record a payment-provider webhook delivery in the ledger.
 *
 * @param {{ eventId: string, type: string, amount: number, currency?: string }} payload
 * @returns {Promise<object>}
 */
export async function applyPaymentEvent(payload) {
  const { eventId, type, amount, currency = "usd" } = payload;

  // TODO: verify signature / timestamp before applying.
  // TODO: make eventId idempotent so provider retries don't double-apply.

  const event = await prisma.paymentEvent.create({
    data: {
      eventId,
      type,
      amount,
      currency,
    },
  });

  console.log(`applied payment event eventId=${eventId} id=${event.id}`);
  return event;
}

/**
 * List recorded payment events (newest first).
 */
export async function listPaymentEvents() {
  return prisma.paymentEvent.findMany({
    orderBy: { createdAt: "desc" },
  });
}
