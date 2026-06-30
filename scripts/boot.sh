#!/usr/bin/env bash
set -euo pipefail
echo "→ docker compose up"
docker compose -f docker/docker-compose.yml up -d
echo "→ wait for postgres"
until docker compose -f docker/docker-compose.yml exec -T postgres pg_isready -U nexora >/dev/null 2>&1; do sleep 1; done
echo "→ prisma generate + migrate"
npx prisma generate
npx prisma migrate dev --name init
echo "→ seed"
npm run seed
echo "→ start dev server"
npm run dev
