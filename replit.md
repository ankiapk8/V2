# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: OpenAI via Replit AI Integrations (`@workspace/integrations-openai-ai-server`)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Artifacts

### Anki Card Generator (`artifacts/anki-generator`)
- React + Vite web app at `/`
- Upload files (PDF, TXT) or paste text to generate Anki flashcards via AI
- Browse and manage decks, edit cards inline, export to CSV for Anki import
- PDF extraction is handled in `src/lib/pdf-extraction.ts` using PDF.js embedded text first, then OCR fallback for scanned PDFs
- Safari/iPad compatibility uses a `Promise.withResolvers` polyfill in `src/main.tsx` before loading the app and the legacy PDF.js build

### API Server (`artifacts/api-server`)
- Express 5 backend at `/api`
- Routes: `/api/decks`, `/api/cards`, `/api/generate`, `/api/healthz`
- AI generation uses `gpt-5.2` model via Replit AI Integrations
- The AI client is loaded lazily so missing AI configuration returns a 503 from `/api/generate` instead of crashing the server

## Database Schema

- `decks` — Deck metadata (id, name, description, parentId FK self-ref, timestamps)
  - `parentId` is nullable; if set, the deck is a sub-deck of the referenced deck
- `cards` — Flashcard data (id, deckId, front, back, tags, timestamps)

## Deck Hierarchy

- Decks can have a `parentId` pointing to another deck (one level deep)
- Library shows parent decks as main topics with expandable sub-decks nested below
- "New Deck" and Generate flows have a Main Topic selector to assign `parentId`
- Export uses Anki's `::` convention: sub-deck cards are tagged `Parent::Child`
- Deleting a parent nullifies `parentId` on children (they become standalone)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
