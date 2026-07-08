import { Router } from "express";
import { applyPaymentEvent } from "../services/webhookService.mjs";

export const webhooksRouter = Router();

// POST /webhooks/payments — ingest a payment-provider webhook delivery.
webhooksRouter.post("/payments", async (req, res) => {
  try {
    const { eventId, type, amount, currency } = req.body ?? {};

    if (!eventId || !type || typeof amount !== "number") {
      return res.status(400).json({
        error: "expected body: { eventId, type, amount, currency? }",
      });
    }

    const event = await applyPaymentEvent({ eventId, type, amount, currency });
    res.status(200).json(event);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: err.code,
      name: err.name,
    });
  }
});
