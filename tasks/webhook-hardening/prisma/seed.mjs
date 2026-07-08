import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One prior event so operators can see what a recorded delivery looks like.
// Not keyed uniquely on eventId — the schema allows duplicates today.
async function main() {
  const existing = await prisma.paymentEvent.findFirst({
    where: { eventId: "evt_seed_prior" },
  });
  if (!existing) {
    await prisma.paymentEvent.create({
      data: {
        eventId: "evt_seed_prior",
        type: "payment.succeeded",
        amount: 1000,
        currency: "usd",
      },
    });
  }
  console.log("seeded prior payment event evt_seed_prior");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
