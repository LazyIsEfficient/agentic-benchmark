# Add a priority to tickets

You are working in the **Ticket Tracker** app (see `README.md`): an Express +
Prisma (SQLite) JSON API with a vanilla HTML/JavaScript frontend in `public/`,
served as static files by Express. Today a ticket has a title, a description, and
a created-at timestamp.

To run it locally: `npm install`, then `npm run setup` (generates the Prisma
client, applies the existing migration, and seeds a few sample tickets), then
`npm start` — the app serves on http://localhost:3000.

## Requirement

Add a **priority** to tickets and thread it through the whole stack. A ticket's
priority is one of `Low`, `Medium`, or `High`.

- **Data model & migration:** add the `priority` field to the `Ticket` model in
  `prisma/schema.prisma` and add a new migration for it under
  `prisma/migrations/`. Existing tickets should default to `Medium`.
- **API:** accept `priority` in the body of `POST /api/tickets` and include it in
  the objects returned by `GET /api/tickets`. A create whose priority is not one
  of the three allowed values must be rejected the same way the other fields are
  validated (respond `400` with an error).
- **Frontend (`public/`):** add a priority control to the "New ticket" form so a
  user can choose the priority when filing a ticket, and show the priority as a
  new column in the tickets table.

Keep it consistent with how the existing fields are modeled, validated, and
rendered. Keep it idiomatic.
