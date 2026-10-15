# Bookmark Finder — project status

Read this file, README.md, AGENTS.md and docs/VALIDATION.md when starting a new project chat. The canonical working directory is this repository root. Keep durable decisions here; never record credentials or local filesystem paths in tracked documentation.

## Current stage

Local backend MVP implemented: user-scoped SQLite storage, read-only GitHub stars/X bookmarks ingestion, lexical BM25 search, optional embedding/cosine/RRF retrieval, official TypeSafe Jev reranking, orchestrator with three runtime workers, job queue/traces, CLI and loopback HTTP API.

No web frontend, OAuth connection/refresh UI, scheduled sync, multiuser server authentication, or linked-page/thread ingestion yet. Real-provider access, multilingual relevance, latency and cost have not been validated.

## Development decisions

- Node.js >=24; ES modules and built-in dependencies only.
- `.env` stores local provider settings; never commit it. `.env.example` contains names and empty placeholders.
- `.venv` runs only the Python source-packaging helper; it is not the backend runtime.
- Every new development subagent uses `gpt-6.1-sol` with `high` effort explicitly. Project model defaults and four role definitions live in `.codex/`.
- Runtime relevance evaluation remains Jev; embeddings use a separately configured provider/model.
- All data is user-scoped. Incomplete provider sync retains prior entries. Confidence is separate from relevance. Demo mode is isolated and never calls external services.

## Verified

65/65 tests passed, including real local HTTP and SQLite with mocked external providers. `npm run check`, `npm run demo`, repeatable setup, private environment-file creation, virtualenv reconstruction, SQLite backup integrity, and source-package exclusions were verified. See docs/VALIDATION.md for details and limitations.

## Next steps

1. Select a license for the public repository; no license has been applied without a decision.
2. Configure local GitHub read token, Jev key and embedding provider endpoint/model/key. No credentials in chats or Git history. X can follow as a second stage.
3. Validate real read-only import, indexing and reranking.
4. Evaluate Recall@5/MRR, Jev on/off, p50/p95 latency and provider cost against 20–50 real known-item queries.
5. Add frontend/OAuth and production authentication as separately scoped milestones.

Public repository: https://github.com/ismailucrn/bookmarkfinder

The initial local Git snapshot records the backend foundation. Product name: Bookmark Finder. Repository visibility: public. Local `main` tracks `origin/main` after the initial push. License selection remains pending.
