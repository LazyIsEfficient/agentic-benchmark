import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// One shared Prisma client for the whole process.
export const prisma = new PrismaClient({
  log: ["warn", "error"],
});
