import { prisma } from "../lib/prisma.mjs";
import { chargeCard } from "../paymentClient.mjs";

/**
 * Capture payment for an order and record it in the ledger.
 *
 * The state transition and the ledger write are wrapped in a single interactive
 * transaction so the two always commit together: we can never end up with an
 * order marked `charged` that has no ledger row, or a ledger row for an order
 * that was never moved out of `pending`. That atomicity is what keeps the books
 * and the order state consistent even if the process dies mid-charge.
 *
 * @param {string} orderId
 * @returns {Promise<{ orderId: string, status: string, receiptId: string, ledgerId: string }>}
 */
export async function chargeOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    // Claim the order for processing. Flipping the status up front also acts as
    // a guard against a concurrent duplicate request double-charging the card.
    const order = await tx.order.update({
      where: { id: orderId },
      data: { status: "processing" },
    });

    // Hand the card to the processor. This is where the money actually moves.
    const receipt = await chargeCard({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });

    // Persist the outcome + the ledger entry as part of the same atomic unit.
    await tx.order.update({
      where: { id: orderId },
      data: { status: "charged" },
    });

    const entry = await tx.ledgerEntry.create({
      data: {
        orderId: order.id,
        type: "charge",
        amount: order.amount,
      },
    });

    return {
      orderId: order.id,
      status: "charged",
      receiptId: receipt.id,
      ledgerId: entry.id,
    };
  });
}
