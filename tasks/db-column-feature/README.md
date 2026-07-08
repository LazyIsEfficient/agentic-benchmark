# Ticket Tracker

A small support-ticket tracker. An Express + Prisma (SQLite) JSON API backs a
plain HTML/JavaScript frontend that Express serves as static files — no build
step, no framework.

## Stack

- **Backend:** Express, Prisma ORM, SQLite
- **Frontend:** vanilla HTML + CSS + JavaScript (`public/`), served statically by
  Express

## Getting started

Requires Node 18+.

```bash
npm install        # installs deps and runs `prisma generate` (postinstall)
npm run setup      # applies migrations and seeds a few sample tickets
npm start          # serves the app on http://localhost:3000
```

Then open http://localhost:3000. The SQLite database (`prisma/dev.db`) is created
by `npm run setup` and is intentionally not committed.

## Data model

A single `Ticket` model (see [`prisma/schema.prisma`](prisma/schema.prisma)):

| Field         | Type       | Notes                          |
| ------------- | ---------- | ------------------------------ |
| `id`          | `Int`      | primary key, auto-increment    |
| `title`       | `String`   | required                       |
| `description` | `String`   | required                       |
| `createdAt`   | `DateTime` | set automatically on create    |

## API

| Method | Path           | Body                      | Response                     |
| ------ | -------------- | ------------------------- | ---------------------------- |
| `GET`  | `/api/tickets` | —                         | `200` array of tickets       |
| `POST` | `/api/tickets` | `{ title, description }`  | `201` ticket / `400` errors  |

`POST /api/tickets` validates every field server-side and returns
`400 { errors: [...] }` when the payload is invalid.

## Project layout

```
prisma/
  schema.prisma          Prisma model + SQLite datasource
  migrations/            committed migration history
  seed.js                inserts sample tickets
public/
  index.html             frontend markup (create form + tickets table)
  app.js                 fetches the API and renders the table
  styles.css             styling
src/
  server.js              Express app: static frontend + REST API
```
