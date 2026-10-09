# ADR-0001 — Stack: TypeScript modular monolith, SQLite (node:sqlite), React PWA

- **Status:** accepted
- **Problem:** a single-owner, offline-capable, source-grounded study platform needs a relational source of truth
  (identities, versions, provenance graph), durable background processing (PDF/OCR), keyword+semantic search,
  local-first writing, and must be simple to run, back up and restore.
- **Options considered:**
  1. Postgres + Redis/BullMQ + object storage + microservices — operationally heavy for one user.
  2. Firebase/Supabase-style BaaS — external dependency for private files; harder to keep data local; vendor auth.
  3. **Modular monolith: Fastify + SQLite (WAL, FTS5) + local private file store + in-process durable job queue;
     React/Vite PWA with IndexedDB outbox.**
- **Choice:** option 3. `node:sqlite` (built into Node ≥ 22.13) avoids native builds; FTS5 is available (verified,
  SQLite 3.50). Jobs live in the same DB (transactional with their outputs). Backups are `VACUUM INTO` + file store copy.
- **Cost / constraints:** `node:sqlite` is flagged experimental in Node 22 (API stable enough; we wrap it in `db/db.ts`
  so swapping to `better-sqlite3` is a one-file change). Single process: heavy OCR runs in the job worker with bounded
  concurrency. Horizontal scaling is a non-goal (single owner). Semantic search requires an embeddings provider;
  without one, search is keyword + synonym expansion and says so.
