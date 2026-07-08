import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// One shared Prisma client for the whole process. Reusing a single client keeps
// the connection pool warm and bounded — spinning up a client per request would
// exhaust connections under load. The pool + transaction settings below were
// tuned during last quarter's checkout hardening to keep capture reliable when
// traffic spikes.
export const prisma = new PrismaClient({
  log: ["warn", "error"],
  transactionOptions: {
    // Head-room for the interactive transaction to finish end-to-end, and for a
    // request to wait its turn for a pooled connection before giving up.
    timeout: 10_000,
    maxWait: 4_000,
  },
});
