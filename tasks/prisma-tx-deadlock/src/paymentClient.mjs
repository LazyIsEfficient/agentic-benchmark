// Client for the external payment processor (think Stripe / Adyen / Braintree).
//
// In this sandbox the network round-trip is SIMULATED with a delay so the
// service runs fully offline. In production `chargeCard` performs a real HTTPS
// request to the processor's card-capture endpoint; that call typically takes
// one to a few seconds and is the slowest hop in the checkout path.

const PROCESSOR_LATENCY_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture a charge against the customer's card via the external processor.
 * Resolves with the processor's receipt. Network + processor latency lives
 * entirely inside this call.
 *
 * @param {{ orderId: string, amount: number, currency: string }} params
 */
export async function chargeCard({ orderId, amount, currency }) {
  // --- external HTTPS round-trip to the payment processor (simulated) ---
  await sleep(PROCESSOR_LATENCY_MS);

  return {
    id: `ch_${orderId.slice(0, 8)}_${Date.now().toString(36)}`,
    amount,
    currency,
    status: "succeeded",
  };
}
