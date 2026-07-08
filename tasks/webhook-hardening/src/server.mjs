import "dotenv/config";
import { createApp } from "./app.mjs";

const PORT = Number(process.env.PORT ?? 3000);

const app = createApp();
app.listen(PORT, () => {
  console.log(`webhook-ingress listening on http://localhost:${PORT}`);
});
