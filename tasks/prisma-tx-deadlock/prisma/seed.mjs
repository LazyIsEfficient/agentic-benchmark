import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Seed a batch of fixed, pending orders so the service has something to charge
// out of the box (e.g. `curl -XPOST localhost:3000/orders/seed-order-0001/charge`).
// Idempotent: re-running upserts the same IDs back to a pending state.
const SEED_ORDER_COUNT = 50;

async function main() {
  for (let i = 1; i <= SEED_ORDER_COUNT; i++) {
    const id = `seed-order-${String(i).padStart(4, "0")}`;
    await prisma.order.upsert({
      where: { id },
      update: { status: "pending" },
      create: { id, status: "pending", amount: 1000 + i, currency: "usd" },
    });
  }
  console.log(`seeded ${SEED_ORDER_COUNT} pending orders`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
