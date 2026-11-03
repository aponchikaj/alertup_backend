# 🧭 AlertUp — Backend

REST + realtime API for AlertUp: indoor wayfinding with an emergency evacuation layer. It serves building maps and their node/edge graph, multi-floor routing (profiles, closures, turn-by-turn in English and Georgian), QR scan resolution, team roles and invitations, live emergency broadcast over SSE, collaborative map editing over Socket.io, and the AI concierge.

> ✍️ Built at **age 15** (2025-2026)

---

## Stack

| | |
|---|---|
| Runtime | Node.js 26 LTS (`.nvmrc`, `engines`) |
| Framework | Express 5, ESM |
| Database | PostgreSQL via Prisma 6 (Supabase in hosted environments) |
| Realtime | Server-Sent Events (emergency status) + Socket.io (map editor) |
| Storage | Cloudflare R2 (S3 API), served at `assets.alertup.world` |
| Email | Resend |
| AI | Gemini (primary) with Groq fallback |
| Tests | Jest + Supertest against a local Postgres |

## Run locally

```bash
nvm use                      # Node 26
npm ci
cp .env.example .env         # fill in values; see the comments in the file
npm run dev                  # http://localhost:3001  (GET /health)
```

Tests need a local Postgres. Set `TEST_DATABASE_URL` to it (it must be `localhost`):

```bash
npm test                     # use npm test, not bare `npx jest`
```

## Database

| Command | What it does |
|---|---|
| `npm run db:migrate -- --name <change>` | Create + apply a migration on a **local** Postgres only (`LOCAL_DATABASE_URL`, else `TEST_DATABASE_URL`) |
| `npm run db:deploy` | Apply committed migrations to `DATABASE_URL` (shared databases) |
| `npm run db:status` | Show pending migrations |
| `npm run db:backup` | `pg_dump` of `DATABASE_URL` into `backups/` (take one before deploying a migration) |
| `npm run db:studio` | Prisma Studio |

## Layout

```
server.js            middleware, CORS, route mounts, socket + job boot
prisma/              schema.prisma + migrations/
src/routes/          thin HTTP endpoints (auth, buildings, admin, qr, …)
src/features/        domain slices with their own logic and tests
                     (wayfinding, emergency, realtime, collab, mapEditor, ai, qr)
src/services/        storage, email, rate limiting, archive, …
src/jobs/sweeper.js  retention sweeps
src/tests/           integration tests
```

The full API inventory, data model and known issues are in the workspace `docs/` folder (`docs/analysis/BACKEND.md`, `DATABASE.md`, `docs/FIXES.md`).

## Related

Frontend: [alertup_front](https://github.com/aponchikaj/alertup_front)

---

> 🇬🇪 Built in Tbilisi, Georgia by [Lazare Mirziashvili](https://github.com/aponchikaj)
