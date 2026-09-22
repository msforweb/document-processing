# LedgerFlow Document Processing

LedgerFlow is a production-oriented monorepo foundation for fintech document intake, extraction, validation, and human review.

## Phase 1 status

This phase includes:

- npm workspaces for the API, web app, and shared packages
- NestJS API with `/api/health` and JWT login at `/api/auth/login`
- React + Vite operations shell
- Prisma schema for organizations and users
- PostgreSQL and Redis Docker services
- strict TypeScript, validation pipes, and workspace build scripts
- seeded demo organization and admin user

## Requirements

- Node.js 22+
- npm 10+
- Docker with Compose

## Setup

```bash
cp .env.example .env
npm install
docker compose up -d
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

The API runs at `http://localhost:3001` and the web app runs at `http://localhost:5173`.

Demo login credentials:

```text
Email: admin@example.com
Password: demo-password
```

## Validation

```bash
npm run build
npm run lint
npm run test
```

## Workspace layout

- `apps/api`: NestJS REST API and future processing workers
- `apps/web`: React operations console
- `packages/shared`: shared contracts and domain types
- `packages/config`: shared environment configuration
- `prisma`: schema and seed data

## Next phase

Phase 2 will add organizations, roles, document records, secure local storage, and multipart upload APIs.
