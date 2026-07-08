import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const tickets = [
  {
    title: "Login page returns 500 on submit",
    description: "Users report an internal server error when signing in with a valid password.",
  },
  {
    title: "Add CSV export to the reports view",
    description: "Finance wants to download the monthly reports table as a CSV file.",
  },
  {
    title: "Dark mode toggle does not persist",
    description: "The preference resets to light mode after a full page reload.",
  },
];

async function main() {
  const existing = await prisma.ticket.count();
  if (existing > 0) {
    console.log(`Database already has ${existing} ticket(s); skipping seed.`);
    return;
  }

  for (const ticket of tickets) {
    await prisma.ticket.create({ data: ticket });
  }
  console.log(`Seeded ${tickets.length} tickets.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
