# NEXORA AI — Backend

Kenya-first business operating system backend. Fastify + Prisma + Postgres + Redis + JWT.
Powers POS, inventory, CRM, accounting, payroll, HR, AI assistant, and chama / group-money for the [NEXORA AI](https://github.com/Daviegaza/nexora-frontend) workspace.

## Stack

| Layer | Tech |
|------|------|
| HTTP | Fastify 5 (+ Zod type provider, Swagger UI, helmet, CORS, rate-limit, cookie, JWT) |
| ORM | Prisma 6 |
| Database | Postgres 16 (16+ supported) |
| Queue / cache | Redis 8 + BullMQ |
| Auth | Argon2id passwords, JWT access (15 min), refresh in HttpOnly cookie (30 d) |
| Validation | Zod 3 |
| Logging | Pino + pino-pretty |
| Dev | tsx watch, oxlint, prettier, vitest |

## Quick start

```bash
cp .env.example .env
# generate strong JWT secrets:
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 48)|" .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 48)|" .env

npm install --legacy-peer-deps
docker compose -f docker/docker-compose.yml up -d   # Postgres + Redis
npx prisma generate
npx prisma db push        # or: npx prisma migrate dev --name init
npm run seed              # owner@nexora.co.ke / demo1234
npm run dev               # http://localhost:4040 · docs at /docs
```

## API surface

| Module | Routes |
|--------|--------|
| `/api/auth` | `POST /register`, `POST /login`, `POST /refresh`, `POST /logout`, `GET /me` |
| `/api/users` | `GET /`, `POST /invite`, `PATCH /:id/grant` (per-user capability delegation), `PATCH /:id/role`, `PATCH /:id/deactivate` |
| `/api/products` | full CRUD + `GET /barcode/:code` |
| `/api/transactions` | `GET /`, `POST /` (decrements stock + fires KRA eTIMS filing) |
| `/api/etims` | `POST /file/:txnId`, `POST /cancel/:invoiceNo` |
| `/api/mpesa` | `POST /stk` (Daraja STK Push), `POST /callback` (Safaricom webhook) |
| `/api/ai` | `POST /chat` (Anthropic Claude Haiku 4.5), `POST /chat/stream` (SSE) |
| `/api/chama` | (stubbed) group savings, contributions, rota, loans |

Interactive docs: `http://localhost:4040/docs`.

## Auth + RBAC

- Argon2id password hashing
- JWT access (15 min) signed HS256; refresh token (30 d) hashed SHA-256, stored in DB, delivered as HttpOnly cookie on `/api/auth`
- Multi-tenant: every domain row scoped to `workspaceId`. Resolved from JWT `ws` claim on every request
- 13 roles: `super_admin`, `admin`, `owner`, `director`, `branch_manager`, `supervisor`, `accountant`, `inventory_manager`, `hr_manager`, `sales_agent`, `cashier`, `employee`, plus user-defined `CustomRole`
- 60+ explicit capabilities (`pos.refund`, `users.invite`, `etims.file`, ...). Owner can grant any capability to any user via `PATCH /api/users/:id/grant` without changing their role
- Effective set = `ROLE_CAPS[role]` + `permissionsAdd` − `permissionsRemove`
- Route protection via `requireCap('cap.name')` Fastify preHandler

## Kenya integrations

- **KRA eTIMS OSCU** — `src/modules/etims/service.ts` files invoices to `https://etims-api-sbx.kra.go.ke/oscu/v1/invoice` and stores `rcptNo` / `qrCode` / `sdcId` on the transaction
- **M-Pesa Daraja** — `src/modules/mpesa/service.ts` STK Push (sandbox + production base URLs), OAuth-token + password timestamp generator; callback handler at `POST /api/mpesa/callback`
- **Chama / group money** — Prisma models for `ChamaGroup`, `ChamaMember`, `ChamaContribution`, `ChamaLoan`, `ChamaRotaSlot`

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | tsx watch with hot reload |
| `npm run build` | `tsc -p tsconfig.json` → `dist/` |
| `npm start` | run compiled `dist/server.js` |
| `npm run lint` | oxlint |
| `npm test` | vitest run |
| `npm run prisma:generate` | regenerate Prisma client |
| `npm run prisma:migrate` | dev migrate |
| `npm run prisma:deploy` | prod migrate |
| `npm run prisma:studio` | DB GUI on :5555 |
| `npm run seed` | seed demo workspace + owner |
| `npm run docker:up` / `:down` | Postgres + Redis |
| `./scripts/boot.sh` | one-shot: docker → migrate → seed → dev |

## Environment

See `.env.example` for the full list. Critical:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Generate via `openssl rand -hex 48` |
| `CORS_ORIGIN` | Comma-separated list of allowed frontends |
| `KRA_ETIMS_*` | KRA OSCU enrollment credentials |
| `MPESA_*` | Daraja consumer key/secret/passkey + shortcode |
| `AI_API_KEY` / `AI_MODEL` | Anthropic key + model id (default `claude-haiku-4-5-20251001`) |

**Never** set `VITE_`-prefixed secrets — those would leak into the frontend bundle.

## Docker

```bash
docker compose -f docker/docker-compose.yml up -d
# Postgres on :55432 (avoids host conflict with default :5432)
# Redis on :6380
```

Production build: `docker build -t nexora-backend .` → 24-alpine multi-stage image.

## License

MIT © Nexora Enterprises Ltd
