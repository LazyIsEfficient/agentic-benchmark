import express from "express";
import { ordersRouter } from "./routes/orders.mjs";

/** Build the Express app (no listen) so tests and scripts can mount it too. */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/orders", ordersRouter);

  return app;
}
