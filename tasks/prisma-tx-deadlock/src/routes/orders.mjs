import { Router } from "express";
import { chargeOrder } from "../services/orderService.mjs";

export const ordersRouter = Router();

// POST /orders/:id/charge — capture payment for an order.
ordersRouter.post("/:id/charge", async (req, res) => {
  try {
    const result = await chargeOrder(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    // Surface the underlying driver/Prisma error so operators can see what the
    // database actually reported (error code included where available).
    res.status(500).json({
      error: err.message,
      code: err.code,
      name: err.name,
    });
  }
});
