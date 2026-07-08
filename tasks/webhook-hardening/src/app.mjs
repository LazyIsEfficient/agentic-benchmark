import express from "express";
import { webhooksRouter } from "./routes/webhooks.mjs";
import { listPaymentEvents } from "./services/webhookService.mjs";

/** Build the Express app (no listen) so tests and scripts can mount it too. */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/events", async (_req, res) => {
    try {
      const events = await listPaymentEvents();
      res.status(200).json(events);
    } catch (err) {
      res.status(500).json({
        error: err.message,
        code: err.code,
        name: err.name,
      });
    }
  });

  app.use("/webhooks", webhooksRouter);

  return app;
}
