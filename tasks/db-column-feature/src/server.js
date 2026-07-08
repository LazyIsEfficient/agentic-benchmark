import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

app.use(express.json());
app.use(express.static(publicDir));

// List tickets, newest first.
app.get("/api/tickets", async (_req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(tickets);
  } catch (error) {
    console.error("Failed to list tickets:", error);
    res.status(500).json({ error: "Failed to list tickets" });
  }
});

// Create a ticket. Every field is validated server-side before it touches the
// database; the client is never trusted to send well-formed input.
app.post("/api/tickets", async (req, res) => {
  const { title, description } = req.body ?? {};

  const errors = [];
  if (typeof title !== "string" || title.trim() === "") {
    errors.push("title is required");
  }
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("description is required");
  }
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const ticket = await prisma.ticket.create({
      data: {
        title: title.trim(),
        description: description.trim(),
      },
    });
    res.status(201).json(ticket);
  } catch (error) {
    console.error("Failed to create ticket:", error);
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`Ticket tracker listening on http://localhost:${port}`);
});
