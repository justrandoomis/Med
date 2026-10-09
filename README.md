# MedLevo AI 🩺

منصة دراسة طبية شخصية لمستخدم واحد: **Book First · Source First · Arabic First**.
A personal, source-grounded, book-first, Arabic-first medical study platform (single owner).

- Product spec (Arabic): [`docs/spec/MedLevo_AI_Master_Prompt_AR.txt`](docs/spec/MedLevo_AI_Master_Prompt_AR.txt)
- Architecture & engineering contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Decisions: [`docs/adr/`](docs/adr)

## Quick start

```bash
npm install
cp .env.example .env          # optional: set ANTHROPIC_API_KEY on the server to enable AI features
npm run dev                   # API on :8787, web on :5173
```

Requirements: Node.js ≥ 22.13, `poppler-utils` (pdftoppm) for page rasterization/OCR, optional LibreOffice for DOC/PPT conversion.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + web dev servers |
| `npm test` | unit & integration tests (all workspaces) |
| `npm run typecheck` | TypeScript checks |
| `npm run e2e` | Playwright end-to-end tests |
| `npm run backup` / `npm run restore:verify` | create a backup / verify it restores into a separate directory |
