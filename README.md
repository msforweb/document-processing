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

## OCR and operational review enhancements

The local OCR fallback supports Tesseract. For scanned PDFs, install Poppler (`pdftoppm`) to render pages before OCR. Image cleanup is optional and uses ImageMagick (`magick` or `convert`) when available. OCR compares a balanced grayscale/deskew pass, an adaptive local-threshold pass for uneven lighting, and the original image across several Tesseract page layouts, then selects the result using document-text structure signals. The API gracefully falls back to the original image when preprocessing tools are missing. Toggle the adaptive pass with `OCR_ADAPTIVE_THRESHOLD_ENABLED`. Configure binary paths, OCR languages, PDF resolution/page limits, and preprocessing in `.env` using the `TESSERACT_*`, `PDFTOPPM_PATH`, and `OCR_*` settings.

Reviewer assignments, escalation notifications, and vendor risk profiles are persisted in PostgreSQL. After starting PostgreSQL, apply the migrations with:

```bash
npm run db:migrate
```

The operations console refreshes vendor risk profiles when its data refreshes. SLA escalation evaluation runs in the API on a five-minute interval by default and also remains available from the dashboard. Configure `ESCALATION_EVALUATION_ENABLED` and `ESCALATION_EVALUATION_INTERVAL_MS` in `.env` to control the scheduler. Notifications are in-app alerts for organization administrators and each document's assigned reviewer. Optional email delivery uses Resend when `RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM` are configured; delivery failures are logged without interrupting review workflows.

Invoice fraud assessments are stored per document and include weighted, explainable signals for duplicate invoice numbers within a vendor, matching invoice numbers and amounts across different vendors, vendor amount outliers, submission bursts, new high-value vendors, round high-value amounts, and date inconsistencies. Processing an invoice updates its assessment; `POST /api/documents/fraud-assessments/recalculate` reevaluates the organization's invoices. Document detail includes the current score and signal explanations. These are review signals, not determinations of fraud.


Document processing runs through BullMQ on Redis. `POST /api/documents/:id/process` returns an accepted job record; poll `GET /api/documents/:id/status` for persisted stage/progress and completion. Set `DOCUMENT_PROCESSING_CONCURRENCY` to tune worker concurrency. The API requires Redis to be available at startup.

Classification and extraction are organized behind a `DocumentAiProvider` interface. The current `local-regex-v1` provider handles invoice, bank statement, KYC, and compliance report fields without an external AI key. Normalized field values, confidence, source, and classification are stored per document; required fields below `FIELD_REVIEW_CONFIDENCE` route to manual review.
